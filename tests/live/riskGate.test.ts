// tests/live/riskGate.test.ts
import { describe, it, expect } from 'vitest';
import { checkGates, type RiskState } from '../../src/live/riskGate.js';

const base: RiskState = {
  realizedPnlTodayUsd: 0,
  deployedUsd: 0,
  inventoryUsd: 0,
  maxDeployedUsd: 50,
  dailyLossHaltUsd: 20,
  maxInventoryUsd: 15,
  cashUsd: 100,
  cashFloorUsd: 0,
};

describe('checkGates', () => {
  it('allows both sides when flat and within limits', () => {
    const g = checkGates(base);
    expect(g.halted).toBe(false);
    expect(g.allowBuy).toBe(true);
    expect(g.allowSell).toBe(true);
  });

  it('halts at the daily loss cap', () => {
    const g = checkGates({ ...base, realizedPnlTodayUsd: -20 });
    expect(g.halted).toBe(true);
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(false);
  });

  it('blocks adding when deployed capital is at the cap', () => {
    const g = checkGates({ ...base, deployedUsd: 50 });
    expect(g.halted).toBe(false);
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(false);
  });

  it('blocks buys when long inventory at cap, still allows sells', () => {
    const g = checkGates({ ...base, inventoryUsd: 15 });
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(true);
  });

  it('blocks sells when short inventory at cap, still allows buys', () => {
    const g = checkGates({ ...base, inventoryUsd: -15 });
    expect(g.allowSell).toBe(false);
    expect(g.allowBuy).toBe(true);
  });

  it('suppresses BUY but keeps SELL when cash is below the floor', () => {
    const g = checkGates({ ...base, cashUsd: 12, cashFloorUsd: 20 });
    expect(g.halted).toBe(false);
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(true);
    expect(g.reason).toBe('cash_floor');
  });

  it('ignores the cash floor when cash is unknown (NaN balance read)', () => {
    const g = checkGates({ ...base, cashUsd: NaN, cashFloorUsd: 20 });
    expect(g.allowBuy).toBe(true);
    expect(g.reason).toBe('ok');
  });

  it('cash floor of 0 disables the gate', () => {
    const g = checkGates({ ...base, cashUsd: 0, cashFloorUsd: 0 });
    expect(g.allowBuy).toBe(true);
  });
});
