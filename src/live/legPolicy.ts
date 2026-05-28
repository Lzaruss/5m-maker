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
 *        sell, we OWN enough shares to back it (naked SELL is rejected by the
 *        venue), and the ask would NOT cross the touch (postOnly rejects a SELL
 *        at/below bestBid).
 */
export function buildDesired(p: BuildDesiredParams): DesiredQuote[] {
  const desired: DesiredQuote[] = [];
  if (p.halted || p.decision.action !== 'quote') return desired;

  const { bid, ask } = p.decision;

  if (bid && p.allowBuy && !p.hedgeBlocksBuy && !p.spendBlocksBuy && bid.price < p.bestAsk) {
    desired.push({ side: 'BUY', price: bid.price, size: bid.sizeShares });
  }

  if (
    !p.disableSell &&
    ask &&
    p.allowSell &&
    p.legShares >= ask.sizeShares &&
    ask.price > p.bestBid
  ) {
    desired.push({ side: 'SELL', price: ask.price, size: ask.sizeShares });
  }

  return desired;
}
