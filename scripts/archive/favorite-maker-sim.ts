/**
 * FAVORITE HARVESTER — maker-fill simulation (2026-05-30).
 *
 * The taker backtest (lag-study.ts §4) showed buying the book's FAVORITE and
 * holding to resolution is +EV after the taker fee on DOGE/XRP. This asks the
 * follow-up that decides the whole strategy design: if instead of crossing to
 * the ASK we rest a passive BUY at the favorite's BID (maker, no fee here since
 * feeTakerOnly=true), does the edge ~double — or does adverse selection (we only
 * fill when the favorite is being SOLD into, i.e. dipping) kill it?
 *
 * Fill model (conservative on queue, uses real book depth + the trade tape):
 *   - At T_enter, the favorite = the side with mid >= 0.5+conv. Place S shares at
 *     price P = bestBid (+optional tick). Queue ahead = bestBid size at that
 *     instant (we join the back).
 *   - Walk the token's trades to resolution. Every SELL-aggressor print at
 *     price <= P consumes bid liquidity at/through P; accumulate its size V.
 *     We fill once V exceeds the queue, then fill our S from the remainder.
 *   - A favorite that RUNS UP generates few sells at P -> we don't fill (we miss
 *     the easy win). A favorite that DIPS gets hit -> we fill (adverse select).
 *   - Filled shares settle 1 if the side wins else 0. PnL/sh = settle - P (no fee).
 *
 * Compares maker $/window to the taker baseline ($/window = taker$/trade since
 * the taker always fills).
 *
 *   npm run tsnode -- scripts/favorite-maker-sim.ts [tape...] [--asset DOGE]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const TAKER_FEE = 0.07;
const TICK = 0.01;

interface Snap { ts: number; ttr: number; bid: number | null; bidSz: number | null; ask: number | null }
interface Trade { ts: number; price: number; size: number; side: 'BUY' | 'SELL' }
interface Win { conditionId: string; resolvesAt: number; windowSec: number; yesWon?: boolean;
  yesSnaps: Snap[]; noSnaps: Snap[]; yesTrades: Trade[]; noTrades: Trade[] }

function tapes(): string[] {
  const raw = process.argv.slice(2); const args: string[] = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { i++; continue; } args.push(raw[i]); }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
function argVal(flag: string, def: string): string { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }

async function main(): Promise<void> {
  const asset = argVal('--asset', 'DOGE').toUpperCase();
  const wins = new Map<string, Win>();
  const tok = new Map<string, { cond: string; side: 'YES' | 'NO' }>();

  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (e.asset !== asset) continue;
        let w = wins.get(e.conditionId);
        if (!w) { w = { conditionId: e.conditionId, resolvesAt: e.resolvesAt, windowSec: (e.windowMinutes ?? 5) * 60, yesSnaps: [], noSnaps: [], yesTrades: [], noTrades: [] }; wins.set(e.conditionId, w); }
        tok.set(e.tokenId, { cond: e.conditionId, side: e.side });
      } else if (e.t === 'resolution') {
        if (e.asset !== asset) continue; const tc = tok.get(e.tokenId); if (!tc) continue;
        const w = wins.get(tc.cond); if (w && typeof e.yesWon === 'boolean') w.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (!w) continue;
        const ttr = (w.resolvesAt - e.ts) / 1000; if (ttr < -5 || ttr > w.windowSec + 60) continue;
        const s: Snap = { ts: e.ts, ttr, bid: typeof e.bid === 'number' ? e.bid : null, bidSz: typeof e.bidSz === 'number' ? e.bidSz : null, ask: typeof e.ask === 'number' ? e.ask : null };
        (tc.side === 'YES' ? w.yesSnaps : w.noSnaps).push(s);
      } else if (e.t === 'trade') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond); if (!w) continue;
        if (typeof e.price !== 'number' || typeof e.size !== 'number') continue;
        const tr: Trade = { ts: e.ts, price: e.price, size: e.size, side: e.side === 'SELL' ? 'SELL' : 'BUY' };
        (tc.side === 'YES' ? w.yesTrades : w.noTrades).push(tr);
      }
    }
  }

  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yesSnaps.length > 5);
  for (const w of list) { w.yesSnaps.sort((a, b) => b.ttr - a.ttr); w.noSnaps.sort((a, b) => b.ttr - a.ttr); w.yesTrades.sort((a, b) => a.ts - b.ts); w.noTrades.sort((a, b) => a.ts - b.ts); }
  console.log(`\n============ FAVORITE MAKER SIM — ${asset} ============`);
  console.log(`resolved windows: ${list.length}   (S=5 sh/window, hold to resolution, maker fee=0)`);

  const S = 5; // clip size
  function nearest(arr: Snap[], tEnter: number): Snap | null { let b: Snap | null = null, bd = 10; for (const s of arr) { const d = Math.abs(s.ttr - tEnter); if (d < bd) { bd = d; b = s; } } return b; }

  for (const tEnter of [120, 90, 60]) {
    for (const conv of [0.10, 0.20]) {
      for (const improve of [0, 1]) { // 0 = join bid, 1 = bid+1 tick (more aggressive)
        let nWin = 0, nFilled = 0, fillFracSum = 0, makerPnl = 0, takerPnl = 0, filledWins = 0, takerWins = 0;
        for (const w of list) {
          const ys = nearest(w.yesSnaps, tEnter); if (!ys || ys.bid == null || ys.ask == null || ys.ask <= ys.bid) continue;
          const yMid = (ys.bid + ys.ask) / 2;
          let side: 'YES' | 'NO' | null = null;
          if (yMid >= 0.5 + conv) side = 'YES'; else if (yMid <= 0.5 - conv) side = 'NO';
          if (!side) continue;
          const snap = side === 'YES' ? ys : nearest(w.noSnaps, ys.ttr);
          if (!snap || snap.bid == null || snap.ask == null || snap.bidSz == null) continue;
          const trades = side === 'YES' ? w.yesTrades : w.noTrades;
          const won = side === 'YES' ? w.yesWon : !w.yesWon;
          const P = Math.min(snap.ask - TICK, snap.bid + improve * TICK); // don't cross the ask
          if (P <= 0.01 || P >= 0.99) continue;
          const queueAhead = snap.bidSz; // optimistic: we sit behind the whole displayed bid
          // walk trades after placement; SELL prints at price<=P consume our level
          let vol = 0, filled = 0;
          for (const tr of trades) {
            if (tr.ts < snap.ts) continue;
            if (tr.side === 'SELL' && tr.price <= P + 1e-9) {
              vol += tr.size;
              const past = vol - queueAhead;
              if (past > 0) filled = Math.min(S, past);
            }
            if (filled >= S) break;
          }
          // taker baseline: always fills S at the ask, pays fee
          const takerAsk = snap.ask; const tFee = TAKER_FEE * takerAsk * (1 - takerAsk);
          const takerRet = ((won ? 1 : 0) - takerAsk - tFee) * S;
          nWin++; takerPnl += takerRet; if (won) takerWins++;
          if (filled > 0) { nFilled++; fillFracSum += filled / S; makerPnl += ((won ? 1 : 0) - P) * filled; if (won) filledWins++; }
        }
        if (nWin < 5) continue;
        const fillRate = 100 * nFilled / nWin;
        const avgFrac = nFilled ? fillFracSum / nFilled : 0;
        const makerPerWin = makerPnl / nWin; const takerPerWin = takerPnl / nWin;
        const filledWinRate = nFilled ? 100 * filledWins / nFilled : 0;
        const takerWinRate = 100 * takerWins / nWin;
        const tag = improve ? 'bid+1' : 'bid  ';
        console.log(`   T=${String(tEnter).padStart(3)}s conv${(conv * 100).toFixed(0)}% @${tag}: fills ${fillRate.toFixed(0)}%(frac ${avgFrac.toFixed(2)}) winFilled ${filledWinRate.toFixed(0)}% vs winTaker ${takerWinRate.toFixed(0)}% | MAKER $/win ${makerPerWin.toFixed(3)}  TAKER $/win ${takerPerWin.toFixed(3)}`);
      }
    }
  }
  console.log(`\n   MAKER$/win > TAKER$/win and fills high => quote passively. fills low / winFilled<<winTaker => adverse selection; stay taker.`);
  console.log(`==========================================================\n`);
}
main().catch((e) => { console.error('favorite-maker-sim fatal:', e?.message ?? e); process.exit(1); });
