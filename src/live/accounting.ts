// src/live/accounting.ts
export interface Trade { id: string; side: 'BUY' | 'SELL'; price: number; shares: number; tsMs: number; }
export interface Account { shares: number; cashUsd: number; seen: Set<string>; }

export function emptyAccount(): Account {
  return { shares: 0, cashUsd: 0, seen: new Set() };
}

export function applyTrade(a: Account, t: Trade): Account {
  if (a.seen.has(t.id)) return a;
  const seen = new Set(a.seen);
  seen.add(t.id);
  const signedShares = t.side === 'BUY' ? t.shares : -t.shares;
  const cashDelta = t.side === 'BUY' ? -t.price * t.shares : t.price * t.shares;
  return { shares: a.shares + signedShares, cashUsd: a.cashUsd + cashDelta, seen };
}

/** Realized+unrealized PnL marking residual shares at `settle` (0/1 or mid). */
export function pnl(a: Account, settle: number): number {
  return a.cashUsd + a.shares * settle;
}

export interface ReconcileResult {
  account: Account;
  /** onchainShares - trackedShares (positive = we held more than we thought). */
  drift: number;
  corrected: boolean;
}

/**
 * Reconcile a tracked account against the TRUE on-chain share count. The fill
 * poller can miss/lag trades, leaving `account.shares` wrong — which is how the
 * stuck-position leak happened. When the gap exceeds `toleranceShares` we snap
 * `shares` to the on-chain truth and adjust cash by `drift * avgPrice` using the
 * venue's real cost basis, so `pnl()` stays consistent.
 *
 * Pure. `avgPrice` is the on-chain volume-weighted cost; for the dangerous
 * direction (missed BUYs -> drift > 0) it is exactly right. For drift < 0
 * (untracked sells) it is an approximation (cost basis, not sale price).
 */
export function reconcileAccount(
  a: Account,
  onchainShares: number,
  avgPrice: number,
  toleranceShares = 0.5,
): ReconcileResult {
  const drift = onchainShares - a.shares;
  if (Math.abs(drift) <= toleranceShares) {
    return { account: a, drift, corrected: false };
  }
  // We acquired `drift` shares we didn't book -> we spent ~drift*avgPrice cash.
  const account: Account = {
    shares: onchainShares,
    cashUsd: a.cashUsd - drift * avgPrice,
    seen: a.seen,
  };
  return { account, drift, corrected: true };
}
