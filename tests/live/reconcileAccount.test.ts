import { describe, it, expect } from 'vitest';
import { emptyAccount, applyTrade, reconcileAccount, pnl } from '../../src/live/accounting.js';

describe('reconcileAccount', () => {
  it('no correction when within tolerance', () => {
    const a = applyTrade(emptyAccount(), { id: 't1', side: 'BUY', price: 0.4, shares: 6, tsMs: 1 });
    const r = reconcileAccount(a, 6.2, 0.4, 0.5);
    expect(r.corrected).toBe(false);
    expect(r.account.shares).toBe(6);
  });

  it('snaps shares up to on-chain truth on a missed BUY and debits cash at cost basis', () => {
    // Tracker thinks flat; on-chain we actually hold 10 shares bought at 0.30.
    const a = emptyAccount();
    const r = reconcileAccount(a, 10, 0.3, 0.5);
    expect(r.corrected).toBe(true);
    expect(r.drift).toBe(10);
    expect(r.account.shares).toBe(10);
    expect(r.account.cashUsd).toBeCloseTo(-3.0, 6); // 10 * 0.30 spent
    // PnL if the position settles to 1 = -3 + 10*1 = +7 (consistent with reality)
    expect(pnl(r.account, 1)).toBeCloseTo(7, 6);
    expect(pnl(r.account, 0)).toBeCloseTo(-3, 6);
  });

  it('snaps shares down when on-chain holds fewer than tracked', () => {
    let a = applyTrade(emptyAccount(), { id: 'b', side: 'BUY', price: 0.5, shares: 10, tsMs: 1 });
    // On-chain only 4 remain (6 were sold without us recording it).
    const r = reconcileAccount(a, 4, 0.5, 0.5);
    expect(r.corrected).toBe(true);
    expect(r.drift).toBe(-6);
    expect(r.account.shares).toBe(4);
    // cash = -5 (original) - (-6 * 0.5) = -5 + 3 = -2
    expect(r.account.cashUsd).toBeCloseTo(-2, 6);
  });

  it('preserves the seen set so dedup keeps working after correction', () => {
    let a = applyTrade(emptyAccount(), { id: 'x', side: 'BUY', price: 0.4, shares: 6, tsMs: 1 });
    const r = reconcileAccount(a, 12, 0.4, 0.5);
    expect(r.account.seen.has('x')).toBe(true);
  });
});
