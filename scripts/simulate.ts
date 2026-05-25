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
  events: TapeEvent[];
}

interface SimMetrics {
  windows: number;
  totalPnl: number;
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
  pnls: number[]; // per-window
}

function newestTape(): string {
  const dir = resolve('data');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('tape-') && f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) throw new Error('No tape-*.jsonl files in data/. Run `npm run record` first.');
  return resolve(dir, files[files.length - 1]);
}

function loadWindows(path: string): Window[] {
  const raw = readFileSync(path, 'utf8');
  const byToken = new Map<string, Window>();
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
      if (!byToken.has(ev.tokenId)) {
        byToken.set(ev.tokenId, {
          tokenId: ev.tokenId,
          asset: ev.asset ?? '?',
          resolvesAt: ev.resolvesAt ?? 0,
          events: [],
        });
      } else {
        const w = byToken.get(ev.tokenId)!;
        w.resolvesAt = ev.resolvesAt ?? w.resolvesAt;
        w.asset = ev.asset ?? w.asset;
      }
      continue;
    }
    const w = byToken.get(ev.tokenId);
    if (!w) continue; // no metadata yet -> can't compute time-to-resolve
    w.events.push(ev);
  }
  // Keep only windows with a resolve time and at least some activity.
  return [...byToken.values()].filter((w) => w.resolvesAt > 0 && w.events.length > 0);
}

function simulate(windows: Window[], cfg: MakerConfig): SimMetrics {
  const m: SimMetrics = {
    windows: 0,
    totalPnl: 0,
    fills: 0,
    buyShares: 0,
    sellShares: 0,
    meanAbsInvUsd: 0,
    maxAbsInvUsd: 0,
    pulledQuotes: 0,
    widenedQuotes: 0,
    flattens: 0,
    heldResiduals: 0,
    pnls: [],
  };

  let invSampleSum = 0;
  let invSamples = 0;

  for (const w of windows) {
    let inv: InventoryState = emptyInventory();
    let lastMid = 0;
    let lastBid = 0;
    let lastAsk = 0;
    // Live resting quote with remaining size (consumed across trades until the
    // next book refresh re-establishes it).
    let bidPrice: number | null = null;
    let bidRemaining = 0;
    let askPrice: number | null = null;
    let askRemaining = 0;
    let flattened = false;

    const events = w.events.sort((a, b) => a.ts - b.ts);

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
        }
        if (lastMid <= 0) continue;

        // Sample inventory exposure for the mean/max metrics.
        const invUsd = inventoryUsd(inv, lastMid);
        invSampleSum += Math.abs(invUsd);
        invSamples++;
        m.maxAbsInvUsd = Math.max(m.maxAbsInvUsd, Math.abs(invUsd));

        // Hybrid close: flatten large inventory at the touch once in the window.
        const close = closeGate(inv, lastMid, timeToResolveSec, cfg);
        if (close.action === 'flatten' && !flattened) {
          const qty = Math.abs(inv.shares);
          if (inv.shares > 0) {
            inv = applyFill(inv, { side: 'SELL', price: lastBid, shares: qty });
            m.sellShares += qty;
          } else if (inv.shares < 0) {
            inv = applyFill(inv, { side: 'BUY', price: lastAsk, shares: qty });
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
          bidPrice = decision.bid?.price ?? null;
          bidRemaining = decision.bid?.sizeShares ?? 0;
          askPrice = decision.ask?.price ?? null;
          askRemaining = decision.ask?.sizeShares ?? 0;
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

        // A trade fills at most one of our sides (the one it crosses).
        if (bidPrice !== null && p <= bidPrice && bidRemaining > 0) {
          const fillShares = Math.min(sz, bidRemaining);
          inv = applyFill(inv, { side: 'BUY', price: bidPrice, shares: fillShares });
          bidRemaining -= fillShares;
          m.fills++;
          m.buyShares += fillShares;
        } else if (askPrice !== null && p >= askPrice && askRemaining > 0) {
          const fillShares = Math.min(sz, askRemaining);
          inv = applyFill(inv, { side: 'SELL', price: askPrice, shares: fillShares });
          askRemaining -= fillShares;
          m.fills++;
          m.sellShares += fillShares;
        }
        continue;
      }
    }

    if (lastMid <= 0) continue; // window had no usable book; skip

    // Settle residual inventory at last observed mid (documented approximation).
    if (Math.abs(inv.shares) > 1e-6) m.heldResiduals++;
    const windowPnl = inv.cashUsd + inv.shares * lastMid;
    m.totalPnl += windowPnl;
    m.pnls.push(windowPnl);
    m.windows++;
  }

  m.meanAbsInvUsd = invSamples > 0 ? invSampleSum / invSamples : 0;
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
  console.log(`total P&L           : ${fmtUsd(m.totalPnl)}`);
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
  console.log(`held residuals      : ${m.heldResiduals}`);
}

function fmtUsd(x: number): string {
  return (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
}
function pct(a: number, b: number): string {
  return b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a';
}

function main(): void {
  const args = process.argv.slice(2);
  let tapePath: string | null = null;
  let singleSpread: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spread') singleSpread = Number(args[++i]);
    else if (!args[i].startsWith('--')) tapePath = resolve(args[i]);
  }
  const path = tapePath ?? newestTape();

  const cfg = loadBotYaml();
  const windows = loadWindows(path);
  console.log(`Loaded ${windows.length} market windows from ${path}`);
  if (windows.length === 0) {
    console.log('No complete windows with metadata to simulate. Record more tape.');
    return;
  }

  if (singleSpread !== null) {
    const m = simulate(windows, { ...cfg.maker, halfSpread: singleSpread });
    report(`half_spread=${singleSpread}`, m);
    return;
  }

  // Sweep half_spread to see sensitivity and locate any profitable band.
  const spreads = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07];
  for (const hs of spreads) {
    const m = simulate(windows, { ...cfg.maker, halfSpread: hs });
    report(`half_spread=${hs}`, m);
  }
}

main();
