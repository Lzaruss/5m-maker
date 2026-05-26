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
