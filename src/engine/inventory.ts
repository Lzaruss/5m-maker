import type { MakerConfig } from '../util/config.js';

/**
 * Per-market maker inventory. `shares` is net YES exposure (positive = long).
 * `cashUsd` accumulates signed cash flow from fills: a buy subtracts cash, a
 * sell adds it. Combined with end-of-window settlement of `shares`, cashUsd is
 * the realized + unrealized P&L basis. `avgCost` is the volume-weighted entry
 * price of the current net position (informational; P&L is derived from cash).
 */
export interface InventoryState {
  shares: number;
  cashUsd: number;
  avgCost: number;
  fills: number;
}

export interface Fill {
  side: 'BUY' | 'SELL'; // our action: BUY adds YES shares, SELL removes them
  price: number;
  shares: number;
}

export function emptyInventory(): InventoryState {
  return { shares: 0, cashUsd: 0, avgCost: 0, fills: 0 };
}

/** Apply a fill, returning a new state (pure). */
export function applyFill(state: InventoryState, fill: Fill): InventoryState {
  const signed = fill.side === 'BUY' ? fill.shares : -fill.shares;
  const cashDelta = fill.side === 'BUY' ? -fill.price * fill.shares : fill.price * fill.shares;
  const newShares = state.shares + signed;

  // Update avgCost only while building in the same direction; when reducing or
  // flipping, keep the prior avgCost for the surviving side (informational).
  let avgCost = state.avgCost;
  if (state.shares === 0 || Math.sign(state.shares) === Math.sign(signed)) {
    const prevAbs = Math.abs(state.shares);
    const addAbs = Math.abs(signed);
    const denom = prevAbs + addAbs;
    avgCost = denom > 0 ? (state.avgCost * prevAbs + fill.price * addAbs) / denom : fill.price;
  } else if (Math.sign(newShares) !== Math.sign(state.shares) && newShares !== 0) {
    // Flipped through zero: the new position starts at this fill price.
    avgCost = fill.price;
  }

  return {
    shares: newShares,
    cashUsd: state.cashUsd + cashDelta,
    avgCost,
    fills: state.fills + 1,
  };
}

/** Signed inventory notional at a given mark price. */
export function inventoryUsd(state: InventoryState, mark: number): number {
  return state.shares * mark;
}

/** Mark-to-market total value: cash already booked + current position at mark. */
export function markToMarket(state: InventoryState, mark: number): number {
  return state.cashUsd + state.shares * mark;
}

export type CloseAction =
  | { action: 'flatten'; reason: string }
  | { action: 'hold'; reason: string };

/**
 * Hybrid window-close decision. Inside the flatten window, flatten if the net
 * inventory notional exceeds the configured threshold; otherwise hold the small
 * residual and let it resolve.
 */
export function closeGate(
  state: InventoryState,
  mark: number,
  timeToResolveSec: number,
  cfg: MakerConfig,
): CloseAction {
  if (timeToResolveSec > cfg.flattenBeforeSec) return { action: 'hold', reason: 'window_open' };
  if (state.shares === 0) return { action: 'hold', reason: 'flat' };
  const notional = Math.abs(state.shares * mark);
  if (notional > cfg.flattenIfNetAboveUsd) {
    return { action: 'flatten', reason: `inventory ${notional.toFixed(2)} > threshold` };
  }
  return { action: 'hold', reason: 'residual_small' };
}
