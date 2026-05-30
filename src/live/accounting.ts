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

/** Why `reconcileAccount` did or did not snap — surfaced in the log so the two
 *  "corrected:false" cases (within tolerance vs. an intentional suppression) are
 *  distinguishable post-hoc. 'snap' is the only corrected=true outcome. */
export type ReconcileReason = 'tolerance' | 'drift_negative' | 'avgprice_zero' | 'snap';

export interface ReconcileResult {
  account: Account;
  /** onchainShares - trackedShares (positive = we held more than we thought). */
  drift: number;
  corrected: boolean;
  reason: ReconcileReason;
}

/**
 * Reconcile a tracked account against the TRUE on-chain share count. The fill
 * poller can miss/lag trades, leaving `account.shares` wrong — which is how the
 * stuck-position leak happened. When the gap exceeds `toleranceShares` we snap
 * `shares` to the on-chain truth and adjust cash by `drift * avgPrice` using the
 * venue's real cost basis, so `pnl()` stays consistent.
 *
 * Pure. `avgPrice` is the on-chain volume-weighted cost; used only for drift > 0
 * (missed BUYs) AND only when it is > 0 — an avgPrice of 0 means the venue has not
 * indexed the fill's cost yet, so snapping would book the shares for free and break
 * the quoter's hedge ceiling; we skip that case too. For drift < 0 (tracked > on-chain)
 * we do NOT correct either: the SELL
 * fills are almost certainly just lagging in the /activity feed (typically 15-60 s
 * behind the chain). Adjusting cashUsd here AND then applying the real fill later
 * double-counts the sell proceeds — the observed cause of mark-PnL inflation and
 * negative-shares artefacts. We return corrected=false so the orchestrator skips
 * the update; the fill will self-correct shortly.
 */
export function reconcileAccount(
  a: Account,
  onchainShares: number,
  avgPrice: number,
  toleranceShares = 0.5,
): ReconcileResult {
  const drift = onchainShares - a.shares;
  if (Math.abs(drift) <= toleranceShares) {
    return { account: a, drift, corrected: false, reason: 'tolerance' };
  }
  // drift < 0: on-chain holds fewer shares than tracked — the SELL fills are
  // lagging in /activity. Do NOT credit cashUsd here; when the fills arrive they
  // will decrement shares and credit cash at the real sale price. Correcting
  // preemptively at cost-basis would double-count the proceeds once the fills land.
  if (drift < 0) {
    return { account: a, drift, corrected: false, reason: 'drift_negative' };
  }
  // drift > 0 but avgPrice == 0: the fill is on-chain but the venue's /positions
  // endpoint has not indexed its cost basis yet (freshly-opened position). Snapping
  // here would add shares at cost $0 — "free" inventory that drives the leg's
  // average cost to 0, which in turn collapses the quoter's dynamic hedge ceiling
  // to the hard 0.85 fallback and lets it BUY the pair above its profitable price
  // (the 2026-05-29 -$15 episode). Skip the correction; a later tick with a real
  // avgPrice (or the lagging fill itself) will book the shares at their true cost.
  if (avgPrice === 0) {
    return { account: a, drift, corrected: false, reason: 'avgprice_zero' };
  }
  // drift > 0: missed BUYs — we hold more than tracked. Snap to truth and debit
  // cash at the on-chain cost basis (the best available approximation).
  const account: Account = {
    shares: onchainShares,
    cashUsd: a.cashUsd - drift * avgPrice,
    seen: a.seen,
  };
  return { account, drift, corrected: true, reason: 'snap' };
}

/** Per-leg state for debouncing reconcile corrections. */
export interface DriftWatch {
  /** Sign of the drift observed continuously so far: -1, 0 (none), or +1. */
  sign: number;
  /** Epoch ms when the current same-sign run of drift first appeared. */
  sinceMs: number;
}

export function newDriftWatch(): DriftWatch {
  return { sign: 0, sinceMs: 0 };
}

/**
 * How long (ms) a beyond-tolerance drift has persisted with the SAME sign.
 * Returns 0 when the drift is within tolerance or its sign just flipped (both
 * reset the watch). Mutates `w`.
 *
 * DEBOUNCE rationale: /activity fills lag the chain by ~15-60 s. A drift that
 * has only just appeared is almost always a lagging fill that self-closes once
 * it lands — `reconcileAccount` snapping immediately AND `applyTrade` re-adding
 * the fill double-counts the shares (the 2026-05-29 NO leg reached 43.3 tracked
 * vs 21.7 on-chain → inflated -$7.25 PnL and a false halt). The orchestrator
 * only applies a correction once this exceeds `reconcileMinPersistMs`, by which
 * point a merely-lagging fill would have arrived; a still-open drift means the
 * trade was genuinely missed (the original stuck-position leak), so we snap.
 */
export function driftPersistedMs(
  w: DriftWatch,
  drift: number,
  nowMs: number,
  toleranceShares = 0.5,
): number {
  const sign = Math.abs(drift) <= toleranceShares ? 0 : Math.sign(drift);
  if (sign === 0) {
    w.sign = 0;
    w.sinceMs = 0;
    return 0;
  }
  if (sign !== w.sign) {
    w.sign = sign;
    w.sinceMs = nowMs;
    return 0;
  }
  return nowMs - w.sinceMs;
}
