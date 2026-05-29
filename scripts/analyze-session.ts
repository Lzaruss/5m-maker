/**
 * Live-session post-mortem. Reads one or more live-events-*.jsonl files and
 * decomposes REAL performance into the microstructure drivers that matter for a
 * maker-only Polymarket bot:
 *
 *   - matched-pair cost  (avgBuyYes + avgBuyNo): the core MM question — are we
 *     paying < $1 for a guaranteed $1, or is adverse selection making the pair
 *     cost > $1 (structural double-loss)?
 *   - spread captured on round-tripped shares vs hold-to-resolution PnL
 *   - directional edge check: avg buy price vs realized win rate (fair odds?)
 *   - inventory imbalance between YES and NO legs
 *   - taker drag from flatten FOKs (the only fee-paying executions)
 *   - churn: reconciles / places per actual fill (overtrading detector)
 *   - net-worth trajectory from reality_check (real PnL, not the mark)
 *
 *   npm run tsnode -- scripts/analyze-session.ts data/live-events-2026-05-28.jsonl
 *   npm run tsnode -- scripts/analyze-session.ts            # all live-events-*
 *   npm run tsnode -- scripts/analyze-session.ts data/live-events-2026-05-28.jsonl --start=2026-05-28T15:28Z --end=2026-05-28T17:25Z
 *
 * `--start`/`--end` (ISO) restrict to windows that OPENED in that range — use it
 * to isolate a single deploy from a file that mixes bot versions (e.g. the fixed
 * delta-neutral slice from the old-BTC morning on 2026-05-28).
 */
import { readdirSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface Leg {
  token: string;
  label: 'YES' | 'NO';
  buyShares: number; buyUsd: number;
  sellShares: number; sellUsd: number;
  settle: number | null;   // 0 or 1 once resolved
  resolved: boolean;
}
interface Win {
  yesToken?: string; noToken?: string;
  openTs?: number; resolvesAt?: number;
  legs: Map<string, Leg>;          // token -> leg
  reconciles: number; places: number; cancels: number;
  flattenFok: { shares: number; refPrice: number; side: string }[];
}

function emptyLeg(token: string, label: 'YES' | 'NO'): Leg {
  return { token, label, buyShares: 0, buyUsd: 0, sellShares: 0, sellUsd: 0, settle: null, resolved: false };
}

function files(): string[] {
  const dir = resolve('data');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length) return args.map((a) => resolve(a));
  return readdirSync(dir)
    .filter((f) => f.startsWith('live-events-') && f.endsWith('.jsonl'))
    .sort()
    .map((f) => resolve(dir, f));
}

// Optional time window (ISO) to isolate one deploy. Filters on window_open ts.
function timeFilter(): { startMs: number; endMs: number; label: string } {
  let startMs = -Infinity, endMs = Infinity, label = '';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--start=')) { startMs = Date.parse(a.slice(8)); label = `  [${a.slice(8)}`; }
    else if (a.startsWith('--end=')) { endMs = Date.parse(a.slice(6)); label += `→${a.slice(6)}]`; }
  }
  if (label && !label.endsWith(']')) label += ']';
  return { startMs, endMs, label };
}

// taker fee model from bot.yml: shares * rate * p * (1-p)
const TAKER_RATE = 0.07;
function takerFee(shares: number, p: number): number {
  return shares * TAKER_RATE * p * (1 - p);
}

async function main(): Promise<void> {
  const { startMs, endMs, label: tfLabel } = timeFilter();
  const inWindow = (ts: number) => ts >= startMs && ts <= endMs;
  for (const path of files()) {
    const wins = new Map<string, Win>();        // keyed by yesToken (window id)
    const tokenToWin = new Map<string, string>(); // any token -> window key
    let curKey: string | null = null;

    // per-fill log for timing/selection analysis (ratios are robust to the
    // double-count bug even if absolute $ are inflated)
    const fillLog: { ts: number; token: string; side: 'BUY' | 'SELL'; price: number; shares: number }[] = [];

    // reality_check trajectory
    const rc: { ts: number; net: number; cash: number; mark: number }[] = [];
    let firstStartBal: number | null = null;
    let lastStartBal: number | null = null;
    const startBals: number[] = [];

    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }

      switch (e.kind) {
        case 'start':
          if (Number.isFinite(e.balanceUsd) && (e.ts == null || inWindow(e.ts))) {
            if (firstStartBal === null) firstStartBal = e.balanceUsd;
            lastStartBal = e.balanceUsd;
            startBals.push(e.balanceUsd);
          }
          break;
        case 'window_open': {
          if (!inWindow(e.ts)) break;   // restrict to windows opened in --start/--end
          const key = e.yesToken;
          curKey = key;
          if (!wins.has(key)) {
            const w: Win = {
              yesToken: e.yesToken, noToken: e.noToken,
              openTs: e.ts, resolvesAt: e.resolvesAt ? Date.parse(e.resolvesAt) : undefined,
              legs: new Map(), reconciles: 0, places: 0, cancels: 0, flattenFok: [],
            };
            w.legs.set(e.yesToken, emptyLeg(e.yesToken, 'YES'));
            w.legs.set(e.noToken, emptyLeg(e.noToken, 'NO'));
            wins.set(key, w);
            tokenToWin.set(e.yesToken, key);
            tokenToWin.set(e.noToken, key);
          }
          break;
        }
        case 'fill': {
          const wk = tokenToWin.get(e.token);
          if (!wk) break;
          const leg = wins.get(wk)!.legs.get(e.token)!;
          if (e.side === 'BUY') { leg.buyShares += e.shares; leg.buyUsd += e.price * e.shares; }
          else { leg.sellShares += e.shares; leg.sellUsd += e.price * e.shares; }
          fillLog.push({ ts: e.ts, token: e.token, side: e.side, price: e.price, shares: e.shares });
          break;
        }
        case 'window_leg_result': {
          const wk = tokenToWin.get(e.token);
          if (!wk) break;
          const leg = wins.get(wk)!.legs.get(e.token);
          if (leg) { leg.settle = e.settle; leg.resolved = !!e.resolved; }
          break;
        }
        case 'reconcile': {
          const wk = tokenToWin.get(e.token); if (!wk) break;
          const w = wins.get(wk)!;
          w.reconciles++;
          w.places += (e.toPlace?.length ?? 0);
          w.cancels += (e.toCancel?.length ?? 0);
          break;
        }
        case 'flatten': {
          const wk = tokenToWin.get(e.token); if (!wk) break;
          wins.get(wk)!.flattenFok.push({ shares: e.shares, refPrice: e.refPrice, side: e.side });
          break;
        }
        case 'reality_check':
          if (inWindow(e.ts)) rc.push({ ts: e.ts, net: e.netDeltaUsd, cash: e.cashUsd, mark: e.markSessionUsd });
          break;
      }
    }

    // ── Aggregate ────────────────────────────────────────────────────────────
    let totBuyShares = 0, totBuyUsd = 0, totSellShares = 0, totSellUsd = 0;
    let winShares = 0;                 // bought shares whose leg settled to 1
    let resolvedBuyShares = 0;
    let spreadPnl = 0, holdPnl = 0;    // decomposition over resolved legs
    let actualResolvedPnl = 0;         // realized: sellUsd - buyUsd + held*settle
    let holdAllPnl = 0;                // counterfactual: never sell, hold all buys to settle
    let pairWindows = 0, pairCostSum = 0, pairLossWindows = 0, pairProfitWindows = 0;
    let matchedSharesTot = 0;   // Σ 2×min(yesBuy,noBuy): shares that are truly hedged
    let bothLegsBoughtLossUsd = 0;
    let imbalSum = 0, imbalWindows = 0;
    let takerFeeTot = 0, takerShares = 0;
    let recTot = 0, placeTot = 0, cancelTot = 0, fillCount = 0;
    let resolvedWindows = 0;
    const pnlByLabel: Record<'YES' | 'NO', number> = { YES: 0, NO: 0 };
    const buyShByLabel: Record<'YES' | 'NO', number> = { YES: 0, NO: 0 };
    // matched-pair cost split by whether the pair was opened near 50c (the
    // highest-implicit-cost / lowest-edge zone) vs in the wings.
    let near50Pairs = 0, near50CostSum = 0, wingPairs = 0, wingCostSum = 0;

    for (const w of wins.values()) {
      recTot += w.reconciles; placeTot += w.places; cancelTot += w.cancels;
      for (const f of w.flattenFok) { takerFeeTot += takerFee(f.shares, f.refPrice); takerShares += f.shares; }

      const yes = w.legs.get(w.yesToken!); const no = w.legs.get(w.noToken!);
      const legArr = [yes, no].filter(Boolean) as Leg[];
      for (const leg of legArr) {
        totBuyShares += leg.buyShares; totBuyUsd += leg.buyUsd;
        totSellShares += leg.sellShares; totSellUsd += leg.sellUsd;
        buyShByLabel[leg.label] += leg.buyShares;
        fillCount += (leg.buyShares > 0 ? 1 : 0) + (leg.sellShares > 0 ? 1 : 0);
        if (leg.resolved && leg.settle !== null) {
          resolvedBuyShares += leg.buyShares;
          if (leg.settle === 1) winShares += leg.buyShares;
          const avgBuy = leg.buyShares > 0 ? leg.buyUsd / leg.buyShares : 0;
          const avgSell = leg.sellShares > 0 ? leg.sellUsd / leg.sellShares : 0;
          const rt = Math.min(leg.buyShares, leg.sellShares);
          spreadPnl += rt * (avgSell - avgBuy);
          const held = leg.buyShares - leg.sellShares;
          if (held > 0) holdPnl += held * (leg.settle - avgBuy);
          const legPnl = leg.sellUsd - leg.buyUsd + Math.max(0, held) * leg.settle;
          actualResolvedPnl += legPnl;
          pnlByLabel[leg.label] += legPnl;
          holdAllPnl += leg.buyShares * leg.settle - leg.buyUsd;
        }
      }

      // Matched-pair cost (core MM metric): only windows where BOTH legs got BUYs
      if (yes && no && yes.buyShares > 0 && no.buyShares > 0) {
        const avgY = yes.buyUsd / yes.buyShares;
        const avgN = no.buyUsd / no.buyShares;
        const pairCost = avgY + avgN;
        pairWindows++; pairCostSum += pairCost;
        const matched = Math.min(yes.buyShares, no.buyShares);
        matchedSharesTot += 2 * matched;             // both legs of the hedged core
        const pairPnl = matched * (1 - pairCost);   // matched pair pays $1 at settle
        if (pairCost > 1) { pairLossWindows++; bothLegsBoughtLossUsd += matched * (pairCost - 1); }
        else pairProfitWindows++;
        const imbal = Math.abs(yes.buyShares - no.buyShares);
        imbalSum += imbal; imbalWindows++;
        // "Trapped near 50c": both legs bought in [0.40,0.60] -> pair cost ~1,
        // structural edge ~0, highest implicit cost. Wings = at least one leg
        // bought as a clear underdog.
        if (avgY >= 0.40 && avgY <= 0.60 && avgN >= 0.40 && avgN <= 0.60) { near50Pairs++; near50CostSum += pairCost; }
        else { wingPairs++; wingCostSum += pairCost; }
      }
      if (yes?.resolved || no?.resolved) resolvedWindows++;
    }

    // ── DISPOSITION 2x2: do we sell winners and hold losers? ──────────────────
    // Build token -> {settle, resolvesAt} maps, then bucket every leg's sold vs
    // held shares by whether that leg eventually WON (settle=1) or LOST (=0).
    const tokenSettle = new Map<string, number>();      // token -> 0/1
    const tokenResolves = new Map<string, number>();    // token -> resolvesAt ms
    let heldWin = 0, heldTot = 0;                        // held-to-resolution win rate
    let winLegSold = 0, winLegHeld = 0, loseLegSold = 0, loseLegHeld = 0;
    for (const w of wins.values()) {
      for (const leg of w.legs.values()) {
        if (w.resolvesAt) tokenResolves.set(leg.token, w.resolvesAt);
        if (!leg.resolved || leg.settle === null) continue;
        tokenSettle.set(leg.token, leg.settle);
        const held = Math.max(0, leg.buyShares - leg.sellShares);
        heldTot += held; if (leg.settle === 1) heldWin += held;
        if (leg.settle === 1) { winLegSold += leg.sellShares; winLegHeld += held; }
        else { loseLegSold += leg.sellShares; loseLegHeld += held; }
      }
    }

    // ── FILL TIMING: BUY fills by time-to-resolve, with eventual win rate ──────
    const TB = [
      { label: 'T-300..180', lo: 180, hi: 301 },
      { label: 'T-180..120', lo: 120, hi: 180 },
      { label: 'T-120..60', lo: 60, hi: 120 },
      { label: 'T-60..30', lo: 30, hi: 60 },
      { label: 'T-30..0', lo: 0, hi: 30 },
      { label: 'post-close', lo: -120, hi: 0 },
    ];
    const tbAgg = TB.map(() => ({ buySh: 0, buyUsd: 0, buyWinSh: 0, buyResolvedSh: 0, sellSh: 0 }));
    for (const f of fillLog) {
      const ra = tokenResolves.get(f.token); if (!ra) continue;
      const ttr = (ra - f.ts) / 1000;
      const bi = TB.findIndex((b) => ttr >= b.lo && ttr < b.hi); if (bi < 0) continue;
      const a = tbAgg[bi];
      if (f.side === 'BUY') {
        a.buySh += f.shares; a.buyUsd += f.price * f.shares;
        const st = tokenSettle.get(f.token);
        if (st !== undefined) { a.buyResolvedSh += f.shares; if (st === 1) a.buyWinSh += f.shares; }
      } else a.sellSh += f.shares;
    }

    // ── REBATE ESTIMATE & MAKER/TAKER ─────────────────────────────────────────
    // Crypto rebate = 20% of taker fees, distributed to makers by fee-equivalent
    // share. Because every trade pairs one maker and one taker using the SAME
    // fee_equiv formula, the pool denominator cancels: rebate earned ≈
    // 0.20 × Σ(our maker fills: shares × 0.07 × p × (1-p)).
    const REBATE_PCT = 0.20, FEE_RATE = 0.07;
    let makerShares = 0, rebateEst = 0;
    const sizeHist: Record<string, number> = { '<1': 0, '1-5': 0, '5-20': 0, '20+': 0 };
    for (const f of fillLog) {
      makerShares += f.shares;            // all logged fills are maker limit orders
      rebateEst += REBATE_PCT * f.shares * FEE_RATE * f.price * (1 - f.price);
      const b = f.shares < 1 ? '<1' : f.shares < 5 ? '1-5' : f.shares < 20 ? '5-20' : '20+';
      sizeHist[b]++;
    }
    const takerFrac = makerShares + takerShares > 0 ? takerShares / (makerShares + takerShares) : 0;

    const avgBuyPx = totBuyShares > 0 ? totBuyUsd / totBuyShares : 0;
    const winRate = resolvedBuyShares > 0 ? winShares / resolvedBuyShares : 0;
    const cashFlow = totSellUsd - totBuyUsd;   // realized cash from trading (pre-settle)

    // ── Report ───────────────────────────────────────────────────────────────
    const name = path.split(/[\\/]/).pop();
    console.log(`\n══════════ ${name}${tfLabel} ══════════`);
    console.log(`start balances seen (process restarts): ${startBals.map((b) => b.toFixed(1)).join(' → ')}`);
    if (rc.length) {
      const min = rc.reduce((m, x) => (x.net < m.net ? x : m), rc[0]);
      console.log(`reality_check netDelta: first ${rc[0].net.toFixed(2)}  last ${rc[rc.length - 1].net.toFixed(2)}  MIN ${min.net.toFixed(2)} @ ${new Date(min.ts).toISOString().slice(11, 19)}`);
      console.log(`  (netDelta = real wallet net worth vs process start balance)`);
    }
    console.log(`\nWindows: ${wins.size}  (resolved ${resolvedWindows})   total fills(legs traded): ${fillCount}`);
    console.log(`\n── ENTRY / DIRECTIONAL EDGE ────────────────────────────`);
    console.log(`bought   : ${totBuyShares.toFixed(0)} sh @ avg ${avgBuyPx.toFixed(3)}   ($${totBuyUsd.toFixed(2)})`);
    console.log(`sold     : ${totSellShares.toFixed(0)} sh @ avg ${(totSellShares > 0 ? totSellUsd / totSellShares : 0).toFixed(3)}   ($${totSellUsd.toFixed(2)})`);
    console.log(`win rate (resolved bought shares settling to $1): ${(100 * winRate).toFixed(1)}%  on ${resolvedBuyShares.toFixed(0)} sh`);
    console.log(`  → FAIR-ODDS CHECK: avg buy ${avgBuyPx.toFixed(3)} vs win rate ${winRate.toFixed(3)}  ` +
      `(${Math.abs(avgBuyPx - winRate) < 0.03 ? 'NO directional edge — spread is the only profit source' : avgBuyPx < winRate ? 'POSITIVE edge' : 'NEGATIVE edge — buying overpriced'})`);
    console.log(`\n── MATCHED-PAIR COST (the core market-making metric) ───`);
    if (pairWindows) {
      console.log(`windows with BUYs on both legs: ${pairWindows}`);
      console.log(`avg matched-pair cost (avgBuyYes + avgBuyNo): ${(pairCostSum / pairWindows).toFixed(4)}  ` +
        `(${pairCostSum / pairWindows < 1 ? 'PROFITABLE hedge' : 'LOSS — paying >$1 for $1'})`);
      console.log(`  pair-cost < 1 (good): ${pairProfitWindows}   pair-cost > 1 (adverse): ${pairLossWindows}`);
      console.log(`  $ lost on matched pairs that cost >$1: $${bothLegsBoughtLossUsd.toFixed(2)}`);
      console.log(`avg YES/NO share imbalance per paired window: ${(imbalSum / imbalWindows).toFixed(1)} sh`);
      // The variance driver for rebate-farming: hedged shares carry ~0 variance,
      // naked shares carry the full ±100% lottery. matched% = how delta-neutral
      // we ACTUALLY are in size. High matched% ⇒ low per-window noise (low c).
      const nakedSh = totBuyShares - matchedSharesTot;
      console.log(`MATCHED (hedged) shares: ${matchedSharesTot.toFixed(0)} / ${totBuyShares.toFixed(0)} bought = ${(100 * matchedSharesTot / Math.max(1, totBuyShares)).toFixed(0)}%   NAKED: ${nakedSh.toFixed(0)} sh (${(100 * nakedSh / Math.max(1, totBuyShares)).toFixed(0)}%) ← the variance source`);
    } else console.log(`(no windows had BUY fills on both legs — bot is trading one-sided)`);
    console.log(`\n── PnL DECOMPOSITION (resolved legs, fill-based) ───────`);
    console.log(`spread captured on round-trips : $${spreadPnl.toFixed(2)}`);
    console.log(`hold-to-resolution PnL (tail)  : $${holdPnl.toFixed(2)}`);
    console.log(`trading cash flow (sell-buy)   : $${cashFlow.toFixed(2)}`);
    console.log(`taker drag from flatten FOKs   : -$${takerFeeTot.toFixed(2)}  (${takerShares.toFixed(0)} sh flattened as taker)`);
    console.log(`  ─ actual realized PnL (resolved legs)        : $${actualResolvedPnl.toFixed(2)}`);
    console.log(`  ─ COUNTERFACTUAL: never sell, hold all to settle: $${holdAllPnl.toFixed(2)}   ` +
      `(Δ from selling = $${(holdAllPnl - actualResolvedPnl).toFixed(2)})`);

    // flatten fills are also logged as 'fill', so subtract their rebate-weight:
    // takers do not earn rebates. takerFeeTot = Σ flatten shares×rate×p(1-p).
    const makerRebateEst = rebateEst - REBATE_PCT * takerFeeTot;
    const trueMakerSh = Math.max(0, makerShares - takerShares);
    console.log(`\n── REBATES & MAKER/TAKER (crypto: 20% of taker fees) ───`);
    console.log(`executed shares: ${makerShares.toFixed(0)}   maker ${trueMakerSh.toFixed(0)} (${(100 * (1 - takerFrac)).toFixed(1)}%)   taker/flatten ${takerShares.toFixed(0)} (${(100 * takerFrac).toFixed(1)}%)`);
    console.log(`estimated REBATE earned (maker fills): +$${makerRebateEst.toFixed(2)}   [0.20 × Σ shares×0.07×p×(1-p)]`);
    console.log(`taker fees PAID on flattens          : -$${takerFeeTot.toFixed(2)}`);
    console.log(`  → net fee/rebate line: ${makerRebateEst - takerFeeTot >= 0 ? '+' : ''}$${(makerRebateEst - takerFeeTot).toFixed(2)}   (NOTE: only counts if rebates are actually being credited to the wallet — verify!)`);
    console.log(`  → trading PnL ($${actualResolvedPnl.toFixed(2)}) + est. rebate = $${(actualResolvedPnl + makerRebateEst).toFixed(2)}`);

    console.log(`\n── PnL BY LEG (structural YES vs NO bias?) ─────────────`);
    console.log(`YES: $${pnlByLabel.YES.toFixed(2)}  (${buyShByLabel.YES.toFixed(0)} sh bought)    NO: $${pnlByLabel.NO.toFixed(2)}  (${buyShByLabel.NO.toFixed(0)} sh bought)`);

    console.log(`\n── 50¢ TRAP (pair cost by zone) ────────────────────────`);
    if (near50Pairs) console.log(`near-50c pairs (both legs 0.40-0.60): ${near50Pairs}  avg pair cost ${(near50CostSum / near50Pairs).toFixed(4)}  ${near50CostSum / near50Pairs >= 0.99 ? '← paying structure, ~0 edge' : ''}`);
    if (wingPairs) console.log(`wing pairs (at least one underdog) : ${wingPairs}  avg pair cost ${(wingCostSum / wingPairs).toFixed(4)}`);
    if (!near50Pairs && !wingPairs) console.log(`(no two-sided pairs)`);

    console.log(`\n── FILL SIZE DISTRIBUTION (partial-fill detector) ──────`);
    console.log(`  <1sh: ${sizeHist['<1']}   1-5sh: ${sizeHist['1-5']}   5-20sh: ${sizeHist['5-20']}   20+sh: ${sizeHist['20+']}   (orders are ~5sh min; <5 = partials)`);
    console.log(`\n── DISPOSITION TEST (sell winners / hold losers?) ──────`);
    const winSellPct = (winLegSold + winLegHeld) > 0 ? winLegSold / (winLegSold + winLegHeld) : 0;
    const loseSellPct = (loseLegSold + loseLegHeld) > 0 ? loseLegSold / (loseLegSold + loseLegHeld) : 0;
    console.log(`WINNING legs (settle=$1): sold ${(100 * winSellPct).toFixed(0)}% of shares, held ${(100 * (1 - winSellPct)).toFixed(0)}%  (sold ${winLegSold.toFixed(0)} / held ${winLegHeld.toFixed(0)})`);
    console.log(`LOSING  legs (settle=$0): sold ${(100 * loseSellPct).toFixed(0)}% of shares, held ${(100 * (1 - loseSellPct)).toFixed(0)}%  (sold ${loseLegSold.toFixed(0)} / held ${loseLegHeld.toFixed(0)})`);
    console.log(`held-to-resolution win rate: ${heldTot > 0 ? (100 * heldWin / heldTot).toFixed(1) : 'n/a'}%  (vs overall ${(100 * winRate).toFixed(1)}%) — lower = the tail is negatively selected`);

    console.log(`\n── FILL TIMING (BUY fills by time-to-resolve) ──────────`);
    console.log(`  ${'bucket'.padEnd(12)}${'buySh'.padStart(8)}${'avgPx'.padStart(8)}${'winRate'.padStart(9)}${'sellSh'.padStart(8)}`);
    for (let i = 0; i < TB.length; i++) {
      const a = tbAgg[i];
      const avg = a.buySh > 0 ? a.buyUsd / a.buySh : 0;
      const wr = a.buyResolvedSh > 0 ? a.buyWinSh / a.buyResolvedSh : 0;
      console.log(`  ${TB[i].label.padEnd(12)}${a.buySh.toFixed(0).padStart(8)}${avg.toFixed(3).padStart(8)}${(a.buyResolvedSh > 0 ? (100 * wr).toFixed(0) + '%' : '-').padStart(9)}${a.sellSh.toFixed(0).padStart(8)}`);
    }

    console.log(`\n── CHURN / OVERTRADING ─────────────────────────────────`);
    console.log(`reconciles ${recTot}   places ${placeTot}   cancels ${cancelTot}   fills ${fillCount}`);
    console.log(`  reconciles per fill: ${fillCount > 0 ? (recTot / fillCount).toFixed(0) : 'n/a'}   places per fill: ${fillCount > 0 ? (placeTot / fillCount).toFixed(1) : 'n/a'}`);
  }
}

main().catch((e) => { console.error('analyze-session fatal:', e?.message ?? e); process.exit(1); });
