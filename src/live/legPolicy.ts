/**
 * Pure per-leg quoting policy — the decision logic the orchestrator applies to
 * each outcome-token leg (YES / NO). Extracted from src/index.ts so it can be
 * unit-tested in isolation; index.ts calls these instead of inlining the rules.
 *
 * No I/O, no mutation.
 */
import type { QuoteDecision } from '../engine/quoter.js';
import type { DesiredQuote } from './reconciler.js';

/**
 * Hedge cap: suppress BUY on the over-represented leg. `legShares - otherShares`
 * is how much MORE inventory this leg holds than its partner. Once that reaches
 * `maxUnmatchedShares`, we stop buying this leg until the other catches up —
 * forcing matched-pair accumulation and bounding directional exposure.
 */
export function hedgeBlocksBuy(
  legShares: number,
  otherShares: number,
  maxUnmatchedShares: number,
): boolean {
  return legShares - otherShares >= maxUnmatchedShares;
}

/** Per-leg per-window spend cap. The caller supplies the EFFECTIVE BUY
 *  exposure for this leg this window — typically `filled BUY notional + resting
 *  BUY notional`. Once that reaches the cap, suppress further BUYs on this leg
 *  until the next window opens. Filled+resting is preferred over "every
 *  placement" because cancel+replace cycles would otherwise eat the cap without
 *  ever creating real exposure (the 2026-05-27 73%-at-cap idle pathology). */
export function spendBlocksBuy(buyExposureUsd: number, maxSpendPerLegUsd: number): boolean {
  return buyExposureUsd >= maxSpendPerLegUsd;
}

/** Settlement price of a leg given the resolved outcome. YES pays 1 if Up won;
 *  NO is the complement. */
export function legSettlePrice(label: 'YES' | 'NO', yesWon: boolean): number {
  if (label === 'YES') return yesWon ? 1 : 0;
  return yesWon ? 0 : 1;
}

export interface BuildDesiredParams {
  decision: QuoteDecision;
  /** Risk gate output. */
  halted: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  /** Current touch of THIS leg's book. */
  bestBid: number;
  bestAsk: number;
  /** Realized share inventory on this leg (backs SELL orders). */
  legShares: number;
  /** Realized share inventory on the OTHER leg of this market. Used by the
   *  delta-neutral SELL rule: only the UNMATCHED excess (legShares -
   *  otherLegShares) may be sold — the matched-pair core rides to redemption. */
  otherLegShares: number;
  /** Blocks computed by the caller. */
  hedgeBlocksBuy: boolean;
  spendBlocksBuy: boolean;
  /** BUY-only / hold-to-resolution mode. */
  disableSell: boolean;
}

/**
 * Assemble the desired resting orders for one leg from the quoter decision and
 * the risk/hedge/spend gates. Encodes every suppression rule the live bot uses:
 *
 *   BUY  is posted only if: not halted, quoter wants a bid, gate allows buy,
 *        hedge cap not hit, spend cap not hit, and the bid would NOT cross the
 *        touch (postOnly would reject a BUY at/above bestAsk).
 *   SELL is posted only if: SELL not disabled, quoter wants an ask, gate allows
 *        sell, the ask would NOT cross the touch (postOnly rejects a SELL
 *        at/below bestBid), AND the UNMATCHED EXCESS on this leg is at least a
 *        full clip.
 *
 * DELTA-NEUTRAL SELL RULE (2026-05-28): the matched-pair core —
 * min(legShares, otherLegShares) — is held to resolution where it redeems for
 * a guaranteed $1 (locked profit, since pair cost < $1). Only the unmatched
 * excess (legShares - otherLegShares) represents naked directional risk, so
 * only that excess may be unwound via SELL. This eliminates the disposition
 * leak proven across 2026-05-26/27/28: the old `legShares >= ask.sizeShares`
 * rule sold ANY owned shares, which mechanically clipped 80-96% of winning legs
 * at a thin spread while losers (whose asks never filled) rode to $0. Selling
 * only the excess never touches the hedged core, so winners ride to redemption.
 */
export function buildDesired(p: BuildDesiredParams): DesiredQuote[] {
  const desired: DesiredQuote[] = [];
  if (p.halted || p.decision.action !== 'quote') return desired;

  const { bid, ask } = p.decision;

  if (bid && p.allowBuy && !p.hedgeBlocksBuy && !p.spendBlocksBuy && bid.price < p.bestAsk) {
    desired.push({ side: 'BUY', price: bid.price, size: bid.sizeShares });
  }

  // Only the naked excess over the matched pair is eligible to sell. Requiring
  // the excess to cover a full clip (ask.sizeShares >= venue min) also prevents
  // posting an unsellably-small SELL and prevents nibbling into the matched core.
  const unmatchedExcess = Math.max(0, p.legShares - p.otherLegShares);
  if (
    !p.disableSell &&
    ask &&
    p.allowSell &&
    unmatchedExcess >= ask.sizeShares &&
    ask.price > p.bestBid
  ) {
    desired.push({ side: 'SELL', price: ask.price, size: ask.sizeShares });
  }

  return desired;
}
