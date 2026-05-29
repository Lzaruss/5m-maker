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
  /** Shares held on the OTHER leg of this market (YES if we're quoting NO and
   *  vice-versa). Lets the maxBuyPrice filter relax for hedge-BUYs: buying THIS
   *  leg up to `otherLegShares - inventoryShares` shares converts directional
   *  exposure into a matched pair, which is risk-reducing even at p>0.5. Default
   *  0 keeps the original "underdog only" behavior. */
  otherLegShares?: number;
  /** Top-of-book resting size (shares) on each side. Used by the min-depth gate.
   *  Omit to disable that gate (e.g. the single-token simulator). */
  bidDepthShares?: number;
  askDepthShares?: number;
  /** Volume-weighted average cost of the shares held on the OTHER leg (i.e.
   *  -cashUsd / shares for that account). When supplied, the hedge-BUY ceiling
   *  is tightened to `1 - otherLegAvgCost - cfg.minPairProfitPerShare` so that
   *  every completed matched pair is guaranteed to settle above its cost
   *  ("even money or better"). Without this, the fixed HEDGE_BUY_PRICE_CEILING
   *  can produce pairs whose combined cost > $1 → locked-in loss. */
  otherLegAvgCost?: number;
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

// Hedge-BUY hard ceiling: absolute maximum we ever pay for the hedge leg,
// regardless of the dynamic pair-profit calculation. Prevents buying into
// extreme prices even when the other-leg cost is very low.
const HEDGE_BUY_PRICE_CEILING = 0.85;

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

  // Tier-2 GATE — volatility hard-pause. A 30s move this large means the whole
  // book is repricing; stand aside on BOTH sides so the reconciler cancels our
  // resting quotes rather than feeding them to informed flow. Stronger than the
  // adverse_guard below (which only pulls one side).
  if (cfg.volHaltReturn30s > 0 && Math.abs(btcReturn30s ?? 0) >= cfg.volHaltReturn30s) {
    return { action: 'no_quote', reason: 'vol_regime_halt' };
  }
  // Tier-2 GATE — minimum two-sided depth. A thin/one-sided book gaps on a
  // single market order and picks off resting quotes. Only enforced when the
  // caller supplies depth (the single-token simulator omits it).
  if (
    cfg.minBookDepthShares > 0 &&
    input.bidDepthShares !== undefined &&
    input.askDepthShares !== undefined &&
    (input.bidDepthShares < cfg.minBookDepthShares || input.askDepthShares < cfg.minBookDepthShares)
  ) {
    return { action: 'no_quote', reason: 'thin_book' };
  }

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

  // 4b. PEG TO TOUCH (fill-rate fix). Never quote worse than the touch: a bid
  //     behind the best bid (when half_spread > the book's half-spread) only
  //     fills on adverse moves and almost never completes a matched pair. Join
  //     the touch so we actually get hit. maxBuyPrice / dead-zone / late gates
  //     below still apply to the pegged price.
  if (cfg.pegToTouch) {
    if (bidPrice !== null) bidPrice = Math.max(bidPrice, bestBid);
    if (askPrice !== null) askPrice = Math.min(askPrice, bestAsk);
  }

  // Round to tick and clamp to a valid price range.
  const bid = finalizeSide(bidPrice, cfg, 'down');
  const ask = finalizeSide(askPrice, cfg, 'up');

  // Asymmetric "underdog-only BUY" filter. Buying the high-priced side of a
  // binary market has R/R < 1 — a maker has no directional edge, so this
  // systematically bleeds. Empirically (2026-05-27 -$23 stuck-positions
  // analysis): 64% of losses came from BUYs at price > 0.5. The ASK side
  // is unaffected — selling inventory at any price reduces risk.
  //
  // HEDGE EXCEPTION: when the other leg already has more shares than THIS leg,
  // buying THIS leg converts directional exposure into a matched pair. Up to
  // that hedge-room amount we relax the price ceiling to HEDGE_BUY_PRICE_CEILING
  // — the matched portion settles to cost regardless of outcome, so the per-
  // share R/R no longer matters for those shares. Beyond the hedge room, the
  // base maxBuyPrice rule re-applies.
  const otherLegShares = input.otherLegShares ?? 0;
  const hedgeRoom = Math.max(0, otherLegShares - input.inventoryShares);

  // Dynamic hedge-BUY ceiling: cap at the price that guarantees the completed
  // pair settles above its total cost ("even money or better").
  //   ceiling = 1.0 - otherLegAvgCost - minPairProfitPerShare
  // If the other leg's average cost is unknown (first tick, no fills yet),
  // fall back to the hard HEDGE_BUY_PRICE_CEILING so the hedge is still
  // possible but conservatively bounded.
  let dynamicHedgeCeiling = HEDGE_BUY_PRICE_CEILING;
  if (hedgeRoom > 0 && input.otherLegAvgCost != null && input.otherLegAvgCost > 0) {
    const minProfit = cfg.minPairProfitPerShare ?? 0.02;
    dynamicHedgeCeiling = Math.min(
      HEDGE_BUY_PRICE_CEILING,
      1.0 - input.otherLegAvgCost - minProfit,
    );
  }

  const effectiveMaxBuyPrice = hedgeRoom > 0 ? dynamicHedgeCeiling : cfg.maxBuyPrice;
  const finalBid = bid && bid.price <= effectiveMaxBuyPrice ? bid : null;

  // Tier-2 GATEs that suppress OPENING a BUY in low-edge / late conditions. A
  // hedge-completion BUY (hedgeRoom > 0) reduces directional risk, so it is
  // EXEMPT — only a BUY that adds naked exposure is gated. The ask (unwind SELL)
  // is never touched here.
  let gatedBid = finalBid;
  let gateReason = '';
  const opening = hedgeRoom === 0;
  if (gatedBid && opening && cfg.noTradeBand50 > 0 && Math.abs(mid - 0.5) < cfg.noTradeBand50) {
    gatedBid = null;
    gateReason = 'near_50_no_edge';
  }
  if (gatedBid && opening && cfg.noNewEntryBeforeSec > 0 && timeToResolveSec <= cfg.noNewEntryBeforeSec) {
    gatedBid = null;
    gateReason = 'late_no_entry';
  }

  // If rounding crossed the quotes, drop both (book too tight for our spread).
  if (gatedBid && ask && gatedBid.price >= ask.price) {
    return { action: 'no_quote', reason: 'crossed_after_rounding' };
  }
  if (!gatedBid && !ask) {
    return { action: 'no_quote', reason: 'both_sides_pulled' };
  }

  const reason =
    gateReason
      ? gateReason
      : bid && !finalBid
        ? 'buy_above_max_price'
        : absR >= cfg.adverseGuard.btcReturn30sPull
          ? 'pulled_one_side'
          : absR >= cfg.adverseGuard.btcReturn30sWiden
            ? 'widened'
            : 'normal';

  return { action: 'quote', bid: gatedBid, ask, reason };
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
