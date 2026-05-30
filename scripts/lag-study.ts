/**
 * LAG STUDY — does the Polymarket binary price lag the Binance underlying, and is
 * that lag harvestable as a TAKER? (the strategy-redesign foundation, 2026-05-30)
 *
 * The matched-pair maker has no edge here (adverse selection: you only get filled
 * on the side that's losing). This study tests the INVERSE: consume liquidity only
 * when we have an informational edge — when the underlying has already moved but
 * the binary book hasn't caught up.
 *
 * For each window it reconstructs, from the YES + NO token books (with the
 * Binance price `btcPx` stamped on every snapshot):
 *   - S_open  : the underlying price at the window's official open (ttr≈windowSec)
 *   - cumret  : ln(px_now / S_open)  — how far the underlying has moved so far
 *   - fair_YES: Φ(cumret / σ√τ)      — driftless model probability of finishing Up
 *   - outcome : yesWon (per-token correct)
 *
 * Outputs:
 *   0. S_OPEN VALIDATION  — sign(px_end - S_open) vs yesWon agreement (sanity).
 *   1. CALIBRATION        — market mid vs realized win rate (favorite/longshot).
 *   2. LAG EDGE           — by (T-bin, cumret bucket): realized win% vs market
 *                           mid%. realized >> mid when underlying moved => book
 *                           lags => directional taker edge.
 *   3. TAKER BACKTEST     — enter once per window at T_enter seconds left when the
 *                           model beats the ask by a margin; hold to resolution;
 *                           net of taker fee. Reports hit%, $/trade, total.
 *
 *   npm run tsnode -- scripts/lag-study.ts [data/tape-*.jsonl] [--asset BNB]
 */
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface Snap { ts: number; ttr: number; bid: number | null; ask: number | null; px: number | null; r30: number | null }
interface Win {
  asset: string;
  conditionId: string;
  resolvesAt: number;
  windowSec: number;
  yesTok?: string;
  noTok?: string;
  yesWon?: boolean;
  yes: Snap[];
  no: Snap[];
}

const TAKER_FEE = 0.07; // fee/share = rate * p * (1-p)

// Standard normal CDF (Abramowitz-Stegun 7.1.26).
function Phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function tapes(): string[] {
  const raw = process.argv.slice(2);
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { i++; continue; } args.push(raw[i]); }
  if (args.length) return args.map((a) => resolve(a));
  const dir = resolve('data');
  return readdirSync(dir).filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl')).sort().map((f) => resolve(dir, f));
}
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const asset = argVal('--asset', 'BNB').toUpperCase();
  const wins = new Map<string, Win>(); // conditionId -> Win
  const tokCond = new Map<string, { cond: string; side: 'YES' | 'NO' }>();

  for (const path of tapes()) {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e.t === 'market') {
        if (e.asset !== asset) continue;
        let w = wins.get(e.conditionId);
        if (!w) { w = { asset: e.asset, conditionId: e.conditionId, resolvesAt: e.resolvesAt, windowSec: (e.windowMinutes ?? 5) * 60, yes: [], no: [] }; wins.set(e.conditionId, w); }
        if (e.side === 'YES') w.yesTok = e.tokenId; else w.noTok = e.tokenId;
        tokCond.set(e.tokenId, { cond: e.conditionId, side: e.side });
      } else if (e.t === 'resolution') {
        if (e.asset !== asset) continue;
        const tc = tokCond.get(e.tokenId); if (!tc) continue;
        const w = wins.get(tc.cond); if (!w) continue;
        if (typeof e.yesWon === 'boolean') w.yesWon = e.yesWon;
      } else if (e.t === 'book') {
        const tc = tokCond.get(e.tokenId); if (!tc) continue;
        const w = wins.get(tc.cond); if (!w || !w.resolvesAt) continue;
        const ttr = (w.resolvesAt - e.ts) / 1000;
        if (ttr < -5 || ttr > w.windowSec + 60) continue;
        const snap: Snap = { ts: e.ts, ttr, bid: typeof e.bid === 'number' ? e.bid : null, ask: typeof e.ask === 'number' ? e.ask : null, px: typeof e.btcPx === 'number' ? e.btcPx : null, r30: typeof e.btcR30 === 'number' ? e.btcR30 : null };
        (tc.side === 'YES' ? w.yes : w.no).push(snap);
      }
    }
  }

  // Keep only resolved windows with a usable YES book.
  const list = [...wins.values()].filter((w) => typeof w.yesWon === 'boolean' && w.yes.length > 5);
  for (const w of list) { w.yes.sort((a, b) => b.ttr - a.ttr); w.no.sort((a, b) => b.ttr - a.ttr); }

  // Estimate per-asset 30s-return vol from the YES snapshots' r30 series.
  const r30s: number[] = [];
  for (const w of list) for (const s of w.yes) if (s.r30 != null) r30s.push(s.r30);
  const meanR = r30s.reduce((a, b) => a + b, 0) / Math.max(1, r30s.length);
  const sigma30 = Math.sqrt(r30s.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, r30s.length - 1));

  // S_open per window = px at the snapshot whose ttr is closest to windowSec
  // (the official open), searching YES then NO snaps for a non-null px.
  function sOpen(w: Win): number | null {
    let best: { d: number; px: number } | null = null;
    for (const arr of [w.yes, w.no]) for (const s of arr) {
      if (s.px == null) continue;
      const d = Math.abs(s.ttr - w.windowSec);
      if (!best || d < best.d) best = { d, px: s.px };
    }
    return best ? best.px : null;
  }

  console.log(`\n================= LAG STUDY — ${asset} =================`);
  console.log(`resolved windows: ${list.length}   sigma30 (stdev of 30s return): ${(sigma30 * 100).toFixed(4)}%`);

  // ── 0. S_OPEN VALIDATION ────────────────────────────────────────────────────
  // If S_open is right, the sign of the FINAL cumulative move must match yesWon.
  let agree = 0, checked = 0;
  for (const w of list) {
    const so = sOpen(w); if (so == null) continue;
    const last = w.yes.filter((s) => s.px != null).slice(-1)[0]; if (!last || last.px == null) continue;
    const up = last.px > so;
    checked++; if (up === w.yesWon) agree++;
  }
  console.log(`\n── 0. S_OPEN VALIDATION ──  sign(px_end - S_open) == yesWon: ${(100 * agree / Math.max(1, checked)).toFixed(1)}%  (n=${checked})`);
  console.log(`   (high = S_open + underlying path are sound; the model rests on this.)`);

  // Build observation set: one rep per (window, T-bin) using the LAST snap in bin.
  const TBINS = [
    { label: '300-240', lo: 240, hi: 300 }, { label: '240-180', lo: 180, hi: 240 },
    { label: '180-120', lo: 120, hi: 180 }, { label: '120-60', lo: 60, hi: 120 },
    { label: '60-30', lo: 30, hi: 60 }, { label: '30-10', lo: 10, hi: 30 }, { label: '10-0', lo: 0, hi: 10 },
  ];
  const tbinOf = (ttr: number) => TBINS.findIndex((b) => ttr >= b.lo && ttr < b.hi);
  interface Obs { tbin: number; ttr: number; mid: number; yesAsk: number | null; yesBid: number | null; noAsk: number | null; cumret: number; fair: number; won: boolean }
  const obs: Obs[] = [];
  // index NO snaps by ~ttr for ask lookup
  for (const w of list) {
    const so = sOpen(w); if (so == null) continue;
    const rep = new Map<number, Snap>();
    for (const s of w.yes) { const bi = tbinOf(s.ttr); if (bi < 0 || s.px == null) continue; const cur = rep.get(bi); if (!cur || s.ttr < cur.ttr) rep.set(bi, s); }
    for (const [bi, s] of rep) {
      const bid = s.bid, ask = s.ask;
      let mid: number | null = null;
      if (bid != null && ask != null && ask > bid) mid = (bid + ask) / 2; else if (bid != null) mid = bid; else if (ask != null) mid = ask;
      if (mid == null || mid <= 0 || mid >= 1 || s.px == null) continue;
      const cumret = Math.log(s.px / so);
      const tau = Math.max(1, s.ttr);
      const sigTau = sigma30 * Math.sqrt(tau / 30);
      const fair = sigTau > 0 ? Phi(cumret / sigTau) : (cumret > 0 ? 1 : 0);
      // nearest NO snap for the NO ask (within 3s)
      let noAsk: number | null = null;
      let bestD = 3.0;
      for (const ns of w.no) { const d = Math.abs(ns.ttr - s.ttr); if (d < bestD && ns.ask != null) { bestD = d; noAsk = ns.ask; } }
      obs.push({ tbin: bi, ttr: s.ttr, mid, yesAsk: ask, yesBid: bid, noAsk, cumret, fair, won: !!w.yesWon });
    }
  }

  // ── 1. CALIBRATION (market mid vs realized) ─────────────────────────────────
  console.log(`\n── 1. CALIBRATION (YES mid vs realized win%; gap>0 at high price = favorites underpriced) ──`);
  const pool = new Map<number, { n: number; wins: number; sumP: number }>();
  for (const o of obs) { const pb = Math.min(9, Math.floor(o.mid * 10)); const c = pool.get(pb) ?? { n: 0, wins: 0, sumP: 0 }; c.n++; c.wins += o.won ? 1 : 0; c.sumP += o.mid; pool.set(pb, c); }
  for (let pb = 0; pb <= 9; pb++) { const c = pool.get(pb); if (!c || c.n < 10) continue; const real = 100 * c.wins / c.n, impl = 100 * c.sumP / c.n, gap = real - impl; console.log(`   mid ${(pb / 10).toFixed(1)}-${((pb + 1) / 10).toFixed(1)}: real ${real.toFixed(1)}%  impl ${impl.toFixed(1)}%  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}  n=${c.n}`); }

  // ── 2. LAG EDGE (cumret predicts beyond mid?) ───────────────────────────────
  console.log(`\n── 2. LAG EDGE — by T-bin × underlying move since open; realized win% vs market mid% ──`);
  console.log(`   cumret buckets: DOWN(<-0.05%)  FLAT(±0.05%)  UP(>+0.05%).  edge = realized - mid.`);
  const CR = 0.0005;
  for (let tb = 0; tb < TBINS.length; tb++) {
    const g = { up: { n: 0, w: 0, p: 0 }, flat: { n: 0, w: 0, p: 0 }, down: { n: 0, w: 0, p: 0 } };
    for (const o of obs) { if (o.tbin !== tb) continue; const k = o.cumret > CR ? g.up : o.cumret < -CR ? g.down : g.flat; k.n++; k.w += o.won ? 1 : 0; k.p += o.mid; }
    const f = (x: { n: number; w: number; p: number }) => x.n < 8 ? `n=${x.n}`.padEnd(34) : `real ${(100 * x.w / x.n).toFixed(0)}% mid ${(100 * x.p / x.n).toFixed(0)}% edge ${(100 * (x.w / x.n - x.p / x.n) >= 0 ? '+' : '')}${(100 * (x.w / x.n - x.p / x.n)).toFixed(1)} (n=${x.n})`.padEnd(34);
    if (g.up.n + g.flat.n + g.down.n < 12) continue;
    console.log(`   ${TBINS[tb].label.padEnd(8)} UP:  ${f(g.up)}`);
    console.log(`   ${''.padEnd(8)} DN:  ${f(g.down)}`);
  }

  // ── 3. TAKER BACKTEST ───────────────────────────────────────────────────────
  // Enter ONCE per window at the snapshot nearest T_enter seconds left. If the
  // model fair beats the side's ASK by >= margin (after fee), take that side and
  // hold to resolution. PnL/share = (won?1:0) - ask - fee.  fee = rate*ask*(1-ask).
  console.log(`\n── 3. TAKER BACKTEST (enter once/window at T_enter; hold to resolution; net of fee) ──`);
  function nearestSnap(w: Win, arr: Snap[], tEnter: number): Snap | null {
    let best: Snap | null = null, bd = 8;
    for (const s of arr) { const d = Math.abs(s.ttr - tEnter); if (d < bd && s.px != null) { bd = d; best = s; } }
    return best;
  }
  const so2 = new Map<string, number | null>();
  for (const w of list) so2.set(w.conditionId, sOpen(w));
  // band: [askLo, askHi] restricts trades to a price range (avoid the longshot
  // trap of buying cheap dead sides). flip column = PnL of taking the OPPOSITE
  // side (tests a contrarian/fade edge). avgAsk/avgFair diagnose what it buys.
  for (const band of [[0.01, 0.99], [0.30, 0.70]] as const) {
    console.log(`\n   --- ask band ${band[0]}-${band[1]} ---`);
    for (const tEnter of [120, 90, 60, 45, 30, 20]) {
      for (const margin of [0.02, 0.05]) {
        let trades = 0, hits = 0, pnl = 0, invested = 0, flipPnl = 0, sumAsk = 0, sumFair = 0;
        for (const w of list) {
          const so = so2.get(w.conditionId); if (so == null) continue;
          const ys = nearestSnap(w, w.yes, tEnter); if (!ys || ys.px == null) continue;
          if (Math.abs(ys.ttr - tEnter) > 8) continue;
          const tau = Math.max(1, ys.ttr); const sigTau = sigma30 * Math.sqrt(tau / 30);
          const cumret = Math.log(ys.px / so); const fairY = sigTau > 0 ? Phi(cumret / sigTau) : (cumret > 0 ? 1 : 0);
          const yAsk = ys.ask;
          const ns = nearestSnap(w, w.no, ys.ttr); const nAsk = ns?.ask ?? null;
          const fairN = 1 - fairY;
          let take: { side: 'YES' | 'NO'; ask: number; fair: number } | null = null;
          if (yAsk != null && yAsk >= band[0] && yAsk <= band[1]) { const fee = TAKER_FEE * yAsk * (1 - yAsk); if (fairY - yAsk - fee >= margin) take = { side: 'YES', ask: yAsk, fair: fairY }; }
          if (nAsk != null && nAsk >= band[0] && nAsk <= band[1]) { const fee = TAKER_FEE * nAsk * (1 - nAsk); if (fairN - nAsk - fee >= margin) { const edge = fairN - nAsk - fee; if (!take || edge > (take.fair - take.ask)) take = { side: 'NO', ask: nAsk, fair: fairN }; } }
          if (!take) continue;
          const fee = TAKER_FEE * take.ask * (1 - take.ask);
          const wonSide = take.side === 'YES' ? w.yesWon : !w.yesWon;
          const ret = (wonSide ? 1 : 0) - take.ask - fee;
          // flip: buy the OTHER token at ITS ask (approx with 1-ask if unknown)
          const otherAsk = take.side === 'YES' ? (nAsk ?? 1 - take.ask) : (yAsk ?? 1 - take.ask);
          const oFee = TAKER_FEE * otherAsk * (1 - otherAsk);
          flipPnl += ((!wonSide) ? 1 : 0) - otherAsk - oFee;
          trades++; if (wonSide) hits++; pnl += ret; invested += take.ask; sumAsk += take.ask; sumFair += take.fair;
        }
        if (trades < 3) continue;
        console.log(`   T=${String(tEnter).padStart(3)}s m=${(margin * 100).toFixed(0)}%: trades=${String(trades).padStart(3)} hit=${(100 * hits / trades).toFixed(0)}% $/tr=${(pnl / trades).toFixed(3)} flip$/tr=${(flipPnl / trades).toFixed(3)} avgAsk=${(sumAsk / trades).toFixed(2)} avgFair=${(sumFair / trades).toFixed(2)}`);
      }
    }
  }
  console.log(`\n   ($/tr = per 1-share clip held to resolution. flip = opposite side. Look for ANY robust + column.)`);

  // ── 4. FAVORITE-BIAS BACKTEST ───────────────────────────────────────────────
  // The calibration says favorites win MORE than priced. Test it directly: at
  // T_enter, BUY the market's FAVORITE (mid > 0.5+conv) at its ASK, hold to
  // resolution, net of taker fee. No model — pure "back the book's favorite".
  console.log(`\n── 4. FAVORITE-BIAS BACKTEST (buy the favorite at ask; hold to resolution; net fee) ──`);
  for (const tEnter of [150, 120, 90, 60, 45, 30]) {
    for (const conv of [0.10, 0.20, 0.30]) {
      let trades = 0, hits = 0, pnl = 0, invested = 0;
      for (const w of list) {
        const ys = nearestSnap(w, w.yes, tEnter); if (!ys) continue;
        if (Math.abs(ys.ttr - tEnter) > 10) continue;
        const yBid = ys.bid, yAsk = ys.ask; if (yBid == null || yAsk == null || yAsk <= yBid) continue;
        const yMid = (yBid + yAsk) / 2;
        const ns = nearestSnap(w, w.no, ys.ttr);
        let side: 'YES' | 'NO' | null = null, ask = 0;
        if (yMid >= 0.5 + conv) { side = 'YES'; ask = yAsk; }
        else if (yMid <= 0.5 - conv && ns?.ask != null) { side = 'NO'; ask = ns.ask; }
        if (!side || ask <= 0.01 || ask >= 0.999) continue;
        const fee = TAKER_FEE * ask * (1 - ask);
        const wonSide = side === 'YES' ? w.yesWon : !w.yesWon;
        pnl += (wonSide ? 1 : 0) - ask - fee; invested += ask; trades++; if (wonSide) hits++;
      }
      if (trades < 5) continue;
      const roi = 100 * pnl / Math.max(1e-9, invested);
      console.log(`   T=${String(tEnter).padStart(3)}s conv>=${(conv * 100).toFixed(0)}%: trades=${String(trades).padStart(3)} hit=${(100 * hits / trades).toFixed(0)}% total=$${pnl.toFixed(2).padStart(6)} $/tr=${(pnl / trades).toFixed(3)} ROI=${roi.toFixed(1)}%`);
    }
  }
  console.log(`\n   (Positive $/tr + ROI robust across T/conv = favorite-bias edge is real & harvestable.)`);
  console.log(`========================================================\n`);
}

main().catch((e) => { console.error('lag-study fatal:', e?.message ?? e); process.exit(1); });
