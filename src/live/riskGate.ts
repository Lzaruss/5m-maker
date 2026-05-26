// src/live/riskGate.ts
export interface RiskState {
  realizedPnlTodayUsd: number; // negative = loss
  deployedUsd: number;         // live-order notional + |inventory| value
  inventoryUsd: number;        // signed: + long YES, - short
  maxDeployedUsd: number;
  dailyLossHaltUsd: number;    // positive number; halt when realized <= -this
  maxInventoryUsd: number;
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
  const allowBuy = s.inventoryUsd < s.maxInventoryUsd;
  const allowSell = s.inventoryUsd > -s.maxInventoryUsd;
  return { halted: false, allowBuy, allowSell, reason: 'ok' };
}
