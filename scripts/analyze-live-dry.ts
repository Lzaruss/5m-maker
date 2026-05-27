/**
 * One-shot inspector for a DRY-mode live-events tape: estimates what would have
 * happened with `live.enabled=true`. Reads place intentions from `reconcile`
 * events and reports churn, would-be-rejected sizes, and per-window stats.
 *
 *   npm run tsnode -- scripts/analyze-live-dry.ts data/live-events-2026-05-26.jsonl
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

interface ReconcileQuote { side: 'BUY' | 'SELL'; price: number; size: number; }
interface ReconcileEvent { ts: number; kind: 'reconcile'; token: string; reason: string; toPlace: ReconcileQuote[]; }

interface WindowAgg {
  token: string;
  reconciles: number;
  doubleSided: number;
  singleSided: number;
  noQuote: number;
  uniqueDesiredPrices: Set<string>;
  belowMinSize: number;
  extremeBuy: number;   // <= 0.03
  extremeSell: number;  // >= 0.97
  widened: number;
  pulled: number;
  result?: { settle: number; resolved: boolean };
}

function emptyWin(token: string): WindowAgg {
  return {
    token, reconciles: 0, doubleSided: 0, singleSided: 0, noQuote: 0,
    uniqueDesiredPrices: new Set(), belowMinSize: 0, extremeBuy: 0, extremeSell: 0,
    widened: 0, pulled: 0,
  };
}

async function main(): Promise<void> {
  const path = resolve(process.argv[2] ?? 'data/live-events-2026-05-26.jsonl');
  const wins = new Map<string, WindowAgg>();
  let curToken: string | null = null;
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.kind === 'window_open') {
      curToken = ev.token;
      if (!wins.has(curToken!)) wins.set(curToken!, emptyWin(curToken!));
      continue;
    }
    if (ev.kind === 'window_result') {
      const w = wins.get(ev.token);
      if (w) w.result = { settle: ev.settle, resolved: ev.resolved };
      continue;
    }
    if (ev.kind !== 'reconcile') continue;
    const w = wins.get(ev.token) ?? emptyWin(ev.token);
    wins.set(ev.token, w);
    w.reconciles++;
    const tp: ReconcileQuote[] = ev.toPlace ?? [];
    if (tp.length === 0) w.noQuote++;
    else if (tp.length === 2) w.doubleSided++;
    else w.singleSided++;
    if (ev.reason === 'widened') w.widened++;
    if (ev.reason === 'pulled_one_side') w.pulled++;
    for (const q of tp) {
      w.uniqueDesiredPrices.add(`${q.side}:${q.price.toFixed(3)}`);
      if (q.size < 5) w.belowMinSize++;
      if (q.side === 'BUY' && q.price <= 0.03) w.extremeBuy++;
      if (q.side === 'SELL' && q.price >= 0.97) w.extremeSell++;
    }
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  let totReconciles = 0, totDouble = 0, totSingle = 0, totNo = 0;
  let totBelowMin = 0, totExtremeBuy = 0, totExtremeSell = 0;
  let totWidened = 0, totPulled = 0;
  for (const w of wins.values()) {
    totReconciles += w.reconciles;
    totDouble += w.doubleSided;
    totSingle += w.singleSided;
    totNo += w.noQuote;
    totBelowMin += w.belowMinSize;
    totExtremeBuy += w.extremeBuy;
    totExtremeSell += w.extremeSell;
    totWidened += w.widened;
    totPulled += w.pulled;
  }
  const tot = totReconciles || 1;

  console.log(`==== DRY live log analysis: ${path} ====\n`);
  console.log(`Windows seen           : ${wins.size}`);
  console.log(`Total reconcile events : ${totReconciles}`);
  console.log(`  - 2 quotes (both sides) : ${totDouble}  (${pct(totDouble,tot)})`);
  console.log(`  - 1 quote (side pulled) : ${totSingle}  (${pct(totSingle,tot)})`);
  console.log(`  - 0 quotes              : ${totNo}      (${pct(totNo,tot)})`);
  console.log(`  - widened reason        : ${totWidened} (${pct(totWidened,tot)})`);
  console.log(`  - pulled_one_side reason: ${totPulled} (${pct(totPulled,tot)})`);
  console.log('');
  console.log(`Quotes with size <5 shares (would be REJECTED pre-fix): ${totBelowMin}`);
  console.log(`BUY  quotes at price <= 0.03 (rejected by venue):       ${totExtremeBuy}`);
  console.log(`SELL quotes at price >= 0.97 (rejected by venue):       ${totExtremeSell}`);
  console.log('');

  // ── Per-window detail ────────────────────────────────────────────────────
  console.log('Per-window summary:');
  console.log(`  ${'#'.padStart(3)} ${'reconciles'.padStart(10)} ${'uniqPx'.padStart(7)} ${'2sided'.padStart(7)} ${'pulled'.padStart(7)} ${'belowMin'.padStart(9)} ${'extremeB/S'.padStart(11)} ${'settle'.padStart(7)} resolved`);
  let i = 0;
  for (const w of wins.values()) {
    i++;
    const settle = w.result ? w.result.settle.toString() : '?';
    const resolved = w.result ? (w.result.resolved ? 'yes' : 'fallback') : '?';
    console.log(
      `  ${String(i).padStart(3)} ${String(w.reconciles).padStart(10)} ${String(w.uniqueDesiredPrices.size).padStart(7)} ` +
      `${String(w.doubleSided).padStart(7)} ${String(w.pulled).padStart(7)} ${String(w.belowMinSize).padStart(9)} ` +
      `${(w.extremeBuy+'/'+w.extremeSell).padStart(11)} ${settle.padStart(7)} ${resolved}`,
    );
  }

  // ── Churn estimator ──────────────────────────────────────────────────────
  // Worst-case churn: every reconcile cancels and replaces both sides.
  // Lower bound: each unique desired price is placed once.
  console.log('\nChurn estimate (place attempts the live bot would have made):');
  let churnLB = 0;
  for (const w of wins.values()) churnLB += w.uniqueDesiredPrices.size;
  console.log(`  lower bound (one place per unique desired price): ${churnLB}`);
  console.log(`  upper bound (one place per reconcile per side)  : ~${totDouble*2 + totSingle}`);
}

function pct(a: number, b: number): string {
  return b > 0 ? `${((100*a)/b).toFixed(1)}%` : 'n/a';
}

main();
