// tests/live/accounting.test.ts
import { describe, it, expect } from 'vitest';
import { emptyAccount, applyTrade, type Trade } from '../../src/live/accounting.js';

describe('accounting', () => {
  it('a buy then a sell at a higher price books positive cash', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    a = applyTrade(a, { id: 't2', side: 'SELL', price: 0.53, shares: 6, tsMs: 2 });
    expect(a.shares).toBeCloseTo(0, 6);
    expect(a.cashUsd).toBeCloseTo(6 * 0.53 - 6 * 0.49, 6);
  });

  it('ignores a trade id already seen (idempotent polling)', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    expect(a.shares).toBeCloseTo(6, 6);
  });

  it('realizedPnl marks residual shares at a settle price', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    expect(realized(a, 1)).toBeCloseTo(6 * 1 - 6 * 0.49, 6); // YES won
    expect(realized(a, 0)).toBeCloseTo(-6 * 0.49, 6);        // YES lost
  });
});

function realized(a: { cashUsd: number; shares: number }, settle: number): number {
  return a.cashUsd + a.shares * settle;
}
