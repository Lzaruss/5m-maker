import { describe, it, expect } from 'vitest';
import {
  emptyAccount,
  applyTrade,
  reconcileAccount,
  pnl,
  driftPersistedMs,
  newDriftWatch,
} from '../../src/live/accounting.js';

describe('reconcileAccount', () => {
  it('no correction when within tolerance', () => {
    const a = applyTrade(emptyAccount(), { id: 't1', side: 'BUY', price: 0.4, shares: 6, tsMs: 1 });
    const r = reconcileAccount(a, 6.2, 0.4, 0.5);
    expect(r.corrected).toBe(false);
    expect(r.reason).toBe('tolerance');
    expect(r.account.shares).toBe(6);
  });

  it('snaps shares up to on-chain truth on a missed BUY and debits cash at cost basis', () => {
    // Tracker thinks flat; on-chain we actually hold 10 shares bought at 0.30.
    const a = emptyAccount();
    const r = reconcileAccount(a, 10, 0.3, 0.5);
    expect(r.corrected).toBe(true);
    expect(r.reason).toBe('snap');
    expect(r.drift).toBe(10);
    expect(r.account.shares).toBe(10);
    expect(r.account.cashUsd).toBeCloseTo(-3.0, 6); // 10 * 0.30 spent
    // PnL if the position settles to 1 = -3 + 10*1 = +7 (consistent with reality)
    expect(pnl(r.account, 1)).toBeCloseTo(7, 6);
    expect(pnl(r.account, 0)).toBeCloseTo(-3, 6);
  });

  it('does NOT snap shares down for drift < 0 — avoids double-counting delayed SELL fills', () => {
    let a = applyTrade(emptyAccount(), { id: 'b', side: 'BUY', price: 0.5, shares: 10, tsMs: 1 });
    // On-chain only 4 remain (6 were sold without us recording it yet).
    // The SELL fills are lagging in /activity — correcting here + applying the fill
    // later would double-count the proceeds, producing negative shares and inflated
    // cashUsd (the observed mark-PnL inflation bug).
    const r = reconcileAccount(a, 4, 0.5, 0.5);
    expect(r.corrected).toBe(false);
    expect(r.reason).toBe('drift_negative');
    expect(r.drift).toBe(-6);
    // account unchanged — fill will arrive via /activity and self-correct
    expect(r.account.shares).toBe(10);
    expect(r.account.cashUsd).toBeCloseTo(-5, 6);
  });

  it('does NOT snap up when drift > 0 but avgPrice is 0 — avoids booking free shares', () => {
    // On-chain shows 10 shares we don't track, but the venue has not indexed their
    // cost yet (avgPrice=0). Snapping would set shares=10, cashUsd=0 → avgCost 0,
    // which collapses the quoter's hedge ceiling. Skip until a real cost arrives.
    const a = emptyAccount();
    const r = reconcileAccount(a, 10, 0, 0.5);
    expect(r.corrected).toBe(false);
    expect(r.reason).toBe('avgprice_zero');
    expect(r.drift).toBe(10);
    expect(r.account.shares).toBe(0);
    expect(r.account.cashUsd).toBe(0);
  });

  it('preserves the seen set so dedup keeps working after correction', () => {
    let a = applyTrade(emptyAccount(), { id: 'x', side: 'BUY', price: 0.4, shares: 6, tsMs: 1 });
    const r = reconcileAccount(a, 12, 0.4, 0.5);
    expect(r.account.seen.has('x')).toBe(true);
  });
});

describe('driftPersistedMs (reconcile debounce)', () => {
  it('returns 0 within tolerance and resets the watch', () => {
    const w = newDriftWatch();
    expect(driftPersistedMs(w, 0.3, 1000, 0.5)).toBe(0);
    expect(w.sign).toBe(0);
  });

  it('reports 0 on first sight of a drift, then accumulates while it persists', () => {
    const w = newDriftWatch();
    expect(driftPersistedMs(w, 10, 1000)).toBe(0); // first sight -> start the clock
    expect(driftPersistedMs(w, 12, 9000)).toBe(8000); // same sign, 8s later
    expect(driftPersistedMs(w, 22, 65000)).toBe(64000); // still persisting
  });

  it('resets when the lagging fill lands (drift collapses to ~0)', () => {
    const w = newDriftWatch();
    driftPersistedMs(w, 21.7, 1000); // missed-BUY drift appears
    driftPersistedMs(w, 21.7, 5000); // still open at 4s
    // Fill lands -> tracked catches up -> drift within tolerance -> watch resets.
    expect(driftPersistedMs(w, 0.0, 9000)).toBe(0);
    // A fresh drift afterwards starts its own clock, not the old one.
    expect(driftPersistedMs(w, 5, 12000)).toBe(0);
  });

  it('restarts the clock when the drift flips sign', () => {
    const w = newDriftWatch();
    driftPersistedMs(w, 10, 1000); // +drift
    expect(driftPersistedMs(w, -10, 5000)).toBe(0); // sign flip -> restart
    expect(driftPersistedMs(w, -12, 9000)).toBe(4000);
  });
});
