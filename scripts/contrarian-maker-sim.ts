/**
 * CONTRARIAN-AS-MAKER simulation (2026-06-01). The contrarian strategy fades the
 * 5-min trend (trend-up → bet NO, trend-down → bet YES). Crucially it buys the
 * SOLD/out-of-favour side — so a PASSIVE bid there should actually fill (sellers
 * cross into it), earning the MAKER_REBATE (~0.58% of maker fill notional, paid
 * daily) instead of paying the taker fee. This tests whether maker-izing it works:
 *   - fill rate of a passive bid on the contrarian side
 *   - adverse selection (do the fills win less than the taker would?)
 *   - net = trade P&L + rebate, vs the TAKER baseline (cross to ask, pay fee)
 *
 * Fill model (queue-aware, from the real book depth + trade tape): place S shares
 * at the side's best bid; queue ahead = that bid's size; walk trades to resolution,
 * accumulating SELL-aggressor prints at price <= our bid; fill our S once the queue
 * clears. A side that keeps falling fills us (and may lose = adverse selection);
 * a side that bounces away leaves us unfilled (no position, no harm).
 *
 *   npx tsx scripts/contrarian-maker-sim.ts [tape...] [--asset BTC]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const TAKER_FEE = 0.07;
const REBATE_RATE = 0.0058; // of maker fill notional (empirical: $11.21 / $1938 on 2026-05-28)
const fee = (p: number) => TAKER_FEE * p * (1 - p);
const S = 5;
const ENTRY = 270, LOOKBACK = 300, THR = 0.001;

interface Snap { ttr: number; ts: number; bid: number | null; bidSz: number | null; ask: number | null }
interface Trade { ts: number; price: number; size: number; side: 'BUY' | 'SELL' }
interface Win { asset: string; cond: string; resolvesAt: number; windowSec: number; yesWon?: boolean; yes: Snap[]; no: Snap[]; yesTr: Trade[]; noTr: Trade[] }
interface Px { ts: number; px: number }

function tapes(): string[] {
  const raw = process.argv.slice(2); const args: string[] = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { i++; continue; } args.push(raw[i]); }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
const argVal = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
function pxAt(s: Px[], ts: number): number | null {
  if (!s.length) return null; let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].ts < ts) lo = m + 1; else hi = m; }
  const c = [s[lo], s[lo - 1]].filter(Boolean); let b: Px | null = null, bd = Infinity;
  for (const x of c) { const d = Math.abs(x.ts - ts); if (d < bd) { bd = d; b = x; } }
  return b && bd < 30_000 ? b.px : null;
}

async function main(): Promise<void> {
  const assetFilter = process.argv.includes('--asset') ? argVal('--asset', '').toUpperCase() : null;
  const wins = new Map<string, Win>();
  const tok = new Map<string, { cond: string; side: 'YES' | 'NO'; asset: string }>();
  const px = new Map<string, Px[]>();
  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (assetFilter && e.asset !== assetFilter) continue;
        let w = wins.get(e.conditionId);
        if (!w) { w = { asset: e.asset, cond: e.conditionId, resolvesAt: e.resolvesAt, windowSec: (e.windowMinutes ?? 5) * 60, yes: [], no: [], yesTr: [], noTr: [] }; wins.set(e.conditionId, w); }
        tok.set(e.tokenId, { cond: e.conditionId, side: e.side, asset: e.asset });
      } else if (e.t === 'resolution') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (w && typeof e.yesWon === 'boolean') w.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (!w) continue;
        const ttr = (w.resolvesAt - e.ts) / 1000; if (ttr >= -5 && ttr <= w.windowSec + 60) (tc.side === 'YES' ? w.yes : w.no).push({ ttr, ts: e.ts, bid: typeof e.bid === 'number' ? e.bid : null, bidSz: typeof e.bidSz === 'number' ? e.bidSz : null, ask: typeof e.ask === 'number' ? e.ask : null });
        if (typeof e.btcPx === 'number') { const a = px.get(tc.asset) ?? []; a.push({ ts: e.ts, px: e.btcPx }); px.set(tc.asset, a); }
      } else if (e.t === 'trade') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (!w) continue;
        if (typeof e.price !== 'number' || typeof e.size !== 'number') continue;
        (tc.side === 'YES' ? w.yesTr : w.noTr).push({ ts: e.ts, price: e.price, size: e.size, side: e.side === 'SELL' ? 'SELL' : 'BUY' });
      }
    }
  }
  for (const a of px.values()) a.sort((x, y) => x.ts - y.ts);
  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yes.length > 5);
  for (const w of list) { w.yes.sort((a, b) => b.ttr - a.ttr); w.no.sort((a, b) => b.ttr - a.ttr); w.yesTr.sort((a, b) => a.ts - b.ts); w.noTr.sort((a, b) => a.ts - b.ts); }
  const nearest = (arr: Snap[], t: number) => { let b: Snap | null = null, bd = 10; for (const s of arr) { const d = Math.abs(s.ttr - t); if (d < bd) { bd = d; b = s; } } return b; };

  console.log(`\n===== CONTRARIAN-AS-MAKER — ${assetFilter ?? 'POOLED'} =====`);
  console.log(`(entry ${ENTRY}s, lookback ${LOOKBACK}s, |r|>=${(THR * 100).toFixed(2)}%, clip ${S}, rebate ${(REBATE_RATE * 100).toFixed(2)}% of notional)`);

  let nSig = 0, nFill = 0, fillFrac = 0;
  let mTrade = 0, mReb = 0, mFilledWins = 0;            // maker
  let tNet = 0, tWins = 0;                               // taker baseline
  for (const w of list) {
    const series = px.get(w.asset); if (!series) continue;
    const entryTs = w.resolvesAt - ENTRY * 1000;
    const pNow = pxAt(series, entryTs), pPrev = pxAt(series, entryTs - LOOKBACK * 1000);
    if (pNow == null || pPrev == null) continue;
    const r = pNow / pPrev - 1; if (Math.abs(r) < THR) continue;
    // CONTRARIAN: fade the trend
    const side: 'YES' | 'NO' = r > 0 ? 'NO' : 'YES';
    const snap = nearest(side === 'YES' ? w.yes : w.no, ENTRY);
    if (!snap || snap.bid == null || snap.ask == null || snap.bidSz == null || snap.ask <= snap.bid) continue;
    if (snap.bid <= 0.02 || snap.ask >= 0.98) continue;
    const won = side === 'YES' ? !!w.yesWon : !w.yesWon;
    nSig++;
    // TAKER baseline: cross to ask, pay fee, no rebate
    tNet += ((won ? 1 : 0) - snap.ask - fee(snap.ask)) * S; if (won) tWins++;
    // MAKER: rest at the bid; fill when SELL volume at <= bid clears the queue
    const trades = side === 'YES' ? w.yesTr : w.noTr;
    const P = snap.bid, queue = snap.bidSz; let vol = 0, filled = 0;
    for (const tr of trades) { if (tr.ts < snap.ts) continue; if (tr.side === 'SELL' && tr.price <= P + 1e-9) { vol += tr.size; const past = vol - queue; if (past > 0) filled = Math.min(S, past); } if (filled >= S) break; }
    if (filled > 0) { nFill++; fillFrac += filled / S; mTrade += ((won ? 1 : 0) - P) * filled; mReb += REBATE_RATE * P * filled; if (won) mFilledWins++; }
  }
  const pct = (x: number, d: number) => d ? (100 * x / d).toFixed(0) + '%' : '—';
  console.log(`\n  signals (windows traded): ${nSig}`);
  console.log(`\n  -- MAKER (rest at bid) --`);
  console.log(`     fill rate: ${pct(nFill, nSig)}  (avg fill frac ${nFill ? (fillFrac / nFill).toFixed(2) : '—'})   filled-win: ${pct(mFilledWins, nFill)}`);
  console.log(`     trade P&L: $${mTrade.toFixed(2)}   + rebate $${mReb.toFixed(2)}   = NET $${(mTrade + mReb).toFixed(2)}`);
  console.log(`     per SIGNAL: trade ${(mTrade / nSig).toFixed(3)}  +reb ${(mReb / nSig).toFixed(3)}  = net $/sig ${((mTrade + mReb) / nSig).toFixed(3)}`);
  console.log(`\n  -- TAKER baseline (cross to ask, pay fee, no rebate) --`);
  console.log(`     fill rate: 100%   win: ${pct(tWins, nSig)}`);
  console.log(`     NET $${tNet.toFixed(2)}   ($/sig ${(tNet / nSig).toFixed(3)})`);
  console.log(`\n  (maker net $/sig > taker net $/sig => maker-ize the contrarian.)`);
  console.log(`========================================================\n`);
}
main().catch((e) => { console.error('contrarian-maker-sim fatal:', e?.message ?? e); process.exit(1); });
