/**
 * Phase B — Simulator / backtester.
 *
 * Replays a recorded tape (scripts/recorder.ts output) through the pure quoting
 * engine and a conservative fill model, then reports P&L and risk metrics. Use
 * it to decide whether the maker strategy is profitable and to calibrate
 * `half_spread` before any live bot is written.
 *
 *   npm run simulate                       # newest tape in data/, sweep half_spread
 *   npm run simulate -- data/tape-X.jsonl  # specific tape
 *   npm run simulate -- --spread 0.03      # single half_spread, no sweep
 *
 * FILL MODEL (conservative): on each book update we recompute our resting
 * quotes. For each real trade print, if its price crosses our live bid (price
 * <= bid) we buy at our bid; if it crosses our ask (price >= ask) we sell at
 * our ask; trades inside our spread do not fill. We never fill more than the
 * real traded size, and a quote's size is consumed across trades until the next
 * book update refreshes it. Residual inventory after the hybrid flatten is
 * marked at the last observed mid (documented approximation).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBotYaml, type MakerConfig } from '../src/util/config.js';
import { computeQuotes } from '../src/engine/quoter.js';
import {
  emptyInventory,
  applyFill,
  closeGate,
  inventoryUsd,
  type InventoryState,
} from '../src/engine/inventory.js';

interface TapeEvent {
  t: 'market' | 'book' | 'trade' | 'resolution';
  ts: number;
  tokenId: string;
  // market
  asset?: string;
  resolvesAt?: number;
  question?: string;
  // book
  bid?: number | null;
  ask?: number | null;
  bidSz?: number | null; // top-of-book size (queue-ahead proxy)
  askSz?: number | null;
  // trade
  price?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
  // resolution
  yesWon?: boolean;
  // shared
  btcR30?: number | null;
}

interface Window {
  tokenId: string;
  asset: string;
  resolvesAt: number;
  /** Actual resolution if captured: true = Up/YES won. undefined = unknown. */
  yesWon?: boolean;
  /** Per-market economics from the market line. */
  feeRate: number;
  rebateRate: number;
  /** Realized BTC volatility proxy (mean |btcR30| over the window). */
  vol: number;
  volBucket: 'low' | 'mid' | 'high';
  events: TapeEvent[];
}

interface SimMetrics {
  windows: number;
  totalPnl: number;
  grossSpreadPnl: number; // P&L before rebate (spread/settlement only)
  rebatesEarned: number; // modeled maker-rebate income
  fills: number;
  buyShares: number;
  sellShares: number;
  meanAbsInvUsd: number;
  maxAbsInvUsd: number;
  pulledQuotes: number;
  widenedQuotes: number;
  flattens: number;
  heldResiduals: number;
  outcomeSettled: number; // windows whose residual was settled at real 0/1
  takerFeesPaid: number; // total taker fees paid on flatten orders
  byAsset: Map<string, { pnl: number; windows: number }>;
  byHour: Map<number, { pnl: number; windows: number }>;
  byVol: Map<string, { pnl: number; windows: number }>;
  /** Peak / mean total capital deployed across concurrently-active windows. */
  peakConcurrentUsd: number;
  meanConcurrentUsd: number;
  pnls: number[]; // per-window
}

const DEFAULT_FEE_RATE = 0.07;
const DEFAULT_REBATE_RATE = 0.2;

function allTapes(): string[] {
  const dir = resolve('data');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) throw new Error('No tape-*.jsonl files in data/. Run `npm run record` first.');
  return files.map((f) => resolve(dir, f));
}

function loadWindows(paths: string[]): Window[] {
  const byToken = new Map<string, Window>();
  for (const path of paths) ingestTape(path, byToken);
  // Keep only windows with a resolve time and at least some activity.
  return [...byToken.values()].filter((w) => w.resolvesAt > 0 && w.events.length > 0);
}

function ingestTape(path: string, byToken: Map<string, Window>): void {
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: TapeEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.t === 'market') {
      const e = ev as any;
      if (!byToken.has(ev.tokenId)) {
        byToken.set(ev.tokenId, {
          tokenId: ev.tokenId,
          asset: ev.asset ?? '?',
          resolvesAt: ev.resolvesAt ?? 0,
          feeRate: typeof e.feeRate === 'number' ? e.feeRate : DEFAULT_FEE_RATE,
          rebateRate: typeof e.rebateRate === 'number' ? e.rebateRate : DEFAULT_REBATE_RATE,
          vol: 0,
          volBucket: 'low',
          events: [],
        });
      } else {
        const w = byToken.get(ev.tokenId)!;
        w.resolvesAt = ev.resolvesAt ?? w.resolvesAt;
        w.asset = ev.asset ?? w.asset;
        if (typeof e.feeRate === 'number') w.feeRate = e.feeRate;
        if (typeof e.rebateRate === 'number') w.rebateRate = e.rebateRate;
      }
      continue;
    }
    if (ev.t === 'resolution') {
      const w = byToken.get(ev.tokenId);
      if (w && typeof ev.yesWon === 'boolean') w.yesWon = ev.yesWon;
      continue;
    }
    const w = byToken.get(ev.tokenId);
    if (!w) continue; // no metadata yet -> can't compute time-to-resolve
    // Keep only the fields the simulator uses — drops the heavy depth arrays so
    // large multi-hundred-MB tapes fit in memory. Top-of-book sizes are kept for
    // the queue model.
    if (ev.t === 'book') {
      w.events.push({ t: 'book', ts: ev.ts, tokenId: ev.tokenId, bid: ev.bid, ask: ev.ask, bidSz: ev.bidSz, askSz: ev.askSz, btcR30: ev.btcR30 });
    } else if (ev.t === 'trade') {
      w.events.push({ t: 'trade', ts: ev.ts, tokenId: ev.tokenId, price: ev.price, size: ev.size, side: ev.side });
    }
  }
}

/** Per-window realized volatility proxy = mean |btcR30| over its book events. */
function computeVol(w: Window): number {
  let sum = 0;
  let n = 0;
  for (const ev of w.events) {
    if (ev.t === 'book' && typeof ev.btcR30 === 'number') {
      sum += Math.abs(ev.btcR30);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Tag every window with a low/mid/high volatility bucket by global terciles. */
function assignVolBuckets(windows: Window[]): void {
  for (const w of windows) w.vol = computeVol(w);
  const vols = windows.map((w) => w.vol).sort((a, b) => a - b);
  if (vols.length === 0) return;
  const t1 = vols[Math.floor(vols.length / 3)];
  const t2 = vols[Math.floor((2 * vols.length) / 3)];
  for (const w of windows) w.volBucket = w.vol <= t1 ? 'low' : w.vol <= t2 ? 'mid' : 'high';
}

/** Real Polymarket taker fee (USDC), confirmed from `feeSchedule` and docs:
 *  fee = shares * feeRate * p*(1-p). Symmetric around p=0.5 (max), ~0 at the
 *  extremes. At feeRate=0.07 this is ~1.8% per share at p=0.50. */
function takerFee(price: number, shares: number, feeRate: number): number {
  return shares * feeRate * price * (1 - price);
}

function simulate(windows: Window[], cfg: MakerConfig): SimMetrics {
  const m: SimMetrics = {
    windows: 0,
    totalPnl: 0,
    grossSpreadPnl: 0,
    rebatesEarned: 0,
    fills: 0,
    buyShares: 0,
    sellShares: 0,
    meanAbsInvUsd: 0,
    maxAbsInvUsd: 0,
    pulledQuotes: 0,
    widenedQuotes: 0,
    flattens: 0,
    heldResiduals: 0,
    outcomeSettled: 0,
    takerFeesPaid: 0,
    byAsset: new Map(),
    byHour: new Map(),
    byVol: new Map(),
    peakConcurrentUsd: 0,
    meanConcurrentUsd: 0,
    pnls: [],
  };

  let invSampleSum = 0;
  let invSamples = 0;
  const maxShares = (price: number) => cfg.maxInventoryUsd / price;
  // Global 5s buckets of summed working capital across concurrently-active
  // windows (Step 5: balance sizing).
  const CAP_BUCKET_MS = 5000;
  const concurrentCap = new Map<number, number>();

  for (const w of windows) {
    let inv: InventoryState = emptyInventory();
    let lastMid = 0;
    let lastBid = 0;
    let lastAsk = 0;
    // Live resting quote. Size is consumed by fills and is only re-armed when
    // the quote PRICE changes (a real cancel/replace that loses queue priority);
    // an unchanged price keeps its already-consumed remaining (no free refill).
    let bidPrice: number | null = null;
    let bidRemaining = 0;
    let askPrice: number | null = null;
    let askRemaining = 0;
    let flattened = false;
    // Top-of-book best price + size (queue-ahead proxy for the fill model).
    let bestBid = 0;
    let bestAsk = 0;
    let bestBidSz = 0;
    let bestAskSz = 0;
    // Per-window peak working capital within each 5s bucket.
    const windowBucketPeak = new Map<number, number>();

    // Chronological order; at equal timestamps process trades BEFORE books so a
    // trade fills against the quote that was actually resting (set from the
    // prior book), not against a quote derived from a same-instant book update.
    const typeRank = (t: string) => (t === 'trade' ? 0 : 1);
    const events = w.events.sort((a, b) => a.ts - b.ts || typeRank(a.t) - typeRank(b.t));

    for (const ev of events) {
      const timeToResolveSec = (w.resolvesAt - ev.ts) / 1000;
      if (timeToResolveSec < 0) continue; // ignore post-resolution noise

      if (ev.t === 'book') {
        const bb = ev.bid ?? 0;
        const ba = ev.ask ?? 0;
        if (bb > 0 && ba > 0 && ba > bb) {
          lastBid = bb;
          lastAsk = ba;
          lastMid = (bb + ba) / 2;
          bestBid = bb;
          bestAsk = ba;
          bestBidSz = ev.bidSz ?? 0;
          bestAskSz = ev.askSz ?? 0;
        }
        if (lastMid <= 0) continue;

        // Sample inventory exposure for the mean/max metrics.
        const invUsd = inventoryUsd(inv, lastMid);
        invSampleSum += Math.abs(invUsd);
        invSamples++;
        m.maxAbsInvUsd = Math.max(m.maxAbsInvUsd, Math.abs(invUsd));

        // Sample working capital (USDC in resting buy orders + value of held
        // shares) into this window's per-bucket peak.
        const capital = (bidPrice ? bidRemaining * bidPrice : 0) + Math.abs(inv.shares) * lastMid;
        const bkt = Math.floor(ev.ts / CAP_BUCKET_MS);
        if (capital > (windowBucketPeak.get(bkt) ?? 0)) windowBucketPeak.set(bkt, capital);

        // Hybrid close: flatten large inventory at the touch once in the window.
        // Crossing the book makes us a TAKER, so a dynamic taker fee applies.
        const close = closeGate(inv, lastMid, timeToResolveSec, cfg);
        if (close.action === 'flatten' && !flattened) {
          const qty = Math.abs(inv.shares);
          if (inv.shares > 0) {
            inv = applyFill(inv, { side: 'SELL', price: lastBid, shares: qty });
            const fee = takerFee(lastBid, qty, cfg.takerFeeRate);
            inv = { ...inv, cashUsd: inv.cashUsd - fee };
            m.takerFeesPaid += fee;
            m.sellShares += qty;
          } else if (inv.shares < 0) {
            inv = applyFill(inv, { side: 'BUY', price: lastAsk, shares: qty });
            const fee = takerFee(lastAsk, qty, cfg.takerFeeRate);
            inv = { ...inv, cashUsd: inv.cashUsd - fee };
            m.takerFeesPaid += fee;
            m.buyShares += qty;
          }
          flattened = true;
          m.flattens++;
        }

        // Recompute resting quotes.
        const decision = computeQuotes(
          {
            bestBid: bb,
            bestAsk: ba,
            inventoryShares: inv.shares,
            inventoryUsd: invUsd,
            btcReturn30s: ev.btcR30 ?? null,
            timeToResolveSec,
          },
          cfg,
        );
        if (decision.action === 'quote') {
          if (decision.reason === 'pulled_one_side') m.pulledQuotes++;
          else if (decision.reason === 'widened') m.widenedQuotes++;
          const newBid = decision.bid?.price ?? null;
          const newAsk = decision.ask?.price ?? null;
          // Re-arm size ONLY when the price changes (cancel/replace). An
          // unchanged price keeps its already-consumed remaining — no free
          // refill just because the book ticked.
          if (newBid === null) {
            bidPrice = null;
            bidRemaining = 0;
          } else if (newBid !== bidPrice) {
            bidPrice = newBid;
            bidRemaining = decision.bid?.sizeShares ?? 0;
          }
          if (newAsk === null) {
            askPrice = null;
            askRemaining = 0;
          } else if (newAsk !== askPrice) {
            askPrice = newAsk;
            askRemaining = decision.ask?.sizeShares ?? 0;
          }
        } else {
          bidPrice = askPrice = null;
          bidRemaining = askRemaining = 0;
        }
        continue;
      }

      if (ev.t === 'trade') {
        const p = ev.price ?? 0;
        const sz = ev.size ?? 0;
        if (p <= 0 || sz <= 0) continue;
        if (timeToResolveSec <= cfg.flattenBeforeSec) continue; // not quoting in flatten window

        // QUEUE MODEL (Step 3): a resting order only fills with the part of a
        // crossing trade left AFTER the size ahead of us in the queue. If our
        // price is worse than the touch (we're behind) or equal (we joined),
        // the recorded top-of-book size sits ahead of us; only the overflow
        // reaches us. If we improved past the touch, we're at the front.
        // (Top-of-book size only -> underestimates queue at deeper levels, so
        // still mildly optimistic; documented.) `fillParticipation` is an extra
        // global haircut on top.
        if (bidPrice !== null && p <= bidPrice && bidRemaining > 0) {
          const queueAhead = bidPrice > bestBid ? 0 : bestBidSz; // front only if we improved; else size ahead
          const reach = Math.max(0, sz - queueAhead) * cfg.fillParticipation;
          const clamp = Math.max(0, maxShares(bidPrice) - inv.shares);
          const fillShares = Math.min(reach, bidRemaining, clamp);
          if (fillShares > 0) {
            inv = applyFill(inv, { side: 'BUY', price: bidPrice, shares: fillShares });
            // Step 1: maker rebate = rebateRate * the taker fee our counterparty paid.
            const rebate = w.rebateRate * takerFee(bidPrice, fillShares, w.feeRate);
            inv = { ...inv, cashUsd: inv.cashUsd + rebate };
            m.rebatesEarned += rebate;
            bidRemaining -= fillShares;
            m.fills++;
            m.buyShares += fillShares;
          }
        } else if (askPrice !== null && p >= askPrice && askRemaining > 0) {
          const queueAhead = askPrice < bestAsk ? 0 : bestAskSz; // front only if we improved; else size ahead
          const reach = Math.max(0, sz - queueAhead) * cfg.fillParticipation;
          const clamp = Math.max(0, inv.shares + maxShares(askPrice));
          const fillShares = Math.min(reach, askRemaining, clamp);
          if (fillShares > 0) {
            inv = applyFill(inv, { side: 'SELL', price: askPrice, shares: fillShares });
            const rebate = w.rebateRate * takerFee(askPrice, fillShares, w.feeRate);
            inv = { ...inv, cashUsd: inv.cashUsd + rebate };
            m.rebatesEarned += rebate;
            askRemaining -= fillShares;
            m.fills++;
            m.sellShares += fillShares;
          }
        }
        continue;
      }
    }

    if (lastMid <= 0) continue; // window had no usable book; skip

    // Settle residual inventory. Prefer the real 0/1 outcome when the recorder
    // captured it (this is the true adverse-selection cost); otherwise fall back
    // to marking at the last observed mid.
    if (Math.abs(inv.shares) > 1e-6) m.heldResiduals++;
    let settlePrice = lastMid;
    if (typeof w.yesWon === 'boolean') {
      settlePrice = w.yesWon ? 1 : 0;
      m.outcomeSettled++;
    }
    const windowPnl = inv.cashUsd + inv.shares * settlePrice;
    m.totalPnl += windowPnl;
    m.pnls.push(windowPnl);
    m.windows++;

    // Breakdown by asset and by UTC hour (overfit / regime checks).
    const a = m.byAsset.get(w.asset) ?? { pnl: 0, windows: 0 };
    a.pnl += windowPnl;
    a.windows++;
    m.byAsset.set(w.asset, a);

    const hour = new Date(w.resolvesAt).getUTCHours();
    const h = m.byHour.get(hour) ?? { pnl: 0, windows: 0 };
    h.pnl += windowPnl;
    h.windows++;
    m.byHour.set(hour, h);

    const vb = m.byVol.get(w.volBucket) ?? { pnl: 0, windows: 0 };
    vb.pnl += windowPnl;
    vb.windows++;
    m.byVol.set(w.volBucket, vb);

    // Merge this window's per-bucket peak capital into the global timeline.
    for (const [bkt, peak] of windowBucketPeak) {
      concurrentCap.set(bkt, (concurrentCap.get(bkt) ?? 0) + peak);
    }
  }

  m.meanAbsInvUsd = invSamples > 0 ? invSampleSum / invSamples : 0;
  m.grossSpreadPnl = m.totalPnl - m.rebatesEarned;
  const capLevels = [...concurrentCap.values()];
  m.peakConcurrentUsd = capLevels.length ? Math.max(...capLevels) : 0;
  m.meanConcurrentUsd = capLevels.length ? capLevels.reduce((s, x) => s + x, 0) / capLevels.length : 0;
  return m;
}

function report(label: string, m: SimMetrics): void {
  const completedRounds = Math.min(m.buyShares, m.sellShares);
  const wins = m.pnls.filter((p) => p > 0).length;
  const sorted = [...m.pnls].sort((a, b) => a - b);
  const worst = sorted[0] ?? 0;
  const best = sorted[sorted.length - 1] ?? 0;
  console.log(`\n=== ${label} ===`);
  console.log(`windows simulated   : ${m.windows}`);
  console.log(`total P&L           : ${fmtUsd(m.totalPnl)}  (spread ${fmtUsd(m.grossSpreadPnl)} + rebate ${fmtUsd(m.rebatesEarned)})`);
  console.log(`P&L per window      : ${fmtUsd(m.windows ? m.totalPnl / m.windows : 0)}`);
  console.log(`winning windows     : ${wins}/${m.windows} (${pct(wins, m.windows)})`);
  console.log(`best / worst window : ${fmtUsd(best)} / ${fmtUsd(worst)}`);
  console.log(`fills               : ${m.fills}`);
  console.log(`buy / sell shares   : ${m.buyShares.toFixed(0)} / ${m.sellShares.toFixed(0)}`);
  console.log(`completed rounds(sh): ${completedRounds.toFixed(0)}`);
  console.log(`mean |inventory|    : ${fmtUsd(m.meanAbsInvUsd)}`);
  console.log(`max |inventory|     : ${fmtUsd(m.maxAbsInvUsd)}`);
  console.log(`quotes widened      : ${m.widenedQuotes}`);
  console.log(`quotes one-side pull: ${m.pulledQuotes}`);
  console.log(`flattens at close   : ${m.flattens}`);
  console.log(`taker fees paid     : ${fmtUsd(-m.takerFeesPaid)} (on flattens; maker fills are free)`);
  console.log(`held residuals      : ${m.heldResiduals}`);
  console.log(`settled at real 0/1 : ${m.outcomeSettled}/${m.windows} (rest marked at mid)`);
  console.log(`capital deployed    : peak ${fmtUsd(m.peakConcurrentUsd)} / mean ${fmtUsd(m.meanConcurrentUsd)} (concurrent across windows)`);
}

function reportBreakdowns(m: SimMetrics): void {
  console.log(`\n  -- P&L by asset --`);
  for (const [asset, v] of [...m.byAsset.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) {
    console.log(`     ${asset.padEnd(5)} ${fmtUsd(v.pnl).padStart(10)}  (${v.windows} windows)`);
  }
  console.log(`  -- P&L by UTC hour --`);
  for (const [hour, v] of [...m.byHour.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`     ${String(hour).padStart(2)}:00 ${fmtUsd(v.pnl).padStart(10)}  (${v.windows} windows)`);
  }
  console.log(`  -- P&L by BTC volatility bucket (per-window mean |R30|) --`);
  for (const k of ['low', 'mid', 'high']) {
    const v = m.byVol.get(k);
    if (v) console.log(`     ${k.padEnd(5)} ${fmtUsd(v.pnl).padStart(10)}  (${v.windows} windows)`);
  }
}

function fmtUsd(x: number): string {
  return (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
}
function pct(a: number, b: number): string {
  return b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a';
}

function main(): void {
  const args = process.argv.slice(2);
  const tapePaths: string[] = [];
  let singleSpread: number | null = null;
  let assetFilter: Set<string> | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spread') singleSpread = Number(args[++i]);
    else if (args[i] === '--assets') assetFilter = new Set(args[++i].toUpperCase().split(','));
    else if (!args[i].startsWith('--')) tapePaths.push(resolve(args[i]));
  }
  const paths = tapePaths.length ? tapePaths : allTapes();

  const cfg = loadBotYaml();
  let windows = loadWindows(paths);
  if (assetFilter) windows = windows.filter((w) => assetFilter!.has(w.asset));
  assignVolBuckets(windows); // Step 4: tag low/mid/high by global terciles
  console.log(`Loaded ${windows.length} market windows from ${paths.length} tape(s):`);
  for (const p of paths) console.log(`  - ${p}`);
  if (assetFilter) console.log(`Asset filter: ${[...assetFilter].join(',')}`);
  console.log(
    `Realism knobs: fill_participation=${cfg.maker.fillParticipation}, taker_fee_rate=${cfg.maker.takerFeeRate}, queue model ON`,
  );
  if (windows.length === 0) {
    console.log('No complete windows with metadata to simulate. Record more tape.');
    return;
  }

  if (singleSpread !== null) {
    const m = simulate(windows, { ...cfg.maker, halfSpread: singleSpread });
    report(`half_spread=${singleSpread}`, m);
    reportBreakdowns(m);
    return;
  }

  // Sweep half_spread to see sensitivity and locate any profitable band.
  const spreads = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07];
  let bestPnl = -Infinity;
  let bestSpread = spreads[0];
  let bestMetrics: SimMetrics | null = null;
  for (const hs of spreads) {
    const m = simulate(windows, { ...cfg.maker, halfSpread: hs });
    report(`half_spread=${hs}`, m);
    if (m.totalPnl > bestPnl) {
      bestPnl = m.totalPnl;
      bestSpread = hs;
      bestMetrics = m;
    }
  }
  // Asset/hour breakdown for the best spread (overfit / regime check).
  if (bestMetrics) {
    console.log(`\n### Breakdown for best spread (half_spread=${bestSpread}) ###`);
    reportBreakdowns(bestMetrics);
  }
}

main();
