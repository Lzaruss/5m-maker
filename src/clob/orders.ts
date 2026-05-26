import { Side, OrderType } from '@polymarket/clob-client-v2';
import { getClobClient } from './client.js';
import { logger } from '../util/logger.js';

export interface PlacedOrder { orderId: string; side: 'BUY' | 'SELL'; price: number; size: number; }

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
      logger.warn({ tokenId: tokenId.slice(0, 10), side, price, err: result?.errorMsg }, 'placeLimitMaker rejected');
      return null;
    }
    return { orderId, side, price, size: sizeShares };
  } catch (err: any) {
    logger.error({ side, price, err: err.message }, 'placeLimitMaker failed');
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

/** Aggressive FOK flatten of residual inventory at window close (taker — fee applies). */
export async function marketFlatten(tokenId: string, side: 'BUY' | 'SELL', amount: number): Promise<boolean> {
  try {
    const c = getClobClient();
    const result: any = await (c as any).createAndPostMarketOrder(
      { tokenID: tokenId, amount: Number(amount.toFixed(2)), side: side === 'BUY' ? Side.BUY : Side.SELL, orderType: OrderType.FOK },
      { tickSize: '0.01' },
      OrderType.FOK,
    );
    return !(result?.error || result?.success === false);
  } catch (err: any) {
    logger.error({ side, amount, err: err.message }, 'marketFlatten failed');
    return false;
  }
}
