/**
 * ALL-YES + LOSS-CUT simulation (2026-05-31). User hypothesis: bet YES (Up) on
 * EVERY window and cut the loss when it is "clearly losing", betting on a bull
 * regime. Tests it on the 2-day tape (which was actually ~48.8% UP — NOT bullish,
 * so this is the hard/balanced regime).
 *
 * Per window:
 *   - ENTER YES (taker) at the ask, near window open (ttr ≈ entrySec).
 *   - CUT if the YES bid falls to/below the cut threshold C at any later snapshot
 *     (sell YES taker at that bid) — caps the loss but risks whipsaw (cutting a
 *     window that would have rebounded to win).
 *   - else HOLD to resolution: settle 1 if yesWon else 0.
 *   PnL/share = exit - entry - fees.  Taker fee/share = rate * p*(1-p), paid on
 *   the entry buy and (if cut) the exit sell; a held winner redeems with no exit fee.
 *
 *   npm run tsnode -- scripts/all-yes-cut-sim.ts [tape...] [--asset BNB]   (omit --asset => pooled over all)
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const FEE = 0.07;
const fee = (p: number) => FEE * p * (1 - p);

interface Snap { ttr: number; bid: number | null; ask: number | null }
interface Win { asset: string; cond: string; resolvesAt: number; windowSec: number; yesWon?: boolean; yes: Snap[] }

function tapes(): string[] {
  const raw = process.argv.slice(2); const args: string[] = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { i++; continue; } args.push(raw[i]); }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
const argVal = (flag: string, def: string) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };

async function main(): Promise<void> {
  const assetFilter = process.argv.includes('--asset') ? argVal('--asset', '').toUpperCase() : null;
  const wins = new Map<string, Win>();
  const tok = new Map<string, { cond: string; side: 'YES' | 'NO' }>();

  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (assetFilter && e.asset !== assetFilter) continue;
        let w = wins.get(e.conditionId);
        if (!w) { w = { asset: e.asset, cond: e.conditionId, resolvesAt: e.resolvesAt, windowSec: (e.windowMinutes ?? 5) * 60, yes: [] }; wins.set(e.conditionId, w); }
        tok.set(e.tokenId, { cond: e.conditionId, side: e.side });
      } else if (e.t === 'resolution') {
        const tc = tok.get(e.tokenId); if (!tc) continue; const w = wins.get(tc.cond);
        if (w && typeof e.yesWon === 'boolean') w.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const tc = tok.get(e.tokenId); if (!tc || tc.side !== 'YES') continue; const w = wins.get(tc.cond); if (!w) continue;
        const ttr = (w.resolvesAt - e.ts) / 1000; if (ttr < -5 || ttr > w.windowSec + 60) continue;
        w.yes.push({ ttr, bid: typeof e.bid === 'number' ? e.bid : null, ask: typeof e.ask === 'number' ? e.ask : null });
      }
    }
  }
  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yes.length > 5);
  for (const w of list) w.yes.sort((a, b) => b.ttr - a.ttr);
  const label = assetFilter ?? 'POOLED (all assets)';
  console.log(`\n===== ALL-YES + LOSS-CUT — ${label} =====`);
  console.log(`resolved windows: ${list.length}   UP rate: ${(100 * list.filter((w) => w.yesWon).length / list.length).toFixed(1)}%   (clip = 1 share)`);

  const nearest = (w: Win, t: number): Snap | null => { let b: Snap | null = null, bd = 12; for (const s of w.yes) { const d = Math.abs(s.ttr - t); if (d < bd && s.ask != null && s.bid != null) { bd = d; b = s; } } return b; };

  for (const entrySec of [285, 270, 240]) {
    console.log(`\n  -- enter YES at ttr≈${entrySec}s --`);
    // baseline: no cut (pure all-YES hold to resolution)
    {
      let n = 0, win = 0, pnl = 0, invested = 0;
      for (const w of list) {
        const en = nearest(w, entrySec); if (!en || en.ask == null) continue;
        const entry = en.ask; if (entry <= 0.02 || entry >= 0.98) continue;
        const ex = w.yesWon ? 1 : 0;
        pnl += ex - entry - fee(entry); invested += entry; n++; if (w.yesWon) win++;
      }
      if (n) console.log(`     NO-CUT (hold):        trades=${n} win=${(100 * win / n).toFixed(0)}% avgEntry=${(invested / n).toFixed(2)} total=$${pnl.toFixed(2)} $/tr=${(pnl / n).toFixed(3)} ROI=${(100 * pnl / invested).toFixed(1)}%`);
    }
    for (const C of [0.35, 0.30, 0.25, 0.20, 0.15]) {
      let n = 0, win = 0, pnl = 0, invested = 0, cuts = 0, cutWasRight = 0;
      for (const w of list) {
        const en = nearest(w, entrySec); if (!en || en.ask == null) continue;
        const entry = en.ask; if (entry <= 0.02 || entry >= 0.98) continue;
        // walk forward from entry; cut the first time bid <= C
        let cut = false, exit = 0, exitFee = 0;
        for (const s of w.yes) {
          if (s.ttr >= en.ttr) continue; // strictly after entry
          if (s.bid != null && s.bid <= C) { cut = true; exit = s.bid; exitFee = fee(s.bid); break; }
        }
        if (!cut) { exit = w.yesWon ? 1 : 0; exitFee = 0; }
        pnl += exit - entry - fee(entry) - exitFee; invested += entry; n++;
        if (!cut && w.yesWon) win++;
        if (cut) { cuts++; if (!w.yesWon) cutWasRight++; }
      }
      if (n) console.log(`     cut@${C.toFixed(2)}:             trades=${n} held-win=${(100 * win / n).toFixed(0)}% cut=${(100 * cuts / n).toFixed(0)}%(right ${cuts ? (100 * cutWasRight / cuts).toFixed(0) : 0}%) total=$${pnl.toFixed(2)} $/tr=${(pnl / n).toFixed(3)} ROI=${(100 * pnl / invested).toFixed(1)}%`);
    }
  }
  console.log(`\n  ($/tr per 1-share clip. cut "right" = the window did finish DOWN (cut avoided a full loss).`);
  console.log(`   NO-CUT is the pure all-YES bet; compare cuts vs it to see if cutting helps or whipsaws.)`);
  console.log(`========================================================\n`);
}
main().catch((e) => { console.error('all-yes-cut-sim fatal:', e?.message ?? e); process.exit(1); });
