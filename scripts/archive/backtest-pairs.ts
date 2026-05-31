/**
 * TWO-LEG matched-pair backtest — the decisive Phase-0 measurement.
 *
 * The live delta-neutral maker's viability as a rebate farm hinges on ONE number
 * the single-token simulator CANNOT measure: the real MATCHED-PAIR COST
 * (avgBuyYes + avgBuyNo). If it is reliably < $1 the matched core is locked +EV
 * (pays $1 at settlement); if it is ≈ $1 the maker is breakeven and only the
 * rebate is left. The only live read was n=14 paired windows (cost 0.8929) —
 * variance-dominated. This pairs the YES and NO legs of each market (by
 * conditionId) from the dual-leg tape and runs the SAME validated BUY+hold fill
 * model (queue + participation, from simulate.ts) on each leg, then decomposes:
 *
 *   - matched-pair cost distribution over HUNDREDS of windows (mean/median, <1 vs >1)
 *   - matched (hedged, ~0 variance) vs naked (the ±100% lottery) share split
 *   - matched-pair PnL (locked) vs naked PnL (is the naked tail fair ~0 or adverse?)
 *   - trading PnL per window (mean ± σ_w) + modeled rebate → net as % of notional
 *   - the r% vs |t%| rebate-farming verdict
 *
 * Delta-neutral = buy maker on BOTH legs + hold to 0/1 (no SELL/flatten), exactly
 * the fixed bot's dominant behavior. No capital; reads recorded tape only.
 *
 *   npm run tsnode -- scripts/backtest-pairs.ts                       # newest tape, sweep
 *   npm run tsnode -- scripts/backtest-pairs.ts data/tape-2026-05-29.jsonl --assets BNB,DOGE
 *   npm run tsnode -- scripts/backtest-pairs.ts --spread 0.03
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBotYaml, type MakerConfig } from '../../src/util/config.js';
import { computeQuotes } from '../../src/engine/quoter.js';
import { emptyInventory, applyFill, type InventoryState } from '../../src/engine/inventory.js';

interface Ev {
  t: 'book' | 'trade';
  ts: number;
  bid?: number | null; ask?: number | null; bidSz?: number | null; askSz?: number | null;
  price?: number; size?: number;
  btcR30?: number | null;
}
interface Leg {
  tokenId: string;
  side: 'YES' | 'NO';
  events: Ev[];
  won?: boolean;          // did THIS token settle to $1
}
interface Pair {
  conditionId: string;
  asset: string;
  resolvesAt: number;
  feeRate: number;
  rebateRate: number;
  yesWon?: boolean;
  yes?: Leg;
  no?: Leg;
}

const DEFAULT_FEE_RATE = 0.07;
const DEFAULT_REBATE_RATE = 0.2;
// Empirical rebate rate measured on-chain (Phase 0): MAKER_REBATE / maker
// notional ≈ 0.61% over 05-26..28. Used for the headline verdict alongside the
// per-fill modeled rebate (which the tape's fee formula also produces).
const EMPIRICAL_REBATE_PCT = 0.0061;

function allTapes(): string[] {
  const dir = resolve('data');
  const files = readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error('No tape-*.jsonl in data/. Run `npm run record` first.');
  return files.map((f) => resolve(dir, f));
}

function takerFee(price: number, shares: number, feeRate: number): number {
  return shares * feeRate * price * (1 - price);
}

/** Ingest dual-leg tape into market pairs keyed by conditionId. Legacy tapes
 *  without conditionId/side are skipped (this backtest REQUIRES dual-leg data). */
function loadPairs(paths: string[]): Pair[] {
  const byCondition = new Map<string, Pair>();
  const tokenToLeg = new Map<string, { pair: Pair; leg: Leg }>();

  for (const path of paths) {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let e: any; try { e = JSON.parse(s); } catch { continue; }

      if (e.t === 'market') {
        if (!e.conditionId || !e.side) continue; // legacy single-leg tape
        let pair = byCondition.get(e.conditionId);
        if (!pair) {
          pair = {
            conditionId: e.conditionId, asset: e.asset ?? '?',
            resolvesAt: e.resolvesAt ?? 0,
            feeRate: typeof e.feeRate === 'number' ? e.feeRate : DEFAULT_FEE_RATE,
            rebateRate: typeof e.rebateRate === 'number' ? e.rebateRate : DEFAULT_REBATE_RATE,
          };
          byCondition.set(e.conditionId, pair);
        } else {
          pair.resolvesAt = e.resolvesAt ?? pair.resolvesAt;
          if (typeof e.feeRate === 'number') pair.feeRate = e.feeRate;
          if (typeof e.rebateRate === 'number') pair.rebateRate = e.rebateRate;
        }
        const slot: 'yes' | 'no' = e.side === 'YES' ? 'yes' : 'no';
        if (!pair[slot]) {
          const leg: Leg = { tokenId: e.tokenId, side: e.side, events: [] };
          pair[slot] = leg;
          tokenToLeg.set(e.tokenId, { pair, leg });
        }
        continue;
      }
      if (e.t === 'resolution') {
        const ref = tokenToLeg.get(e.tokenId);
        if (ref) { ref.leg.won = e.won; ref.pair.yesWon = e.yesWon; }
        continue;
      }
      const ref = tokenToLeg.get(e.tokenId);
      if (!ref) continue;
      if (e.t === 'book') ref.leg.events.push({ t: 'book', ts: e.ts, bid: e.bid, ask: e.ask, bidSz: e.bidSz, askSz: e.askSz, btcR30: e.btcR30 });
      else if (e.t === 'trade') ref.leg.events.push({ t: 'trade', ts: e.ts, price: e.price, size: e.size, btcR30: e.btcR30 });
    }
  }
  return [...byCondition.values()].filter((p) => p.resolvesAt > 0);
}

interface LegResult { buyShares: number; buyUsd: number; rebate: number; hadBook: boolean }

/** Run the maker BUY-only + hold fill model on a single leg (mirrors simulate.ts
 *  --hold: quote a maker bid at mid−half_spread, fill when a trade crosses it
 *  net of the queue ahead, never sell, hold to settlement). */
function simulateLegBuys(leg: Leg, pair: Pair, cfg: MakerConfig): LegResult {
  let inv: InventoryState = emptyInventory();
  let lastMid = 0, bestBid = 0, bestAsk = 0, bestBidSz = 0, bestAskSz = 0;
  let bidPrice: number | null = null, bidRemaining = 0;
  let rebate = 0, buyShares = 0, buyUsd = 0, hadBook = false;
  const maxShares = (price: number) => cfg.maxInventoryUsd / price;
  const typeRank = (t: string) => (t === 'trade' ? 0 : 1);
  const events = leg.events.sort((a, b) => a.ts - b.ts || typeRank(a.t) - typeRank(b.t));

  for (const ev of events) {
    const ttr = (pair.resolvesAt - ev.ts) / 1000;
    if (ttr < 0) continue;

    if (ev.t === 'book') {
      const bb = ev.bid ?? 0, ba = ev.ask ?? 0;
      if (bb > 0 && ba > 0 && ba > bb) {
        lastMid = (bb + ba) / 2; bestBid = bb; bestAsk = ba;
        bestBidSz = ev.bidSz ?? 0; bestAskSz = ev.askSz ?? 0; hadBook = true;
      }
      if (lastMid <= 0) continue;
      const decision = computeQuotes(
        { bestBid: bb, bestAsk: ba, inventoryShares: inv.shares, inventoryUsd: inv.shares * lastMid, btcReturn30s: ev.btcR30 ?? null, timeToResolveSec: ttr },
        cfg,
      );
      if (decision.action === 'quote') {
        const newBid = decision.bid?.price ?? null;
        if (newBid === null) { bidPrice = null; bidRemaining = 0; }
        else if (newBid !== bidPrice) { bidPrice = newBid; bidRemaining = decision.bid?.sizeShares ?? 0; }
      } else { bidPrice = null; bidRemaining = 0; }
      continue;
    }

    // trade
    const p = ev.price ?? 0, sz = ev.size ?? 0;
    if (p <= 0 || sz <= 0) continue;
    if (ttr <= cfg.flattenBeforeSec) continue; // bot cancels resting BUYs at the boundary
    if (bidPrice !== null && p <= bidPrice && bidRemaining > 0) {
      const queueAhead = bidPrice > bestBid ? 0 : bestBidSz;
      const reach = Math.max(0, sz - queueAhead) * cfg.fillParticipation;
      const clamp = Math.max(0, maxShares(bidPrice) - inv.shares);
      const fill = Math.min(reach, bidRemaining, clamp);
      if (fill > 0) {
        inv = applyFill(inv, { side: 'BUY', price: bidPrice, shares: fill });
        rebate += pair.rebateRate * takerFee(bidPrice, fill, pair.feeRate);
        bidRemaining -= fill; buyShares += fill; buyUsd += bidPrice * fill;
      }
    }
  }
  return { buyShares, buyUsd, rebate, hadBook };
}

interface PairMetrics {
  pairs: number; bothFilled: number; oneLeg: number; noFill: number;
  pairCosts: number[];                 // avgY+avgN over bothFilled windows
  matchedSharesTot: number; nakedSharesTot: number;
  matchedPnl: number; nakedPnl: number; rebate: number;
  buyUsdTot: number;
  windowPnls: number[];                // trading PnL per pair (hold all to settle, pre-rebate)
}

function backtest(pairs: Pair[], cfg: MakerConfig): PairMetrics {
  const m: PairMetrics = {
    pairs: 0, bothFilled: 0, oneLeg: 0, noFill: 0, pairCosts: [],
    matchedSharesTot: 0, nakedSharesTot: 0, matchedPnl: 0, nakedPnl: 0, rebate: 0,
    buyUsdTot: 0, windowPnls: [],
  };

  for (const pair of pairs) {
    if (!pair.yes || !pair.no || typeof pair.yesWon !== 'boolean') continue;
    const y = simulateLegBuys(pair.yes, pair, cfg);
    const n = simulateLegBuys(pair.no, pair, cfg);
    if (!y.hadBook && !n.hadBook) continue;
    m.pairs++;

    const ySettle = pair.yesWon ? 1 : 0;
    const nSettle = pair.yesWon ? 0 : 1;
    const yTrade = y.buyShares * ySettle - y.buyUsd;   // hold to settlement
    const nTrade = n.buyShares * nSettle - n.buyUsd;
    const tradePnl = yTrade + nTrade;
    m.windowPnls.push(tradePnl);
    m.rebate += y.rebate + n.rebate;
    m.buyUsdTot += y.buyUsd + n.buyUsd;

    const bothFilled = y.buyShares > 0 && n.buyShares > 0;
    if (bothFilled) {
      m.bothFilled++;
      const avgY = y.buyUsd / y.buyShares;
      const avgN = n.buyUsd / n.buyShares;
      const pairCost = avgY + avgN;
      m.pairCosts.push(pairCost);
      const matched = Math.min(y.buyShares, n.buyShares);
      m.matchedSharesTot += 2 * matched;
      m.matchedPnl += matched * (1 - pairCost);        // locked: pays $1, cost pairCost
      // naked excess of whichever leg has more shares, settled at its own outcome
      const nakedSh = Math.abs(y.buyShares - n.buyShares);
      m.nakedSharesTot += nakedSh;
      if (y.buyShares > n.buyShares) m.nakedPnl += nakedSh * ySettle - nakedSh * avgY;
      else m.nakedPnl += nakedSh * nSettle - nakedSh * avgN;
    } else if (y.buyShares > 0 || n.buyShares > 0) {
      m.oneLeg++;
      // entire position is naked
      const naked = y.buyShares > 0 ? y : n;
      const nakedSh = naked.buyShares;
      const settle = y.buyShares > 0 ? ySettle : nSettle;
      const avg = naked.buyUsd / nakedSh;
      m.nakedSharesTot += nakedSh;
      m.nakedPnl += nakedSh * settle - nakedSh * avg;
    } else {
      m.noFill++;
    }
  }
  return m;
}

function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const mu = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1));
}
const usd = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
const p2 = (x: number) => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';

function report(label: string, m: PairMetrics): void {
  const totBuy = m.matchedSharesTot + m.nakedSharesTot;
  const tradeTot = m.windowPnls.reduce((s, x) => s + x, 0);
  const net = tradeTot + m.rebate;
  const muW = mean(m.windowPnls);
  const sdW = std(m.windowPnls);
  const tPct = m.buyUsdTot > 0 ? tradeTot / m.buyUsdTot : 0;
  const rPctModel = m.buyUsdTot > 0 ? m.rebate / m.buyUsdTot : 0;
  const below1 = m.pairCosts.filter((c) => c < 1).length;

  console.log(`\n=== ${label} ===`);
  console.log(`pairs (resolved, had book) : ${m.pairs}`);
  console.log(`  both legs filled : ${m.bothFilled} (${pctOf(m.bothFilled, m.pairs)})   one leg : ${m.oneLeg}   no fill : ${m.noFill}`);
  console.log(`\n── MATCHED-PAIR COST (the decisive number) ──`);
  if (m.pairCosts.length) {
    console.log(`  mean ${mean(m.pairCosts).toFixed(4)}   median ${median(m.pairCosts).toFixed(4)}   (over ${m.pairCosts.length} two-sided windows)`);
    console.log(`  cost < 1 (profitable hedge): ${below1}/${m.pairCosts.length} (${pctOf(below1, m.pairCosts.length)})   cost > 1 (adverse): ${m.pairCosts.length - below1}`);
    console.log(`  → matched-pair PnL (locked): ${usd(m.matchedPnl)}  on ${m.matchedSharesTot.toFixed(0)} hedged shares`);
  } else console.log(`  (no two-sided windows)`);
  console.log(`\n── MATCHED vs NAKED (the variance source) ──`);
  console.log(`  matched(hedged): ${m.matchedSharesTot.toFixed(0)} sh (${pctOf(m.matchedSharesTot, totBuy)})   naked: ${m.nakedSharesTot.toFixed(0)} sh (${pctOf(m.nakedSharesTot, totBuy)})`);
  console.log(`  naked PnL (held to 0/1): ${usd(m.nakedPnl)}   ${Math.abs(m.nakedPnl) < 0.05 * Math.max(1, m.buyUsdTot) ? '≈ fair (~0)' : m.nakedPnl < 0 ? '← ADVERSE (negatively selected)' : '← favorable (sample luck?)'}`);
  console.log(`\n── PnL & REBATE-FARMING VERDICT ──`);
  console.log(`  maker notional (buy $)     : $${m.buyUsdTot.toFixed(0)}`);
  console.log(`  trading PnL (hold to settle): ${usd(tradeTot)}   = matched ${usd(m.matchedPnl)} + naked ${usd(m.nakedPnl)}`);
  console.log(`  per-window trading mean ± σ : ${usd(muW)} ± ${usd(sdW)}`);
  console.log(`  modeled rebate             : ${usd(m.rebate)}  (${p2(rPctModel)} of notional; on-chain empirical ≈ +0.61%)`);
  console.log(`  NET (trading + rebate)     : ${usd(net)}`);
  const tEmp = tPct, rEmp = EMPIRICAL_REBATE_PCT;
  console.log(`  RATES: trading ${p2(tPct)}  + rebate(model) ${p2(rPctModel)}  = net ${p2(tPct + rPctModel)}`);
  console.log(`  VERDICT @ empirical rebate 0.61%:  |t%| ${p2(Math.abs(tEmp))} vs r% ${p2(rEmp)}  →  ${tEmp + rEmp >= 0 ? 'rebate COVERS trading ✅' : 'trading loss EXCEEDS rebate ❌'}`);
}
function pctOf(a: number, b: number): string { return b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a'; }

function main(): void {
  const args = process.argv.slice(2);
  const paths: string[] = [];
  let singleSpread: number | null = null;
  let assetFilter: Set<string> | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spread') singleSpread = Number(args[++i]);
    else if (args[i] === '--assets') assetFilter = new Set(args[++i].toUpperCase().split(','));
    else if (!args[i].startsWith('--')) paths.push(resolve(args[i]));
  }
  const cfg = loadBotYaml();
  const tapes = paths.length ? paths : allTapes();
  let pairs = loadPairs(tapes);
  if (assetFilter) pairs = pairs.filter((p) => assetFilter!.has(p.asset));

  console.log(`Loaded ${pairs.length} market PAIRS (both legs, by conditionId) from ${tapes.length} tape(s):`);
  for (const p of tapes) console.log(`  - ${p}`);
  if (assetFilter) console.log(`Asset filter: ${[...assetFilter].join(',')}`);
  console.log(`Realism: fill_participation=${cfg.maker.fillParticipation}, queue model ON, delta-neutral (buy both legs + hold to 0/1)`);
  if (!pairs.length) { console.log('No dual-leg pairs found. Need a tape with conditionId/side (recorder dual-leg).'); return; }

  const spreads = singleSpread !== null ? [singleSpread] : [0.01, 0.02, 0.03, 0.04, 0.05, 0.07];
  for (const hs of spreads) {
    const m = backtest(pairs, { ...cfg.maker, halfSpread: hs });
    report(`half_spread=${hs}`, m);
  }
}

main();
