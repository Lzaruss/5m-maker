import type { MakerConfig } from '../util/config.js';

export interface QuoteInput {
  /** Top of book for the YES token. */
  bestBid: number;
  bestAsk: number;
  /** Net YES inventory: positive = long YES, negative = short. */
  inventoryShares: number;
  /** Signed inventory notional at current mid (inventoryShares * mid). */
  inventoryUsd: number;
  /** Binance return over last 30s; null if stale. */
  btcReturn30s: number | null;
  /** Seconds until the market resolves. */
  timeToResolveSec: number;
}

export interface QuoteSidePlan {
  price: number;
  sizeShares: number;
}

export type QuoteDecision =
  | { action: 'quote'; bid: QuoteSidePlan | null; ask: QuoteSidePlan | null; reason: string }
  | { action: 'no_quote'; reason: string };

// Hard floor/ceiling enforced by Polymarket itself. The config-level
// `quotePriceMin/Max` is the SOFTER strategy-level clip (typically 0.05–0.95)
// to avoid "lottery-ticket" extreme-price quotes.
const VENUE_PRICE_MIN = 0.01;
const VENUE_PRICE_MAX = 0.99;

/**
 * Pure market-making quote computation. No I/O. Combines:
 *   1. mid anchor + base half-spread (the profit engine)
 *   2. inventory skew (simplified Avellaneda-Stoikov: shift quotes against
 *      current inventory so it mean-reverts toward neutral)
 *   3. adverse-selection guard from the BTC feed (widen when BTC moves; pull
 *      the vulnerable side entirely beyond a stronger threshold)
 *
 * Returns the desired resting bid/ask for the YES token, or no_quote.
 * The same function is used by the simulator and (later) the live bot.
 */
export function computeQuotes(input: QuoteInput, cfg: MakerConfig): QuoteDecision {
  const { bestBid, bestAsk, inventoryUsd, btcReturn30s, timeToResolveSec } = input;

  // 1. Stop quoting inside the flatten window — closing is handled separately.
  if (timeToResolveSec <= cfg.flattenBeforeSec) {
    return { action: 'no_quote', reason: 'flatten_window' };
  }

  // Need a two-sided book to anchor on.
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) {
    return { action: 'no_quote', reason: 'no_two_sided_book' };
  }
  const mid = (bestBid + bestAsk) / 2;

  // 2. Inventory skew. invFrac in [-1, 1]; long YES (positive) shifts the
  //    reservation price DOWN so the ask is keener (we sell) and the bid is
  //    less aggressive (we stop accumulating).
  const invFrac = clamp(inventoryUsd / cfg.maxInventoryUsd, -1, 1);
  const skew = cfg.inventorySkewK * cfg.halfSpread * invFrac;
  const reservation = mid - skew;

  // 3. Adverse-selection guard.
  const r30 = btcReturn30s ?? 0;
  const absR = Math.abs(r30);
  const effHalf =
    absR >= cfg.adverseGuard.btcReturn30sWiden ? cfg.halfSpread * cfg.widenFactor : cfg.halfSpread;

  let bidPrice: number | null = reservation - effHalf;
  let askPrice: number | null = reservation + effHalf;

  // Pull the side that informed flow would pick off:
  //   BTC up hard  -> someone will lift our YES ask cheaply -> pull the ask
  //   BTC down hard -> someone will hit our YES bid into worthless -> pull the bid
  if (r30 >= cfg.adverseGuard.btcReturn30sPull) askPrice = null;
  if (r30 <= -cfg.adverseGuard.btcReturn30sPull) bidPrice = null;

  // 4. Inventory caps: never add to an already-maxed position.
  if (inventoryUsd >= cfg.maxInventoryUsd) bidPrice = null; // too long, stop buying
  if (inventoryUsd <= -cfg.maxInventoryUsd) askPrice = null; // too short, stop selling

  // Round to tick and clamp to a valid price range.
  const bid = finalizeSide(bidPrice, cfg, 'down');
  const ask = finalizeSide(askPrice, cfg, 'up');

  // Asymmetric "underdog-only BUY" filter. Buying the high-priced side of a
  // binary market has R/R < 1 — a maker has no directional edge, so this
  // systematically bleeds. Empirically (2026-05-27 -$23 stuck-positions
  // analysis): 64% of losses came from BUYs at price > 0.5. The ASK side
  // is unaffected — selling inventory at any price reduces risk.
  const finalBid = bid && bid.price <= cfg.maxBuyPrice ? bid : null;

  // If rounding crossed the quotes, drop both (book too tight for our spread).
  if (finalBid && ask && finalBid.price >= ask.price) {
    return { action: 'no_quote', reason: 'crossed_after_rounding' };
  }
  if (!finalBid && !ask) {
    return { action: 'no_quote', reason: 'both_sides_pulled' };
  }

  const reason =
    bid && !finalBid
      ? 'buy_above_max_price'
      : absR >= cfg.adverseGuard.btcReturn30sPull
        ? 'pulled_one_side'
        : absR >= cfg.adverseGuard.btcReturn30sWiden
          ? 'widened'
          : 'normal';

  return { action: 'quote', bid: finalBid, ask, reason };
}

function finalizeSide(
  price: number | null,
  cfg: MakerConfig,
  dir: 'up' | 'down',
): QuoteSidePlan | null {
  if (price === null) return null;
  let p = roundToTick(price, cfg.tickSize, dir);
  p = clamp(p, VENUE_PRICE_MIN, VENUE_PRICE_MAX);
  // Strategy-level price clip — refuse to quote outside [quotePriceMin,
  // quotePriceMax]. Removes "lottery ticket" BUYs at sub-cent prices and
  // SELLs near the resolved touch. Returning null cleanly suppresses the side.
  if (p < cfg.quotePriceMin || p > cfg.quotePriceMax) return null;
  // Polymarket rejects orders below the per-market min_order_size (typically 5
  // shares). At extreme prices `quoteSizeUsd / p` falls below that floor, so
  // clamp UP — accepting slightly higher notional in exchange for an order the
  // venue will actually take.
  const sizeShares = Math.max(cfg.quoteSizeUsd / p, cfg.minQuoteShares);
  return { price: p, sizeShares };
}

/** Round a bid DOWN and an ask UP to the tick grid so we never quote tighter
 *  than intended after rounding. */
function roundToTick(price: number, tick: number, dir: 'up' | 'down'): number {
  const n = price / tick;
  const rounded = dir === 'up' ? Math.ceil(n) : Math.floor(n);
  return Math.round(rounded * tick * 1e6) / 1e6;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
