/**
 * Real win rate of today's fills, from confirmed resolutions: window_result events
 * in the log first, then on-chain fetchResolution for any still unresolved. Maps
 * each fill's token to its window's YES token (via window_open) and the outcome.
 * Win = the bought leg settled to $1. (Replaces the unreliable shadow win rate.)
 */
import { readFileSync } from 'node:fs';
import { fetchResolution } from '../src/markets/gammaPoller.js';

interface Info { yes: string; side: 'YES' | 'NO' }

async function main(): Promise<void> {
  const ev = readFileSync('data/live-events-2026-06-01.jsonl', 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  const tokInfo: Record<string, Info> = {};
  const tokOutcome: Record<string, boolean> = {}; // yesToken -> yesWon
  for (const e of ev) {
    if (e.kind === 'window_open') { tokInfo[e.yesToken] = { yes: e.yesToken, side: 'YES' }; tokInfo[e.noToken] = { yes: e.yesToken, side: 'NO' }; }
    if (e.kind === 'window_result' && e.resolved && e.yesWon != null && e.yesToken) tokOutcome[e.yesToken] = e.yesWon;
  }
  const fills = ev.filter((e) => e.kind === 'fill');
  const starts = ev.filter((e) => e.kind === 'start').map((e) => ({ ts: e.ts, contrarian: !!(e.maker && e.maker.momentumContrarian) }));
  const eraOf = (ts: number) => { let c = false; for (const s of starts) if (s.ts <= ts) c = s.contrarian; return c ? 'contrarian' : 'momentum'; };
  const fmt = (t: number) => new Date(t).toISOString().slice(11, 19);

  let win = 0, loss = 0, unk = 0, realPnl = 0;
  const byEra: Record<string, { w: number; l: number }> = { contrarian: { w: 0, l: 0 }, momentum: { w: 0, l: 0 } };
  console.log('=== today fills — REAL outcome ===');
  for (const f of fills) {
    const info = tokInfo[f.token];
    let yesWon: boolean | null = null;
    if (info) {
      if (info.yes in tokOutcome) yesWon = tokOutcome[info.yes];
      else { const r = await fetchResolution(info.yes, 0.8); if (r) { yesWon = r.yesWon; tokOutcome[info.yes] = r.yesWon; } }
    }
    const won = yesWon == null || !info ? null : (info.side === 'YES' ? yesWon : !yesWon);
    const era = eraOf(f.ts);
    let pnl: number | null = null;
    if (won != null) { const fee = 0.07 * f.price * (1 - f.price) * f.shares; pnl = ((won ? 1 : 0) - f.price) * f.shares - fee; realPnl += pnl; if (won) { win++; byEra[era].w++; } else { loss++; byEra[era].l++; } }
    else unk++;
    console.log(`${fmt(f.ts)} ${era.padEnd(10)} ${info ? info.side : '?'} @${f.price.toFixed(2)} x${f.shares.toFixed(1)} -> ${won == null ? 'UNRESOLVED' : won ? 'WIN' : 'LOSS'}${pnl != null ? '  pnl=' + pnl.toFixed(2) : ''}`);
  }
  const tot = win + loss;
  console.log(`\n=== REAL WIN RATE (on-chain confirmed) ===`);
  console.log(`  OVERALL: ${win}/${tot} = ${tot ? Math.round(100 * win / tot) : 0}%   (still unresolved: ${unk})`);
  for (const e of ['momentum', 'contrarian']) { const x = byEra[e]; const t = x.w + x.l; console.log(`  ${e.padEnd(10)}: ${x.w}/${t} = ${t ? Math.round(100 * x.w / t) : 0}%`); }
  console.log(`  real settle P&L on resolved fills: $${realPnl.toFixed(2)}`);
}
main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
