/**
 * Edge-discovery study (NO strategy simulation). Answers the two questions that
 * partition the entire strategy space for BTC short-duration markets:
 *
 *   STUDY 1 — CALIBRATION: is the Polymarket price efficient, or is there a
 *     structural mispricing to harvest? For each (time-to-resolve, price) bucket
 *     we compare the implied probability (the YES mid) to the REALIZED win rate.
 *     A diagonal = efficient (no static edge). Tails off the diagonal =
 *     favorite-longshot bias (a known, robust prediction-market anomaly):
 *       - favorites (high price) winning MORE than priced  -> buy favorites
 *       - longshots (low price) winning LESS than priced    -> fade longshots
 *     Near the close, low-fee (p(1-p) small) + low-variance = ideal harvest.
 *
 *   STUDY 2 — SIGNAL: does the Binance 30s return (btcR30) predict the outcome
 *     BEYOND what the price already implies? Controlling for price (only the
 *     uncertain 0.35-0.65 band), we split by the sign of btcR30 and compare the
 *     realized win rate to the mean implied price. realized > implied when
 *     btcR30 > 0 => the book has NOT fully absorbed the move => directional edge.
 *
 * If neither study shows a persistent gap beyond fees, no directional/structural
 * edge exists here and the honest conclusion is: don't trade these markets.
 *
 *   npm run tsnode -- scripts/edge-study.ts [data/tape-*.jsonl] [--asset BTC]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface Snap { ttr: number; price: number; r30: number | null }
interface Tok { asset: string; resolvesAt: number; yesWon?: boolean; snaps: Snap[] }

// time-to-resolve bins (seconds), wide→narrow toward the close
const TBINS = [
  { label: 'T-300..240', lo: 240, hi: 300 },
  { label: 'T-240..180', lo: 180, hi: 240 },
  { label: 'T-180..120', lo: 120, hi: 180 },
  { label: 'T-120..60', lo: 60, hi: 120 },
  { label: 'T-60..30', lo: 30, hi: 60 },
  { label: 'T-30..10', lo: 10, hi: 30 },
  { label: 'T-10..0', lo: 0, hi: 10 },
];
const tbinOf = (ttr: number) => TBINS.findIndex((b) => ttr >= b.lo && ttr < b.hi);
const priceBinOf = (p: number) => Math.min(9, Math.max(0, Math.floor(p * 10))); // 0..9 => [0,0.1)..[0.9,1]

function tapes(): string[] {
  const raw = process.argv.slice(2);
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) { i++; continue; } // skip flag AND its value
    args.push(raw[i]);
  }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const asset = argVal('--asset', 'BTC').toUpperCase();
  const toks = new Map<string, Tok>();

  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (e.asset !== asset) continue;
        const t = toks.get(e.tokenId) ?? { asset: e.asset, resolvesAt: 0, snaps: [] };
        t.resolvesAt = e.resolvesAt ?? t.resolvesAt;
        toks.set(e.tokenId, t);
      } else if (e.t === 'resolution') {
        const t = toks.get(e.tokenId);
        if (t && typeof e.yesWon === 'boolean') t.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const t = toks.get(e.tokenId);
        if (!t || t.resolvesAt <= 0) continue;
        const bid = typeof e.bid === 'number' ? e.bid : null;
        const ask = typeof e.ask === 'number' ? e.ask : null;
        let price: number | null = null;
        if (bid && ask && ask > bid) price = (bid + ask) / 2;
        else if (bid) price = bid;
        else if (ask) price = ask;
        if (price === null || price <= 0 || price >= 1) continue;
        const ttr = (t.resolvesAt - e.ts) / 1000;
        if (ttr < 0 || ttr > 300) continue;
        t.snaps.push({ ttr, price, r30: typeof e.btcR30 === 'number' ? e.btcR30 : null });
      }
    }
  }

  // One representative observation per (token, T-bin): the LAST snapshot in the
  // bin (closest to the bin's near-resolve edge). Balances windows that have
  // thousands of book updates against those with few.
  interface Obs { tbin: number; price: number; r30: number | null; won: boolean }
  const obs: Obs[] = [];
  let resolvedToks = 0;
  for (const t of toks.values()) {
    if (typeof t.yesWon !== 'boolean') continue;
    resolvedToks++;
    const rep = new Map<number, Snap>(); // tbin -> last snap
    for (const s of t.snaps) {
      const bi = tbinOf(s.ttr);
      if (bi < 0) continue;
      const cur = rep.get(bi);
      // "last in bin" = smallest ttr (closest to resolution)
      if (!cur || s.ttr < cur.ttr) rep.set(bi, s);
    }
    for (const [bi, s] of rep) obs.push({ tbin: bi, price: s.price, r30: s.r30, won: t.yesWon });
  }

  console.log(`\n========== EDGE STUDY — ${asset} ==========`);
  console.log(`resolved windows: ${resolvedToks}   observations (window×T-bin): ${obs.length}`);

  // ── STUDY 1: CALIBRATION (implied price vs realized win rate) ───────────────
  console.log(`\n── STUDY 1: CALIBRATION  (implied vs realized; gap = mispricing edge) ──`);
  console.log(`  rows = price bucket; for each T-bin: realized win% (n).  "impl" = mean price in bucket.`);
  // accumulate per (tbin, priceBin): n, wins, sumPrice
  const cal = new Map<string, { n: number; wins: number; sumP: number }>();
  for (const o of obs) {
    const k = `${o.tbin}|${priceBinOf(o.price)}`;
    const c = cal.get(k) ?? { n: 0, wins: 0, sumP: 0 };
    c.n++; c.wins += o.won ? 1 : 0; c.sumP += o.price;
    cal.set(k, c);
  }
  // header
  const hdr = ['price'.padEnd(10)].concat(TBINS.map((b) => b.label.replace('T-', '').padStart(12))).join('');
  console.log('  ' + hdr);
  for (let pb = 0; pb <= 9; pb++) {
    const row = [`${(pb / 10).toFixed(1)}-${((pb + 1) / 10).toFixed(1)}`.padEnd(10)];
    for (let tb = 0; tb < TBINS.length; tb++) {
      const c = cal.get(`${tb}|${pb}`);
      if (!c || c.n < 8) { row.push(''.padStart(12)); continue; }
      const real = (100 * c.wins / c.n);
      const impl = (100 * c.sumP / c.n);
      const gap = real - impl;
      const cell = `${real.toFixed(0)}/${impl.toFixed(0)}${gap >= 0 ? '+' : ''}${gap.toFixed(0)}(${c.n})`;
      row.push(cell.padStart(12));
    }
    console.log('  ' + row.join(''));
  }
  console.log(`  cell = realized% / implied% gap (n). Positive gap at high price = favorites underpriced (buy);`);
  console.log(`  negative gap at low price = longshots overpriced (fade). Blanks = n<8.`);

  // Aggregate favorite-longshot summary across all T-bins.
  console.log(`\n  -- Favorite/longshot summary (all T-bins pooled) --`);
  const pool = new Map<number, { n: number; wins: number; sumP: number }>();
  for (const o of obs) {
    const pb = priceBinOf(o.price);
    const c = pool.get(pb) ?? { n: 0, wins: 0, sumP: 0 };
    c.n++; c.wins += o.won ? 1 : 0; c.sumP += o.price; pool.set(pb, c);
  }
  for (let pb = 0; pb <= 9; pb++) {
    const c = pool.get(pb); if (!c || c.n < 10) continue;
    const real = 100 * c.wins / c.n, impl = 100 * c.sumP / c.n, gap = real - impl;
    const bar = gap >= 0 ? '+'.repeat(Math.min(20, Math.round(Math.abs(gap)))) : '-'.repeat(Math.min(20, Math.round(Math.abs(gap))));
    console.log(`   price ${(pb / 10).toFixed(1)}-${((pb + 1) / 10).toFixed(1)}: real ${real.toFixed(1)}%  impl ${impl.toFixed(1)}%  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}  n=${c.n}  ${bar}`);
  }

  // ── STUDY 2: SIGNAL (does btcR30 predict beyond the price?) ─────────────────
  console.log(`\n── STUDY 2: SIGNAL  (btcR30 predictive power in the uncertain 0.35-0.65 band) ──`);
  const THR = 0.0003; // sniper's signal threshold (0.03% / 30s)
  for (let tb = 0; tb < TBINS.length; tb++) {
    const groups = { up: { n: 0, wins: 0, sumP: 0 }, flat: { n: 0, wins: 0, sumP: 0 }, down: { n: 0, wins: 0, sumP: 0 } };
    for (const o of obs) {
      if (o.tbin !== tb || o.r30 === null) continue;
      if (o.price < 0.35 || o.price > 0.65) continue;
      const g = o.r30 >= THR ? groups.up : o.r30 <= -THR ? groups.down : groups.flat;
      g.n++; g.wins += o.won ? 1 : 0; g.sumP += o.price;
    }
    const fmt = (g: { n: number; wins: number; sumP: number }) =>
      g.n < 8 ? `n=${g.n}` : `real ${(100 * g.wins / g.n).toFixed(0)}% vs impl ${(100 * g.sumP / g.n).toFixed(0)}% (edge ${(100 * (g.wins / g.n - g.sumP / g.n) >= 0 ? '+' : '')}${(100 * (g.wins / g.n - g.sumP / g.n)).toFixed(0)}, n=${g.n})`;
    if (groups.up.n + groups.down.n + groups.flat.n < 12) continue;
    console.log(`  ${TBINS[tb].label}:`);
    console.log(`     R30>+${THR}: ${fmt(groups.up)}`);
    console.log(`     |R30|<thr : ${fmt(groups.flat)}`);
    console.log(`     R30<-${THR}: ${fmt(groups.down)}`);
  }
  console.log(`\n  Edge>0 in the R30>+thr row (and edge<0 in R30<-thr) = Binance move predicts beyond price.`);
  console.log(`  Fee hurdle to BEAT as a taker near p=0.5: ~${(100 * 0.07 * 0.25).toFixed(1)}% per share. Edge must exceed that.`);
  console.log(`\n===================================================\n`);
}

main().catch((e) => { console.error('edge-study fatal:', e?.message ?? e); process.exit(1); });
