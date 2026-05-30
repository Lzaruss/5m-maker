/**
 * Favorite Harvester — the post-redesign strategy decision (2026-05-30).
 *
 * Validated on a 2-day tape (scripts/lag-study.ts §4 + favorite-maker-sim.ts):
 * the matched-pair maker has no edge (adverse selection — you only fill the
 * losing side), and a passive bid on the favorite barely fills AND is adversely
 * selected (you only fill when the favorite is dipping into your bid). The one
 * edge that survives costs is the favorite-longshot bias harvested as a TAKER:
 * late in the window, cross the spread to BUY the book's FAVORITE and hold to
 * resolution. +EV after fees on the less-efficient books (DOGE/XRP); the taker
 * fee is the price of getting the RIGHT side.
 *
 * This module is the pure, unit-tested decision. The orchestrator supplies the
 * current top-of-book for both legs and the time-to-resolve; it returns whether
 * to enter, on which leg, at what ask and size.
 */
export interface HarvestLeg {
  label: 'YES' | 'NO';
  bestBid: number | null;
  bestAsk: number | null;
  askSize: number | null;
}

export interface HarvestInput {
  /** Seconds until the window resolves. */
  ttrSec: number;
  /** Begin hunting for a favorite once ttr <= this. */
  enterSec: number;
  /** Stop entering once ttr < this (too little edge room / price discovery noise). */
  exitSec: number;
  /** A leg is the "favorite" when its mid >= this (0.60 ≈ conviction 10%). */
  minMid: number;
  /** Never pay an ask above this (no room to $1 after fee; bad risk/reward). */
  maxAsk: number;
  /** Taker clip size in shares. */
  clipShares: number;
  /** Venue min order size — never enter for fewer shares than this. */
  minClipShares: number;
  legs: HarvestLeg[];
}

export type HarvestAction = 'enter' | 'wait' | 'skip';

export interface HarvestDecision {
  action: HarvestAction;
  leg?: 'YES' | 'NO';
  ask?: number;
  shares?: number;
  mid?: number;
  reason: string;
}

/**
 * Decide whether to harvest the favorite this tick.
 *   - ttr above enterSec  -> wait (too early to commit; the favorite can still flip)
 *   - ttr below exitSec   -> skip (too late; thin edge, converging book)
 *   - a buyable favorite  -> enter on the higher-mid leg (the clearer favorite)
 *   - otherwise           -> wait (a favorite may yet emerge in [exit, enter])
 *
 * "Buyable" = mid >= minMid, ask <= maxAsk, and >= minClipShares resting at the
 * ask. Holding to resolution means the only cost is the cross + fee, recovered by
 * the favorite-longshot bias on the eligible assets.
 */
export function decideHarvest(i: HarvestInput): HarvestDecision {
  if (i.ttrSec > i.enterSec) return { action: 'wait', reason: 'too_early' };
  if (i.ttrSec < i.exitSec) return { action: 'skip', reason: 'too_late' };

  let best: { leg: 'YES' | 'NO'; mid: number; ask: number; shares: number } | null = null;
  let sawFavorite = false; // a leg whose MID qualifies, even if not buyable
  for (const leg of i.legs) {
    if (leg.bestBid == null || leg.bestAsk == null || leg.bestAsk <= leg.bestBid) continue;
    const mid = (leg.bestBid + leg.bestAsk) / 2;
    if (mid < i.minMid) continue;
    sawFavorite = true;
    if (leg.bestAsk > i.maxAsk) continue; // favorite too expensive — no room after fee
    const sz = leg.askSize ?? 0;
    const shares = Math.min(i.clipShares, sz);
    if (shares < i.minClipShares) continue; // not enough liquidity at the ask
    if (!best || mid > best.mid) best = { leg: leg.label, mid, ask: leg.bestAsk, shares };
  }
  if (best) return { action: 'enter', leg: best.leg, ask: best.ask, shares: best.shares, mid: best.mid, reason: 'favorite' };
  return { action: 'wait', reason: sawFavorite ? 'favorite_unbuyable' : 'no_favorite' };
}
