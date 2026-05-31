/**
 * MOMENTUM-PLUS (2026-05-31). The live momentum strategy bets WITH the 5-min
 * trend (prior-300s return) at ~270s-to-resolve, fixed clip, hold to resolution.
 * This tests three refinements to make it better, on the 2-day tape:
 *
 *   A. CONVICTION — does win% / $-per-trade rise with |prior return|? (justifies
 *      sizing bigger on stronger signals.)
 *   B. CONFIRMATION — does requiring the 60s AND 300s returns to agree (same sign)
 *      lift the win rate over the 300s-only signal?
 *   C. DISLOCATION — among trend windows, is the edge bigger when the entry ask is
 *      still near 0.50 (book hasn't priced the move) vs already high?
 *
 *   npm run tsnode -- scripts/momentum-plus-sim.ts [tape...] [--asset BNB]
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

function pxAt(series: Px[], ts: number): number | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].ts < ts) lo = m + 1; else hi = m; }
  const cand = [series[lo], series[lo - 1]].filter(Boolean);
  let best: Px | null = null, bd = Infinity;
  for (const c of cand) { const d = Math.abs(c.ts - ts); if (d < bd) { bd = d; best = c; } }
  return best && bd < 30_000 ? best.px : null;
}

async function main(): Promise<void> {
  const assetFilter = process.argv.includes('--asset') ? argVal('--asset', '').toUpperCase() : null;
  const wins = new Map<string, Win>();
  const tok = new Map<string, { cond: string; side: 'YES' | 'NO'; asset: string }>();
  const pxSeries = new Map<string, Px[]>();

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
        const ttr = (w.resolvesAt - e.ts) / 1000; if (ttr >= -5 && ttr <= w.windowSec + 60) (tc.side === 'YES' ? w.yes : w.no).push({ ttr, bid: typeof e.bid === 'number' ? e.bid : null, ask: typeof e.ask === 'number' ? e.ask : null });
        if (typeof e.btcPx === 'number') { const arr = pxSeries.get(tc.asset) ?? []; arr.push({ ts: e.ts, px: e.btcPx }); pxSeries.set(tc.asset, arr); }
      }
    }
  }
  for (const arr of pxSeries.values()) arr.sort((a, b) => a.ts - b.ts);
  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yes.length > 5);
  for (const w of list) { w.yes.sort((a, b) => b.ttr - a.ttr); w.no.sort((a, b) => b.ttr - a.ttr); }
  const nearest = (arr: Snap[], t: number): Snap | null => { let b: Snap | null = null, bd = 12; for (const s of arr) { const d = Math.abs(s.ttr - t); if (d < bd && s.ask != null && s.bid != null) { bd = d; b = s; } } return b; };
  const entrySec = 270, thr = 0.0005;

  // Precompute per-window: signal returns + chosen side + entry ask + outcome.
  interface Row { r300: number; r60: number; side: 'YES' | 'NO'; ask: number; won: boolean }
  const rows: Row[] = [];
  for (const w of list) {
    const series = pxSeries.get(w.asset); if (!series) continue;
    const entryTs = w.resolvesAt - entrySec * 1000;
    const pNow = pxAt(series, entryTs), p300 = pxAt(series, entryTs - 300_000), p60 = pxAt(series, entryTs - 60_000);
    if (pNow == null || p300 == null || p60 == null) continue;
    const r300 = pNow / p300 - 1, r60 = pNow / p60 - 1;
    if (Math.abs(r300) < thr) continue; // current strategy's gate
    const side: 'YES' | 'NO' = r300 > 0 ? 'YES' : 'NO';
    const en = nearest(side === 'YES' ? w.yes : w.no, entrySec); if (!en || en.ask == null) continue;
    if (en.ask <= 0.02 || en.ask >= 0.98) continue;
    const won = side === 'YES' ? !!w.yesWon : !w.yesWon;
    rows.push({ r300, r60, side, ask: en.ask, won });
  }
  const label = assetFilter ?? 'POOLED';
  console.log(`\n===== MOMENTUM-PLUS — ${label} =====   trend windows: ${rows.length}`);
  const stat = (rs: Row[]) => {
    if (!rs.length) return 'n=0';
    let pnl = 0, won = 0, ask = 0; for (const r of rs) { pnl += (r.won ? 1 : 0) - r.ask - fee(r.ask); won += r.won ? 1 : 0; ask += r.ask; }
    return `n=${String(rs.length).padStart(3)} win=${(100 * won / rs.length).toFixed(0)}% avgAsk=${(ask / rs.length).toFixed(2)} $/tr=${(pnl / rs.length).toFixed(3)} ROI=${(100 * pnl / ask).toFixed(1)}%`;
  };

  console.log(`\n  -- A. CONVICTION (bucket by |prior-300s return|) --`);
  const cb: [string, (r: Row) => boolean][] = [
    ['|r| 0.05-0.10%', (r) => Math.abs(r.r300) < 0.001],
    ['|r| 0.10-0.20%', (r) => Math.abs(r.r300) >= 0.001 && Math.abs(r.r300) < 0.002],
    ['|r| 0.20-0.40%', (r) => Math.abs(r.r300) >= 0.002 && Math.abs(r.r300) < 0.004],
    ['|r| 0.40%+    ', (r) => Math.abs(r.r300) >= 0.004],
  ];
  for (const [lab, f] of cb) console.log(`     ${lab}: ${stat(rows.filter(f))}`);

  console.log(`\n  -- B. CONFIRMATION (60s vs 300s agreement) --`);
  console.log(`     r300 only (current) : ${stat(rows)}`);
  console.log(`     60s & 300s AGREE    : ${stat(rows.filter((r) => Math.sign(r.r60) === Math.sign(r.r300)))}`);
  console.log(`     60s & 300s DISAGREE : ${stat(rows.filter((r) => Math.sign(r.r60) !== Math.sign(r.r300)))}`);

  console.log(`\n  -- C. DISLOCATION (bucket by entry ask; low ask = book hasn't priced) --`);
  const ab: [string, (r: Row) => boolean][] = [
    ['ask < 0.55     ', (r) => r.ask < 0.55],
    ['ask 0.55-0.65  ', (r) => r.ask >= 0.55 && r.ask < 0.65],
    ['ask 0.65-0.75  ', (r) => r.ask >= 0.65 && r.ask < 0.75],
    ['ask 0.75+      ', (r) => r.ask >= 0.75],
  ];
  for (const [lab, f] of ab) console.log(`     ${lab}: ${stat(rows.filter(f))}`);

  console.log(`\n  -- D. LONG-ONLY vs BOTH-SIDES (production threshold |r|>=0.10%) --`);
  const strong = rows.filter((r) => Math.abs(r.r300) >= 0.001);
  console.log(`     BOTH sides (YES+NO) : ${stat(strong)}`);
  console.log(`     LONG-ONLY (YES only): ${stat(strong.filter((r) => r.side === 'YES'))}`);
  console.log(`     (skipped DOWN trades): ${stat(strong.filter((r) => r.side === 'NO'))}`);
  console.log(`\n  ($/tr per 1-share clip held to resolution, net fee.)`);
  console.log(`==========================================================\n`);
}
main().catch((e) => { console.error('momentum-plus-sim fatal:', e?.message ?? e); process.exit(1); });
