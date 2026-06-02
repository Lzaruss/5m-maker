import { getOpenPositions } from './positions.js';
import { logger } from '../util/logger.js';

export interface OnchainLeg {
  /** Shares actually held on-chain for this token (ground truth). */
  shares: number;
  /** Volume-weighted cost basis from the venue — the real price we paid. */
  avgPrice: number;
}

// ── Circuit breaker ────────────────────────────────────────────────────────
// After repeated failures we stop hammering the data-api and back off
// exponentially. Resets automatically on the first successful call.
let _consecFailures = 0;
let _backoffUntilMs = 0;

function _backoffMs(failures: number): number {
  // 0-2 failures  → no backoff (retry every cycle)
  // 3-9 failures  → 60 s
  // 10-19 failures → 5 min
  // 20+ failures  → 30 min
  if (failures < 3)  return 0;
  if (failures < 10) return 60_000;
  if (failures < 20) return 5 * 60_000;
  return 30 * 60_000;
}
// ──────────────────────────────────────────────────────────────────────────

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
  // Circuit breaker: skip the HTTP call entirely while in backoff window.
  if (_backoffUntilMs > 0 && Date.now() < _backoffUntilMs) return null;

  let positions;
  try {
    positions = await getOpenPositions();
    // Success — reset circuit breaker.
    if (_consecFailures > 0) {
      logger.info({ prevFailures: _consecFailures }, 'fetchOnchainShares recovered — reconciliation resumed');
      _consecFailures = 0;
      _backoffUntilMs = 0;
    }
  } catch (err: any) {
    _consecFailures++;
    const nextBackoff = _backoffMs(_consecFailures);
    _backoffUntilMs = nextBackoff > 0 ? Date.now() + nextBackoff : 0;
    const logFn = _consecFailures <= 3 ? logger.warn.bind(logger) : logger.debug.bind(logger);
    logFn(
      { err: err.message, consecFailures: _consecFailures, backoffSec: Math.round(nextBackoff / 1000) },
      'fetchOnchainShares failed — skipping reconciliation this cycle',
    );
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
