import { getOpenPositions } from './positions.js';
import { logger } from '../util/logger.js';

export interface OnchainLeg {
  /** Shares actually held on-chain for this token (ground truth). */
  shares: number;
  /** Volume-weighted cost basis from the venue — the real price we paid. */
  avgPrice: number;
}

/**
 * Read the wallet's TRUE on-chain share holdings for the given tokens. This is
 * the ground truth that the fill-poller (`fetchOurTrades` over /activity, ~15-20s
 * lag) can drift from — the source of the stuck-position leak. The orchestrator
 * uses it to detect and correct drift.
 *
 * Returns a Map keyed by tokenId. A token ABSENT from the map means a confirmed
 * zero on-chain position (the query succeeded but the wallet holds none).
 * Returns `null` if the query FAILED — the caller must then skip reconciliation
 * this cycle rather than treating everything as flat.
 */
export async function fetchOnchainShares(tokenIds: string[]): Promise<Map<string, OnchainLeg> | null> {
  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err: any) {
    logger.warn({ err: err.message }, 'fetchOnchainShares failed — skipping reconciliation this cycle');
    return null;
  }
  const wanted = new Set(tokenIds);
  const out = new Map<string, OnchainLeg>();
  for (const p of positions) {
    if (!wanted.has(p.tokenId)) continue;
    out.set(p.tokenId, { shares: p.size, avgPrice: p.avgPrice });
  }
  return out;
}
