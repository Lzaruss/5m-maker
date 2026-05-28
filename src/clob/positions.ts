import axios from 'axios';
import { loadEnv } from '../util/config.js';
import { getUsdcBalance } from './client.js';

export interface ClobPosition {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  redeemable: boolean;
  title: string;
}

const DATA_API = 'https://data-api.polymarket.com';

/**
 * Fetch all open + redeemable positions for the configured funder wallet.
 *
 * Correct endpoint is `/positions?user=ADDR` (NOT `/user/ADDR/positions`)
 * and fields use camelCase (`avgPrice`, `currentValue`, `redeemable`) — not
 * snake_case as the previous version assumed.
 *
 * After a binary market resolves:
 *   - winning side: position remains here with `redeemable: true` until you
 *     call `redeem()`. `currentValue ≈ size * $1`.
 *   - losing side: position is removed from the list (`size: 0`).
 */
export async function getOpenPositions(): Promise<ClobPosition[]> {
  const env = loadEnv();
  const url = `${DATA_API}/positions?user=${env.clobFunderAddress}&limit=100`;
  const response = await axios.get(url, { timeout: 10_000 });
  const arr: any[] = Array.isArray(response.data) ? response.data : [];
  return arr
    .map((p: any) => ({
      tokenId: String(p.asset ?? ''),
      conditionId: String(p.conditionId ?? ''),
      outcome: String(p.outcome ?? ''),
      size: Number(p.size ?? 0),
      avgPrice: Number(p.avgPrice ?? 0),
      currentValue: Number(p.currentValue ?? 0),
      cashPnl: Number(p.cashPnl ?? 0),
      redeemable: Boolean(p.redeemable),
      title: String(p.title ?? ''),
    }))
    .filter((p: ClobPosition) => p.size > 0);
}

/**
 * Find a specific position by tokenId. Returns null if not in the list
 * (which means either never held, already redeemed, or lost on resolution).
 */
export async function findPosition(tokenId: string): Promise<ClobPosition | null> {
  const positions = await getOpenPositions();
  return positions.find((p) => p.tokenId === tokenId) ?? null;
}

export interface AccountValue {
  /** Liquid USDC in the wallet. */
  cashUsd: number;
  /** Market value of ALL open token positions (winning + still-open). */
  positionValueUsd: number;
  /** Subset of positionValueUsd that is claimable NOW (resolved winners not
   *  yet redeemed). This capital is "stuck" until redeem() is called. */
  redeemableUsd: number;
  /** cashUsd + positionValueUsd — the honest mark-to-market net worth. */
  netWorthUsd: number;
  openCount: number;
  redeemableCount: number;
  positions: ClobPosition[];
}

/**
 * The single source of truth for "how are we actually doing". Combines the
 * liquid USDC balance with the market value of held tokens. This is what the
 * operator should compare against the bot's INTERNAL mark P&L (`realizedTodayUsd`)
 * — a large gap means profit is locked in unredeemed tokens (or the internal
 * tracker over-counted shares the reconciler later corrected).
 */
export async function getAccountValue(): Promise<AccountValue> {
  const [positions, cashUsd] = await Promise.all([getOpenPositions(), getUsdcBalance()]);
  let positionValueUsd = 0;
  let redeemableUsd = 0;
  let redeemableCount = 0;
  for (const p of positions) {
    positionValueUsd += p.currentValue;
    if (p.redeemable) {
      redeemableUsd += p.currentValue;
      redeemableCount++;
    }
  }
  return {
    cashUsd,
    positionValueUsd,
    redeemableUsd,
    netWorthUsd: cashUsd + positionValueUsd,
    openCount: positions.length,
    redeemableCount,
    positions,
  };
}

export interface RedeemEvent {
  conditionId: string;
  size: number;
  usdcSize: number;
  timestamp: number;
}

/**
 * Check the user's recent activity for a REDEEM event matching a conditionId.
 *
 * Polymarket only allows redemption of WINNING shares — a REDEEM event
 * with size > 0 after the market resolved means we won. Without this
 * check, "position absent from /positions" is ambiguous between
 * "lost (worthless shares pruned)" and "won + already redeemed".
 *
 * IMPORTANT: REDEEM events in the activity API have `asset: ''` (empty),
 * so we match by `conditionId` instead. That's why OpenPosition tracks
 * `conditionId` alongside `tokenId`.
 */
export async function findRedeem(conditionId: string, afterMs = 0): Promise<RedeemEvent | null> {
  const env = loadEnv();
  const url = `${DATA_API}/activity?user=${env.clobFunderAddress}&limit=100`;
  const response = await axios.get(url, { timeout: 10_000 });
  const arr: any[] = Array.isArray(response.data) ? response.data : [];
  for (const a of arr) {
    if (String(a.type ?? '').toUpperCase() !== 'REDEEM') continue;
    if (String(a.conditionId ?? '') !== conditionId) continue;
    const size = Number(a.size ?? 0);
    if (size <= 0) continue; // noop redeems with size=0 — ignore
    const ts = Number(a.timestamp ?? 0) * 1000;
    if (ts < afterMs - 5 * 60_000) continue;
    return {
      conditionId,
      size,
      usdcSize: Number(a.usdcSize ?? size),
      timestamp: ts,
    };
  }
  return null;
}
