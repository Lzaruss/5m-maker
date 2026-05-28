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

// taker fee model from bot.yml: shares * rate * p * (1-p)
const TAKER_RATE = 0.07;
function takerFee(shares: number, p: number): number {
  return shares * TAKER_RATE * p * (1 - p);
}

async function main(): Promise<void> {
  for (const path of files()) {
    const wins = new Map<string, Win>();        // keyed by yesToken (window id)
    const tokenToWin = new Map<string, string>(); // any token -> window key
    let curKey: string | null = null;

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
          if (Number.isFinite(e.balanceUsd)) {
            if (firstStartBal === null) firstStartBal = e.balanceUsd;
            lastStartBal = e.balanceUsd;
            startBals.push(e.balanceUsd);
          }
          break;
        case 'window_open': {
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
          rc.push({ ts: e.ts, net: e.netDeltaUsd, cash: e.cashUsd, mark: e.markSessionUsd });
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
    let bothLegsBoughtLossUsd = 0;
    let imbalSum = 0, imbalWindows = 0;
    let takerFeeTot = 0, takerShares = 0;
    let recTot = 0, placeTot = 0, cancelTot = 0, fillCount = 0;
    let resolvedWindows = 0;

    for (const w of wins.values()) {
      recTot += w.reconciles; placeTot += w.places; cancelTot += w.cancels;
      for (const f of w.flattenFok) { takerFeeTot += takerFee(f.shares, f.refPrice); takerShares += f.shares; }

      const yes = w.legs.get(w.yesToken!); const no = w.legs.get(w.noToken!);
      const legArr = [yes, no].filter(Boolean) as Leg[];
      for (const leg of legArr) {
        totBuyShares += leg.buyShares; totBuyUsd += leg.buyUsd;
        totSellShares += leg.sellShares; totSellUsd += leg.sellUsd;
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
          actualResolvedPnl += leg.sellUsd - leg.buyUsd + Math.max(0, held) * leg.settle;
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
        const pairPnl = matched * (1 - pairCost);   // matched pair pays $1 at settle
        if (pairCost > 1) { pairLossWindows++; bothLegsBoughtLossUsd += matched * (pairCost - 1); }
        else pairProfitWindows++;
        const imbal = Math.abs(yes.buyShares - no.buyShares);
        imbalSum += imbal; imbalWindows++;
      }
      if (yes?.resolved || no?.resolved) resolvedWindows++;
    }

    const avgBuyPx = totBuyShares > 0 ? totBuyUsd / totBuyShares : 0;
    const winRate = resolvedBuyShares > 0 ? winShares / resolvedBuyShares : 0;
    const cashFlow = totSellUsd - totBuyUsd;   // realized cash from trading (pre-settle)

    // ── Report ───────────────────────────────────────────────────────────────
    const name = path.split(/[\\/]/).pop();
    console.log(`\n══════════ ${name} ══════════`);
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
    } else console.log(`(no windows had BUY fills on both legs — bot is trading one-sided)`);
    console.log(`\n── PnL DECOMPOSITION (resolved legs, fill-based) ───────`);
    console.log(`spread captured on round-trips : $${spreadPnl.toFixed(2)}`);
    console.log(`hold-to-resolution PnL (tail)  : $${holdPnl.toFixed(2)}`);
    console.log(`trading cash flow (sell-buy)   : $${cashFlow.toFixed(2)}`);
    console.log(`taker drag from flatten FOKs   : -$${takerFeeTot.toFixed(2)}  (${takerShares.toFixed(0)} sh flattened as taker)`);
    console.log(`  ─ actual realized PnL (resolved legs)        : $${actualResolvedPnl.toFixed(2)}`);
    console.log(`  ─ COUNTERFACTUAL: never sell, hold all to settle: $${holdAllPnl.toFixed(2)}   ` +
      `(Δ from selling = $${(holdAllPnl - actualResolvedPnl).toFixed(2)})`);
    console.log(`\n── CHURN / OVERTRADING ─────────────────────────────────`);
    console.log(`reconciles ${recTot}   places ${placeTot}   cancels ${cancelTot}   fills ${fillCount}`);
    console.log(`  reconciles per fill: ${fillCount > 0 ? (recTot / fillCount).toFixed(0) : 'n/a'}   places per fill: ${fillCount > 0 ? (placeTot / fillCount).toFixed(1) : 'n/a'}`);
  }
}

main().catch((e) => { console.error('analyze-session fatal:', e?.message ?? e); process.exit(1); });
