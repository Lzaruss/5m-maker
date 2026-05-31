/**
 * Backtest — FAVORITE-BIAS HARVESTER.
 *
 * Thesis (from scripts/edge-study.ts): the Polymarket 5m price exhibits a
 * favorite-longshot bias — favorites (~0.7-0.9) win MORE than priced, longshots
 * win less. We harvest the favorite side: when a token's price sits in the
 * favorite band during the mid-window (where the bias lives, before it converges
 * at the close), BUY it as a TAKER (cross to the ask + pay the fee) and HOLD to
 * 0/1 resolution. One position per market. Mostly no-trade.
 *
 * Execution is modeled REALISTICALLY (the honest part): we buy at the ASK, not
 * the mid, and pay the taker fee = shares*feeRate*p*(1-p). If the edge survives
 * that, it is real; if the ask+fee eats it, it is not.
 *
 * Works on dual-leg tape (per-token `side`/`won`) and legacy YES-only tape
 * (defaults side=YES, won=yesWon).
 *
 *   npm run tsnode -- scripts/backtest-harvester.ts [tape...] \
 *     [--band-lo 0.65] [--band-hi 0.90] [--entry-lo 60] [--entry-hi 240] \
 *     [--bet 5] [--asset BTC] [--sweep]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface Snap { ts: number; bid: number | null; ask: number | null; askLevels: [number, number][] }
interface Tok {
  conditionId: string; asset: string; side: 'YES' | 'NO';
  resolvesAt: number; won?: boolean; snaps: Snap[];
}
interface Trade { asset: string; resolvesAt: number; buyAsk: number; won: boolean; pnl: number }

const FEE_RATE = 0.07;

function tapes(): string[] {
  const raw = process.argv.slice(2);
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) { if (raw[i] !== '--sweep') i++; continue; }
    args.push(raw[i]);
  }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
function num(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function str(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function load(assetFilter: string | null): Promise<Map<string, Tok>> {
  const toks = new Map<string, Tok>();
  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (assetFilter && e.asset !== assetFilter) continue;
        const t = toks.get(e.tokenId) ?? { conditionId: e.conditionId ?? e.tokenId, asset: e.asset, side: (e.side ?? 'YES'), resolvesAt: 0, snaps: [] };
        t.resolvesAt = e.resolvesAt ?? t.resolvesAt;
        t.conditionId = e.conditionId ?? t.conditionId;
        if (e.side) t.side = e.side;
        toks.set(e.tokenId, t);
      } else if (e.t === 'resolution') {
        const t = toks.get(e.tokenId); if (!t) continue;
        if (typeof e.won === 'boolean') t.won = e.won;
        else if (typeof e.yesWon === 'boolean') t.won = t.side === 'YES' ? e.yesWon : !e.yesWon;
      } else if (e.t === 'book') {
        const t = toks.get(e.tokenId); if (!t || t.resolvesAt <= 0) continue;
        const askLevels: [number, number][] = Array.isArray(e.asks)
          ? e.asks.filter((l: any) => Array.isArray(l) && l[0] > 0 && l[1] > 0).map((l: any) => [Number(l[0]), Number(l[1])])
          : [];
        t.snaps.push({ ts: e.ts, bid: typeof e.bid === 'number' ? e.bid : null, ask: typeof e.ask === 'number' ? e.ask : null, askLevels });
      }
    }
  }
  return toks;
}

function backtest(toks: Map<string, Tok>, p: { bandLo: number; bandHi: number; entryLo: number; entryHi: number; bet: number }): Trade[] {
  const trades: Trade[] = [];
  const enteredCond = new Set<string>(); // one position per market
  // Deterministic order so "first qualifying snapshot" and one-per-market are stable.
  const arr = [...toks.values()].sort((a, b) => a.resolvesAt - b.resolvesAt);
  for (const t of arr) {
    if (typeof t.won !== 'boolean') continue;
    if (enteredCond.has(t.conditionId)) continue;
    const snaps = t.snaps.sort((x, y) => x.ts - y.ts);
    for (const s of snaps) {
      const ttr = (t.resolvesAt - s.ts) / 1000;
      if (ttr < p.entryLo || ttr > p.entryHi) continue;
      // Favorite decision uses the mid (true belief); we EXECUTE at the ask.
      const mid = s.bid && s.ask && s.ask > s.bid ? (s.bid + s.ask) / 2 : (s.ask ?? s.bid);
      if (mid === null) continue;
      if (mid < p.bandLo || mid > p.bandHi) continue;
      // REALISTIC TAKER FILL: walk the recorded ask book to deploy ~$bet,
      // paying worse prices up the levels if the top isn't deep enough. This is
      // the "harden" step — no infinite-liquidity assumption.
      const levels: [number, number][] = s.askLevels.length ? s.askLevels
        : (s.ask && s.ask > 0 ? [[s.ask, Infinity]] : []);
      if (!levels.length) continue;
      let remain = p.bet, shares = 0, cost = 0;
      for (const [px, sz] of levels) {
        if (!(px > 0 && px < 1 && sz > 0)) continue;
        const lvlCost = px * sz;
        if (remain <= lvlCost) { shares += remain / px; cost += remain; remain = 0; break; }
        shares += sz; cost += lvlCost; remain -= lvlCost;
      }
      if (shares <= 0) continue;
      const avgBuy = cost / shares;
      const fee = shares * FEE_RATE * avgBuy * (1 - avgBuy);
      const payoff = t.won ? shares : 0;
      const pnl = payoff - cost - fee;
      trades.push({ asset: t.asset, resolvesAt: t.resolvesAt, buyAsk: avgBuy, won: t.won, pnl });
      enteredCond.add(t.conditionId);
      break;
    }
  }
  return trades;
}

function report(label: string, trades: Trade[], bet: number): void {
  const n = trades.length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.won).length;
  const avgAsk = n ? trades.reduce((s, t) => s + t.buyAsk, 0) / n : 0;
  // max drawdown over the equity curve (chronological by resolvesAt)
  const seq = [...trades].sort((a, b) => a.resolvesAt - b.resolvesAt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of seq) { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const evPerTrade = n ? total / n : 0;
  const evPctOfBet = bet ? (100 * evPerTrade / bet) : 0;
  console.log(`\n=== ${label} ===`);
  console.log(`trades            : ${n}`);
  console.log(`win rate          : ${n ? (100 * wins / n).toFixed(1) : '0'}%   avg buy(ask) ${avgAsk.toFixed(3)}`);
  console.log(`total P&L         : ${fmt(total)}   ($${bet}/trade)`);
  console.log(`EV per trade      : ${fmt(evPerTrade)}  (${evPctOfBet >= 0 ? '+' : ''}${evPctOfBet.toFixed(2)}% of bet)`);
  console.log(`max drawdown      : ${fmt(-maxDD)}`);
}

function reportByBucket(trades: Trade[]): void {
  const byAsset = new Map<string, { n: number; pnl: number; wins: number }>();
  const byBand = new Map<number, { n: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const a = byAsset.get(t.asset) ?? { n: 0, pnl: 0, wins: 0 };
    a.n++; a.pnl += t.pnl; a.wins += t.won ? 1 : 0; byAsset.set(t.asset, a);
    const pb = Math.floor(t.buyAsk * 20) / 20; // 5c buckets
    const b = byBand.get(pb) ?? { n: 0, pnl: 0, wins: 0 };
    b.n++; b.pnl += t.pnl; b.wins += t.won ? 1 : 0; byBand.set(pb, b);
  }
  console.log(`  -- by asset --`);
  for (const [k, v] of [...byAsset.entries()].sort()) console.log(`     ${k.padEnd(5)} ${fmt(v.pnl).padStart(9)}  (${v.n} trades, WR ${(100 * v.wins / v.n).toFixed(0)}%)`);
  console.log(`  -- by buy-price bucket --`);
  for (const [k, v] of [...byBand.entries()].sort((a, b) => a[0] - b[0])) console.log(`     ${k.toFixed(2)}-${(k + 0.05).toFixed(2)}: ${fmt(v.pnl).padStart(9)}  (${v.n} trades, WR ${(100 * v.wins / v.n).toFixed(0)}%, EV/trade ${fmt(v.pnl / v.n)})`);
}

function fmt(x: number): string { return (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2); }

async function main(): Promise<void> {
  const assetFilter = process.argv.includes('--asset') ? str('--asset', 'BTC').toUpperCase() : null;
  const bet = num('--bet', 5);
  const toks = await load(assetFilter);
  const resolved = [...toks.values()].filter((t) => typeof t.won === 'boolean').length;
  console.log(`Loaded ${toks.size} tokens (${resolved} resolved)${assetFilter ? `, asset=${assetFilter}` : ''}, bet=$${bet}/trade`);

  if (process.argv.includes('--sweep')) {
    console.log(`\nSweeping favorite band (entry T ${num('--entry-lo', 60)}-${num('--entry-hi', 240)}s)...`);
    const bands: [number, number][] = [[0.60, 0.95], [0.65, 0.90], [0.70, 0.90], [0.70, 0.85], [0.75, 0.90], [0.80, 0.95]];
    for (const [lo, hi] of bands) {
      const tr = backtest(toks, { bandLo: lo, bandHi: hi, entryLo: num('--entry-lo', 60), entryHi: num('--entry-hi', 240), bet });
      report(`band ${lo}-${hi}`, tr, bet);
    }
    return;
  }

  const params = { bandLo: num('--band-lo', 0.65), bandHi: num('--band-hi', 0.90), entryLo: num('--entry-lo', 60), entryHi: num('--entry-hi', 240), bet };
  const trades = backtest(toks, params);
  report(`harvester band ${params.bandLo}-${params.bandHi}, entry T-${params.entryHi}..${params.entryLo}s`, trades, bet);
  reportByBucket(trades);
}

main().catch((e) => { console.error('backtest fatal:', e?.message ?? e); process.exit(1); });
