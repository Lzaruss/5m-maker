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
  return String(
    r.id ??
      r.tradeId ??
      [
        r.transactionHash ?? '',
        r.bucketIndex ?? r.orderHash ?? r.takerOrderHash ?? r.makerOrderHash ?? '',
        r.side ?? '',
        r.price ?? '',
        r.size ?? '',
        tsMs,
      ].join('|'),
  );
}

/**
 * Fetch our executed trades for a token since `sinceMs`. Maps to accounting.Trade.
 *
 * Uses `/activity` (NOT `/trades`) because the public `/trades` endpoint only
 * returns fills where the user was the TAKER. As a maker-only bot, every one of
 * our fills appears solely on `/activity` with `type:"TRADE"`. Hitting the
 * wrong endpoint silently returned [] for us and left the bot's internal
 * accounting permanently flat while real orders filled on chain — the root
 * cause of the 2026-05-26 19:23 UTC -$7.63 loss (no skew, no flatten, no halt).
 */
export async function fetchOurTrades(tokenId: string, sinceMs: number): Promise<Trade[]> {
  const user = loadEnv().clobFunderAddress;
  try {
    const { data } = await axios.get(`${DATA_API}/activity`, {
      params: { user, limit: 200 },
      timeout: 15000,
    });
    const arr: any[] = Array.isArray(data) ? data : (data?.activity ?? data?.data ?? []);
    const out: Trade[] = [];
    for (const r of arr) {
      // /activity returns TRADE, REDEEM, SPLIT, MERGE, ... — only TRADE is a fill.
      if (String(r.type ?? '').toUpperCase() !== 'TRADE') continue;
      const asset = String(r.asset ?? r.asset_id ?? r.tokenId ?? '');
      if (asset !== tokenId) continue;
      const tsMs = Number(r.timestamp ?? 0) > 1e12 ? Number(r.timestamp) : Number(r.timestamp ?? 0) * 1000;
      if (tsMs <= sinceMs) continue;
      out.push({
        id: deriveTradeId(r, tsMs),
        side: String(r.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        price: Number(r.price),
        shares: Number(r.size),
        tsMs,
      });
    }
    return out;
  } catch (err: any) {
    logger.error({ err: err.message }, 'fetchOurTrades failed');
    return [];
  }
}
