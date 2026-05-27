import { Side, OrderType } from '@polymarket/clob-client-v2';
import { getClobClient } from './client.js';
import { logger } from '../util/logger.js';

export interface PlacedOrder { orderId: string; side: 'BUY' | 'SELL'; price: number; size: number; }

// ---------------------------------------------------------------------------
// Venue-throttle circuit breaker.
//
// Polymarket's CLOB occasionally returns 425 "service not ready" (rate-limit /
// internal hiccup) and once it starts it tends to keep happening for tens of
// seconds. Hammering the venue during a cooldown wastes requests AND can keep
// extending the cooldown. This shared state tracks consecutive failures and
// exposes `isThrottled()` for the orchestrator to skip places entirely while
// the breaker is open. Backoff is exponential capped at 60s.
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
let throttleUntilMs = 0;

function backoffMs(n: number): number {
  // 5s, 10s, 20s, 40s, 60s, 60s, ...
  return Math.min(60_000, 5_000 * Math.pow(2, Math.max(0, n - 1)));
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= 3) {
    const wait = backoffMs(consecutiveFailures - 2);
    throttleUntilMs = Date.now() + wait;
    logger.warn({ consecutiveFailures, throttleForMs: wait }, 'venue circuit breaker tripped');
  }
}

function recordSuccess(): void {
  if (consecutiveFailures > 0 || throttleUntilMs > 0) {
    logger.info({ priorFailures: consecutiveFailures }, 'venue circuit breaker reset');
  }
  consecutiveFailures = 0;
  throttleUntilMs = 0;
}

/** True if the orchestrator should skip placements right now (still backing off). */
export function isThrottled(): boolean {
  return Date.now() < throttleUntilMs;
}

/** Ms remaining before placements may resume; 0 if not throttled. */
export function throttleRemainingMs(): number {
  return Math.max(0, throttleUntilMs - Date.now());
}

/** Place a resting maker limit order. postOnly=true => rejected if it would cross
 *  the book, so we can NEVER accidentally pay a taker fee. */
export async function placeLimitMaker(
  tokenId: string,
  side: 'BUY' | 'SELL',
  price: number,
  sizeShares: number,
): Promise<PlacedOrder | null> {
  try {
    const c = getClobClient();
    const result: any = await (c as any).createAndPostOrder(
      { tokenID: tokenId, price, size: Number(sizeShares.toFixed(2)), side: side === 'BUY' ? Side.BUY : Side.SELL },
      { tickSize: '0.01' },
      OrderType.GTC,
      true, // postOnly
    );
    const orderId = String(result?.orderID ?? result?.order_id ?? '');
    if (!orderId || result?.success === false) {
      // Venue rejection. A 425 ("service not ready") or other transient
      // throttle counts toward the circuit breaker; a clean rejection like
      // "insufficient balance" does not (it's our fault, not the venue's).
      const status = Number(result?.status ?? 0);
      const transient = status === 425 || status === 429 || status >= 500;
      if (transient) recordFailure();
      logger.warn(
        {
          tokenId: tokenId.slice(0, 10),
          side,
          price,
          size: Number(sizeShares.toFixed(2)),
          errorMsg: result?.errorMsg,
          status: result?.status,
          success: result?.success,
          raw: JSON.stringify(result ?? null),
          transient,
        },
        'placeLimitMaker rejected',
      );
      return null;
    }
    recordSuccess();
    logger.info({ tokenId: tokenId.slice(0, 10), side, price, size: Number(sizeShares.toFixed(2)), orderId }, 'order placed');
    return { orderId, side, price, size: sizeShares };
  } catch (err: any) {
    // Network errors / SDK throws are treated as transient.
    recordFailure();
    logger.error({ side, price, size: sizeShares, err: err.message, stack: err.stack }, 'placeLimitMaker failed');
    return null;
  }
}

export async function cancelByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await (getClobClient() as any).cancelOrders(ids);
  } catch (err: any) {
    logger.error({ ids, err: err.message }, 'cancelByIds failed');
  }
}

export async function cancelAll(): Promise<void> {
  try {
    await (getClobClient() as any).cancelAll();
    logger.info('cancelAll done');
  } catch (err: any) {
    logger.error({ err: err.message }, 'cancelAll failed');
  }
}

export interface OpenOrderLite { id: string; side: 'BUY' | 'SELL'; price: number; size: number; }

export async function listOpenOrders(tokenId: string): Promise<OpenOrderLite[]> {
  try {
    const resp: any = await (getClobClient() as any).getOpenOrders({ asset_id: tokenId });
    const arr: any[] = Array.isArray(resp) ? resp : (resp?.data ?? resp?.orders ?? []);
    return arr.map((o) => ({
      id: String(o.id ?? o.orderID ?? ''),
      side: String(o.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(o.price),
      // remaining size = original - matched
      size: Number(o.original_size ?? o.size ?? 0) - Number(o.size_matched ?? 0),
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, 'listOpenOrders failed');
    return [];
  }
}

/**
 * Aggressive FOK flatten of residual inventory at window close (taker — fee applies).
 *
 * IMPORTANT: the v2 SDK's `amount` field is asymmetric:
 *   - BUY  -> $$$ USDC notional to spend
 *   - SELL -> shares to dispose
 * We always receive the desired SHARE quantity from the caller; for BUY we
 * convert via `refPrice` (the best ask or last mid). A small slippage cushion
 * makes sure the FOK is funded even if the touch moves a tick while signing.
 */
export async function marketFlatten(
  tokenId: string,
  side: 'BUY' | 'SELL',
  shares: number,
  refPrice: number,
): Promise<boolean> {
  try {
    const c = getClobClient();
    const amount =
      side === 'BUY'
        ? Math.max(0.01, shares * refPrice * 1.02) // 2% slippage cushion in USDC
        : shares;
    const result: any = await (c as any).createAndPostMarketOrder(
      { tokenID: tokenId, amount: Number(amount.toFixed(2)), side: side === 'BUY' ? Side.BUY : Side.SELL, orderType: OrderType.FOK },
      { tickSize: '0.01' },
      OrderType.FOK,
    );
    return !(result?.error || result?.success === false);
  } catch (err: any) {
    logger.error({ side, shares, refPrice, err: err.message }, 'marketFlatten failed');
    return false;
  }
}
