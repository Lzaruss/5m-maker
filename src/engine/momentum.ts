/**
 * Momentum-trend entry — the post-redesign directional strategy (2026-05-31).
 *
 * Validated on the 2-day tape (`scripts/momentum-yes-sim.ts`): 5-minute crypto
 * windows have strong positive autocorrelation. Conditioning on the underlying's
 * prior ~300s return: prior-up → the window finishes UP ~64% (vs 49.8% base),
 * prior-down → ~35%. The NEW window's book opens ~50/50 before pricing that
 * continuation, so entering EARLY (just after open) and betting WITH the trend
 * is +EV (win% 65-73% >> entry ~0.52). Robust across both days and all 6 assets
 * (+3% to +19% ROI). This is the inverse of why the favorite-harvester failed:
 * it entered LATE (90s) when the book was already efficient (win% ≈ price).
 *
 * Pure decision: given time-to-resolve, the live prior-return signal, and both
 * legs' top-of-book, return whether to enter and on which side. The orchestrator
 * crosses the spread (taker) on the chosen leg and holds to resolution.
 */
export interface MomentumLeg {
  bestBid: number | null;
  bestAsk: number | null;
  askSize: number | null;
}

export interface MomentumInput {
  /** Seconds until the window resolves. */
  ttrSec: number;
  /** Look for the entry once ttr <= this (just after the window opened). */
  enterSec: number;
  /** Floor: stop entering once ttr < this. */
  exitSec: number;
  /** Underlying prior-lookback fractional return (priceFeed.getReturn); null if
   *  the feed has not buffered enough history yet. */
  priorReturn: number | null;
  /** |priorReturn| must exceed this to take a side. */
  threshold: number;
  /** |priorReturn| at/above which we size up (conviction): win% rises with the
   *  move size (validated 68%→77% on the tape), so bet more on the strong ones. */
  strongThreshold: number;
  /** Clip multiplier applied when |priorReturn| >= strongThreshold (e.g. 2×). */
  strongMult: number;
  /** Long-only: only bet YES on UPtrends; SKIP downtrends entirely (never buy NO).
   *  "YES when trending up, sit out when down" — NOT "YES on every window" (which
   *  loses, since only ~49% of windows finish UP). */
  longOnly: boolean;
  /** Never pay an ask above this. */
  maxAsk: number;
  clipShares: number;
  minClipShares: number;
  yes: MomentumLeg;
  no: MomentumLeg;
}

export type MomentumAction = 'enter' | 'wait' | 'skip';

export interface MomentumDecision {
  action: MomentumAction;
  side?: 'YES' | 'NO';
  ask?: number;
  shares?: number;
  priorReturn?: number;
  reason: string;
}

function buyable(leg: MomentumLeg, maxAsk: number, targetClip: number, minClip: number): { ask: number; shares: number } | null {
  if (leg.bestBid == null || leg.bestAsk == null || leg.bestAsk <= leg.bestBid) return null;
  if (leg.bestAsk > maxAsk) return null;
  const shares = Math.min(targetClip, leg.askSize ?? 0);
  if (shares < minClip) return null;
  return { ask: leg.bestAsk, shares };
}

/**
 * Decide whether to take a momentum entry this tick.
 *   - ttr above enterSec        -> wait (window not open enough)
 *   - ttr below exitSec         -> skip (too late; signal stale)
 *   - no signal yet (null)      -> wait (feed still warming up)
 *   - |priorReturn| < threshold -> wait (no clear trend yet; may develop)
 *   - trend up  -> buy YES ; trend down -> buy NO  (if that leg is buyable)
 */
export function decideMomentum(i: MomentumInput): MomentumDecision {
  if (i.ttrSec > i.enterSec) return { action: 'wait', reason: 'too_early' };
  if (i.ttrSec < i.exitSec) return { action: 'skip', reason: 'too_late' };
  if (i.priorReturn == null) return { action: 'wait', reason: 'no_signal' };
  if (Math.abs(i.priorReturn) < i.threshold) return { action: 'wait', reason: 'flat_trend' };

  const side: 'YES' | 'NO' = i.priorReturn > 0 ? 'YES' : 'NO';
  if (i.longOnly && side === 'NO') return { action: 'wait', reason: 'long_only_skip_down' };
  const leg = side === 'YES' ? i.yes : i.no;
  // Conviction sizing: size up on strong moves (higher win rate there).
  const strong = Math.abs(i.priorReturn) >= i.strongThreshold;
  const targetClip = i.clipShares * (strong ? i.strongMult : 1);
  const b = buyable(leg, i.maxAsk, targetClip, i.minClipShares);
  if (!b) return { action: 'wait', reason: 'side_unbuyable' };
  return { action: 'enter', side, ask: b.ask, shares: b.shares, priorReturn: i.priorReturn, reason: strong ? 'trend_strong' : 'trend' };
}
