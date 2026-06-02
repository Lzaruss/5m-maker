/**
 * Martingale averaging-down engine (2026-06-01).
 *
 * Implements the entry pattern observed in high-performing Polymarket accounts
 * (e.g. @savvvv +$1,942 / 11h, 96.4% win-rate across 55 windows):
 *
 *   1. Initial entry early in the window at market ask (~0.50-0.56) — handled
 *      by the momentum engine + orchestrator.
 *   2. If the ask DROPS below entry price by defined thresholds, add more
 *      capital at each level. Each level fires at most once per window.
 *   3. Hold ALL shares to resolution (the `harvested` flag already ensures this).
 *
 * Why it works (when it does): in 5-minute binary windows BTC rarely moves so
 * far that a token bought at 0.30-0.40 still expires worthless — the position
 * recovers ~96% of the time. The tail (4%) is full capital loss.
 *
 * Risk: classic martingale tail risk. Two consecutive maximum-size windows going
 * to zero wipes out many wins. Bounded here by `maxSpendUsd` (hard cap per window)
 * and the orchestrator's cashFloorUsd and netWorthHaltUsd.
 *
 * Pure decision — no I/O.
 */

import type { MartingaleLevel } from '../util/config.js';
export type { MartingaleLevel };

export interface MartingaleInput {
  /** Ask price at which the INITIAL entry was taken. */
  entryPrice: number;
  /** Which levels have already been executed this window (index-matched to `levels`). */
  levelsExecuted: boolean[];
  /** Level definitions from config. */
  levels: MartingaleLevel[];
  /** Current best ask for this token. */
  currentAsk: number;
  /** Never pay above this ask (same as momentumMaxAsk). */
  maxAsk: number;
  /** Never average below this ask. A token at 0.10 is priced to lose 90% of the
   *  time — the market knows something; don't throw more capital at it. */
  minAsk: number;
  /** Venue minimum order size in shares. */
  minShares: number;
  /** Total USDC already spent on this token this window (initial + prior levels). */
  spentUsdThisWindow: number;
  /** Hard cap on total USDC spend this window (initial + all averaging levels). */
  maxSpendUsd: number;
  /** Seconds remaining until the window resolves. */
  ttrSec: number;
  /** Do not average when ttrSec < this. A big drop with <60s to go is real
   *  information (the market is converging to 0), not mean-reverting noise. */
  minTtrSec: number;
}

export type MartingaleDecision =
  | { fire: false; reason: string }
  | { fire: true; levelIdx: number; shares: number; price: number; triggerDrop: number };

/**
 * Scan levels in order (lowest priceDrop first). Fire the first unexecuted level
 * whose trigger is satisfied. The orchestrator calls this every tick and handles
 * placing one order per tick; subsequent levels can fire on future ticks.
 */
export function decideMartingale(i: MartingaleInput): MartingaleDecision {
  if (i.levels.length === 0) return { fire: false, reason: 'no_levels_configured' };
  if (i.ttrSec < i.minTtrSec) return { fire: false, reason: 'too_late_to_avg' };
  if (i.currentAsk < i.minAsk) return { fire: false, reason: 'ask_below_floor' };

  for (let idx = 0; idx < i.levels.length; idx++) {
    if (i.levelsExecuted[idx]) continue;

    const lvl = i.levels[idx];
    const triggerPrice = i.entryPrice - lvl.priceDrop;

    // Not yet dropped enough to trigger this level.
    if (i.currentAsk > triggerPrice + 0.001) continue;

    // Ask has risen above maxAsk (shouldn't happen on a down-move but guard anyway).
    if (i.currentAsk > i.maxAsk) {
      return { fire: false, reason: `level_${idx}_ask_above_max` };
    }

    // Spend cap check.
    if (i.spentUsdThisWindow + lvl.addUsdc > i.maxSpendUsd) {
      return { fire: false, reason: `level_${idx}_spend_cap` };
    }

    // Compute shares and enforce venue minimum.
    const rawShares = lvl.addUsdc / i.currentAsk;
    const shares = Math.floor(rawShares * 100) / 100; // floor to 2 d.p.
    if (shares < i.minShares) {
      return { fire: false, reason: `level_${idx}_below_min_shares` };
    }

    return {
      fire: true,
      levelIdx: idx,
      shares,
      price: i.currentAsk,
      triggerDrop: i.entryPrice - i.currentAsk,
    };
  }

  return { fire: false, reason: 'no_level_triggered' };
}

