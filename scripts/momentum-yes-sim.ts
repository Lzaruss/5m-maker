/**
 * MOMENTUM-GATED ALL-YES (2026-05-31). The plain all-YES bet is a pure wager on
 * the UP rate (break-even ~54%; the tape was 49.8% => loses). This asks the only
 * thing that makes it tradeable: can we DETECT a bullish window and bet YES only
 * then? Tests whether recent underlying momentum predicts the window outcome.
 *
 * Builds a per-asset price series from every book event's stamped btcPx (global
 * timestamps). For each window, at entry (ttr≈entrySec) computes the prior-L-second
 * return r = px(entry)/px(entry-L) - 1. Then:
 *   - gate UP: when r >= +thr (uptrend) bet YES; report that subset's UP rate + PnL.
 *   - gate DN: when r <= -thr (downtrend) bet NO; symmetric check.
 * If recent-up windows have a materially higher UP rate than 50%, 5m moves carry
 * momentum and a trend-gated directional bet has an edge. If ~50%, they're a
 * random walk and no entry signal exists.
 *
 *   npm run tsnode -- scripts/momentum-yes-sim.ts [tape...] [--asset BNB]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const FEE = 0.07;
const fee = (p: number) => FEE * p * (1 - p);

interface Snap { ttr: number; bid: number | null; ask: number | null }
interface Win { asset: string; cond: string; resolvesAt: number; windowSec: number; yesWon?: boolean; yes: Snap[]; no: Snap[] }
interface Px { ts: number; px: number }

function tapes(): string[] {
  const raw = process.argv.slice(2); const args: string[] = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { i++; continue; } args.push(raw[i]); }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
const argVal = (flag: string, def: string) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };

// nearest px to a timestamp via binary search (series sorted by ts)
function pxAt(series: Px[], ts: number): number | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].ts < ts) lo = m + 1; else hi = m; }
  const cand = [series[lo], series[lo - 1]].filter(Boolean);
  let best: Px | null = null, bd = Infinity;
  for (const c of cand) { const d = Math.abs(c.ts - ts); if (d < bd) { bd = d; best = c; } }
  return best && bd < 30_000 ? best.px : null; // within 30s
}

async function main(): Promise<void> {
  const assetFilter = process.argv.includes('--asset') ? argVal('--asset', '').toUpperCase() : null;
  const wins = new Map<string, Win>();
  const tok = new Map<string, { cond: string; side: 'YES' | 'NO'; asset: string }>();
  const pxSeries = new Map<string, Px[]>(); // asset -> px points

  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (assetFilter && e.asset !== assetFilter) continue;
        let w = wins.get(e.conditionId);
        if (!w) { w = { asset: e.asset, cond: e.conditionId, resolvesAt: e.resolvesAt, windowSec: (e.windowMinutes ?? 5) * 60, yes: [], no: [] }; wins.set(e.conditionId, w); }
        tok.set(e.tokenId, { cond: e.conditionId, side: e.side, asset: e.asset });
      } else if (e.t === 'resolution') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond);
        if (w && typeof e.yesWon === 'boolean') w.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (!w) continue;
        const ttr = (w.resolvesAt - e.ts) / 1000; if (ttr >= -5 && ttr <= w.windowSec + 60) {
          (tc.side === 'YES' ? w.yes : w.no).push({ ttr, bid: typeof e.bid === 'number' ? e.bid : null, ask: typeof e.ask === 'number' ? e.ask : null });
        }
        if (typeof e.btcPx === 'number') { const arr = pxSeries.get(tc.asset) ?? []; arr.push({ ts: e.ts, px: e.btcPx }); pxSeries.set(tc.asset, arr); }
      }
    }
  }
  for (const arr of pxSeries.values()) arr.sort((a, b) => a.ts - b.ts);
  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yes.length > 5);
  for (const w of list) { w.yes.sort((a, b) => b.ttr - a.ttr); w.no.sort((a, b) => b.ttr - a.ttr); }
  const label = assetFilter ?? 'POOLED (all assets)';
  console.log(`\n===== MOMENTUM-GATED YES — ${label} =====`);
  console.log(`resolved windows: ${list.length}   base UP rate: ${(100 * list.filter((w) => w.yesWon).length / list.length).toFixed(1)}%`);

  const nearest = (arr: Snap[], t: number): Snap | null => { let b: Snap | null = null, bd = 12; for (const s of arr) { const d = Math.abs(s.ttr - t); if (d < bd && s.ask != null && s.bid != null) { bd = d; b = s; } } return b; };
  const entrySec = 270;

  // First: does prior-L return predict the outcome at all? (no trading, just stats)
  console.log(`\n  -- prior-return predictiveness (entry ttr≈${entrySec}s) --`);
  for (const L of [60, 120, 300, 600]) {
    const upBucket = { n: 0, won: 0 }, dnBucket = { n: 0, won: 0 }, flatBucket = { n: 0, won: 0 };
    const thr = 0.0005;
    for (const w of list) {
      const series = pxSeries.get(w.asset); if (!series) continue;
      const entryTs = w.resolvesAt - entrySec * 1000;
      const pNow = pxAt(series, entryTs), pPrev = pxAt(series, entryTs - L * 1000);
      if (pNow == null || pPrev == null) continue;
      const r = pNow / pPrev - 1;
      const b = r >= thr ? upBucket : r <= -thr ? dnBucket : flatBucket;
      b.n++; if (w.yesWon) b.won++;
    }
    const f = (x: { n: number; won: number }) => x.n < 8 ? `n=${x.n}` : `UP ${(100 * x.won / x.n).toFixed(0)}% (n=${x.n})`;
    console.log(`     L=${String(L).padStart(3)}s:  trend-UP -> ${f(upBucket)}   flat -> ${f(flatBucket)}   trend-DN -> ${f(dnBucket)}`);
  }

  // Then: trade the gate. When trend-up bet YES@ask; when trend-dn bet NO@ask. Hold to resolution.
  // --contrarian flips the side (fade the trend) to test the mean-reversion hypothesis.
  const CONTRARIAN = process.argv.includes('--contrarian');
  console.log(`\n  -- trade the ${CONTRARIAN ? 'CONTRARIAN (fade)' : 'trend'} gate (hold to resolution, net fee) --`);
  for (const L of [120, 300, 600]) {
    for (const thr of [0.0005, 0.0015, 0.003]) {
      let n = 0, win = 0, pnl = 0, inv = 0;
      for (const w of list) {
        const series = pxSeries.get(w.asset); if (!series) continue;
        const entryTs = w.resolvesAt - entrySec * 1000;
        const pNow = pxAt(series, entryTs), pPrev = pxAt(series, entryTs - L * 1000);
        if (pNow == null || pPrev == null) continue;
        const r = pNow / pPrev - 1;
        let side: 'YES' | 'NO' | null = null;
        if (r >= thr) side = 'YES'; else if (r <= -thr) side = 'NO';
        if (!side) continue;
        if (CONTRARIAN) side = side === 'YES' ? 'NO' : 'YES';
        const en = nearest(side === 'YES' ? w.yes : w.no, entrySec); if (!en || en.ask == null) continue;
        const entry = en.ask; if (entry <= 0.02 || entry >= 0.98) continue;
        const won = side === 'YES' ? w.yesWon : !w.yesWon;
        pnl += (won ? 1 : 0) - entry - fee(entry); inv += entry; n++; if (won) win++;
      }
      if (n >= 5) console.log(`     L=${String(L).padStart(3)}s thr=${(thr * 100).toFixed(2)}%: trades=${String(n).padStart(3)} win=${(100 * win / n).toFixed(0)}% total=$${pnl.toFixed(2)} $/tr=${(pnl / n).toFixed(3)} ROI=${(100 * pnl / inv).toFixed(1)}%`);
    }
  }
  console.log(`\n  (trend-UP win% >> 50 = momentum (continuation) => tradeable. ~50 = random walk, no signal.)`);
  console.log(`========================================================\n`);
}
main().catch((e) => { console.error('momentum-yes-sim fatal:', e?.message ?? e); process.exit(1); });
