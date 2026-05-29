import axios from 'axios';
import { logger } from '../util/logger.js';
import { loadEnv } from '../util/config.js';
import type { Trade } from '../live/accounting.js';

const DATA_API = 'https://data-api.polymarket.com';

/**
 * Build a stable id for a single fill returned by data-api `/trades`. Multiple
 * fills can share a `transactionHash` when the matching engine batches several
 * matches into one on-chain tx, so hashing by tx alone collapses them and
 * silently drops every fill after the first (the bug this exists to prevent).
 * Prefers any per-trade identifier the API provides; falls back to a composite
 * of fields that uniquely identify a fill within its tx.
 */
export function deriveTradeId(r: any, tsMs: number): string {
  // A true per-fill id is always preferred.
  if (r.id != null) return String(r.id);
  if (r.tradeId != null) return String(r.tradeId);
  // Composite fallback. CRITICAL: concatenate ALL discriminator fields in a
  // FIXED order rather than picking the first present via `??`. The old `??`
  // chain produced a DIFFERENT id for the same fill when the API included a
  // discriminator (e.g. bucketIndex) in one poll and omitted it in the next —
  // so `account.seen` failed to dedup and the fill was counted again. That is
  // the mechanism behind the overnight reconciler churn (tracked drifting to
  // 71 vs 38 on-chain). Concatenating every field keeps batched fills distinct
  // AND keeps the id stable across polls regardless of which fields are present.
  return [
    r.transactionHash ?? '',
    r.bucketIndex ?? '',
    r.orderHash ?? '',
    r.takerOrderHash ?? '',
    r.makerOrderHash ?? '',
    r.side ?? '',
    r.price ?? '',
    r.size ?? '',
    tsMs,
  ].join('|');
}

/**
 * Fetch our executed trades for a token. Maps to accounting.Trade.
 *
 * Uses `/activity` (NOT `/trades`) because the public `/trades` endpoint only
 * returns fills where the user was the TAKER. As a maker-only bot, every one
 * of our fills appears solely on `/activity` with `type:"TRADE"`.
 *
 * `sinceMs` is a SOFT floor — we only return trades on or after this timestamp
 * MINUS a generous slack (5 minutes by default). This is critical: /activity
 * has variable polling lag, fills arrive out-of-order vs their event time,
 * and previously we used a strict `tsMs > sinceMs` filter that silently
 * dropped late-arriving fills. Combined with the per-window cursor reset,
 * lost fills became open positions the bot never accounted for (the
 * 2026-05-27 -$47 stuck-positions episode). Deduplication is now handled
 * exclusively by the caller's `seen` set — that is the canonical mechanism.
 */
const SINCE_SLACK_MS = 5 * 60_000;

/**
 * Fetch activity from the data-api for the calling user and parse all TRADE
 * events into Trade objects.  Shared by both the single-token and batch
 * variants so the HTTP call is never duplicated within a tick.
 */
async function fetchActivityRaw(floorMs: number): Promise<{ arr: any[]; ok: boolean }> {
  const user = loadEnv().clobFunderAddress;
  try {
    const { data } = await axios.get(`${DATA_API}/activity`, {
      params: { user, limit: 200 },
      timeout: 8000,
    });
    const arr: any[] = Array.isArray(data) ? data : (data?.activity ?? data?.data ?? []);
    return { arr, ok: true };
  } catch (err: any) {
    logger.error({ err: err.message }, 'fetchActivity failed');
    return { arr: [], ok: false };
  }
}

function parseTrades(arr: any[], tokenSet: Set<string>, floorMs: number): Map<string, Trade[]> {
  const result = new Map<string, Trade[]>();
  for (const id of tokenSet) result.set(id, []);
  for (const r of arr) {
    if (String(r.type ?? '').toUpperCase() !== 'TRADE') continue;
    const asset = String(r.asset ?? r.asset_id ?? r.tokenId ?? '');
    if (!tokenSet.has(asset)) continue;
    const tsMs = Number(r.timestamp ?? 0) > 1e12 ? Number(r.timestamp) : Number(r.timestamp ?? 0) * 1000;
    if (tsMs < floorMs) continue;
    result.get(asset)!.push({
      id: deriveTradeId(r, tsMs),
      side: String(r.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(r.price),
      shares: Number(r.size),
      tsMs,
    });
  }
  return result;
}

/**
 * Batch variant: fetch activity ONCE and return trades grouped by tokenId.
 * Use this instead of calling fetchOurTrades per-leg so the inner loop only
 * makes one HTTP round-trip per tick regardless of how many legs there are.
 */
export async function fetchAllOurTrades(
  tokenIds: string[],
  sinceMs: number,
): Promise<Map<string, Trade[]>> {
  const floorMs = sinceMs - SINCE_SLACK_MS;
  const { arr } = await fetchActivityRaw(floorMs);
  return parseTrades(arr, new Set(tokenIds), floorMs);
}

export async function fetchOurTrades(tokenId: string, sinceMs: number): Promise<Trade[]> {
  const floorMs = sinceMs - SINCE_SLACK_MS;
  const { arr } = await fetchActivityRaw(floorMs);
  return parseTrades(arr, new Set([tokenId]), floorMs).get(tokenId) ?? [];
}
