// src/live/riskGate.ts
export interface RiskState {
  realizedPnlTodayUsd: number; // negative = loss
  deployedUsd: number;         // live-order notional + |inventory| value
  inventoryUsd: number;        // signed: + long YES, - short
  maxDeployedUsd: number;
  dailyLossHaltUsd: number;    // positive number; halt when realized <= -this
  maxInventoryUsd: number;
  /** Liquid USDC on chain. NaN when unknown (gate is skipped). */
  cashUsd: number;
  /** Suppress BUYs once cashUsd drops below this. 0 disables. */
  cashFloorUsd: number;
}

export interface GateResult {
  halted: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  reason: string;
}

export function checkGates(s: RiskState): GateResult {
  if (s.realizedPnlTodayUsd <= -s.dailyLossHaltUsd) {
    return { halted: true, allowBuy: false, allowSell: false, reason: 'daily_loss_halt' };
  }
  if (s.deployedUsd >= s.maxDeployedUsd) {
    return { halted: false, allowBuy: false, allowSell: false, reason: 'max_deployed' };
  }
  // Cash-floor breaker: when liquid USDC runs low, stop opening NEW BUYs but
  // KEEP selling/flattening enabled so the bot can still raise cash and unwind.
  // Skipped when cash is unknown (NaN) to avoid freezing on a failed balance read.
  if (s.cashFloorUsd > 0 && Number.isFinite(s.cashUsd) && s.cashUsd < s.cashFloorUsd) {
    return { halted: false, allowBuy: false, allowSell: true, reason: 'cash_floor' };
  }
  const allowBuy = s.inventoryUsd < s.maxInventoryUsd;
  const allowSell = s.inventoryUsd > -s.maxInventoryUsd;
  return { halted: false, allowBuy, allowSell, reason: 'ok' };
}
