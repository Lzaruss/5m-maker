import axios from 'axios';
import { logger } from '../util/logger.js';
import { assetOf, type Asset } from '../util/assets.js';

const GAMMA = 'https://gamma-api.polymarket.com';

export interface ShortMarket {
  id: string;
  conditionId: string;
  question: string;
  asset: Asset;
  windowMinutes: number;
  yesTokenId: string;
  noTokenId: string;
  resolvesAt: Date;
  /** Liquidity-rewards config (from Gamma). Orders within `rewardsMaxSpread`
   *  cents of the mid and of at least `rewardsMinSize` shares earn daily USDC
   *  rewards — but ONLY if a non-null reward rate is actually configured (see
   *  `rewardsRates`, fetched from the CLOB). Null when the field is absent. */
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
  /** Gamma's reported book spread at discovery time (reference snapshot). */
  gammaSpread: number | null;
  /** Fee schedule (from Gamma `feeSchedule`). Taker fee in USDC =
   *  `shares * feeRate * (p*(1-p))^feeExponent`. Makers pay 0 when takerOnly. */
  feeRate: number | null;
  feeExponent: number | null;
  feeTakerOnly: boolean | null;
  /** Fraction of taker fees rebated to makers (e.g. 0.2 = 20% on crypto). */
  rebateRate: number | null;
}

/** Window length in minutes parsed from the "h:mmam-h:mmpm" range in the question. */
export function windowMinutes(question: string): number | null {
  const m = question.match(/(\d{1,2}):(\d{2})(am|pm)-(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return null;
  let h1 = parseInt(m[1], 10);
  const min1 = parseInt(m[2], 10);
  const ap1 = m[3].toLowerCase();
  let h2 = parseInt(m[4], 10);
  const min2 = parseInt(m[5], 10);
  const ap2 = m[6].toLowerCase();
  if (ap1 === 'pm' && h1 !== 12) h1 += 12;
  if (ap1 === 'am' && h1 === 12) h1 = 0;
  if (ap2 === 'pm' && h2 !== 12) h2 += 12;
  if (ap2 === 'am' && h2 === 12) h2 = 0;
  let diff = h2 * 60 + min2 - (h1 * 60 + min1);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

interface GammaMarketRaw {
  id: number | string;
  question: string;
  conditionId: string;
  endDate?: string;
  clobTokenIds?: string[] | string;
  acceptingOrders?: boolean;
  rewardsMaxSpread?: number | string;
  rewardsMinSize?: number | string;
  spread?: number | string;
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean; rebateRate?: number };
}

function numOrNull(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTokenIds(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Gamma API circuit breaker.
//
// Polymarket's Gamma API occasionally goes 500 for minutes at a time. Without
// backoff our 2s poll cycle floods the log with hundreds of identical errors
// and burns rate-limit budget. This tracks consecutive failures and exposes
// the recommended sleep so the orchestrator can wait before retrying. Backoff
// is exponential capped at 60s with ±20% jitter; one success resets it.
// Logging is throttled to (first failure) + (every 30s during outage) +
// (recovery).
//
// Additionally, fetchMarkets / fetchResolution retry 5xx responses up to
// GAMMA_MAX_RETRIES times (with a 1s pause) before escalating to the circuit
// breaker. This absorbs the short-lived transient 500s that Polymarket emits
// occasionally without incrementing the failure counter.
// ---------------------------------------------------------------------------
let gammaFailures = 0;
let lastErrorLogMs = 0;

const GAMMA_MAX_RETRIES = 2;
const GAMMA_RETRY_DELAY_MS = 1_000;

/** Recommended ms to sleep before the next fetchMarkets attempt. 0 if healthy.
 *  Includes ±20% jitter to prevent a thundering-herd if multiple processes
 *  restart simultaneously. */
export function gammaBackoffMs(): number {
  if (gammaFailures === 0) return 0;
  const base = Math.min(60_000, 2_000 * Math.pow(2, gammaFailures - 1)); // 2,4,8,16,32,60,60...
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.round(base + jitter);
}

/** Returns true when the error is a server-side 5xx that is worth retrying. */
function isRetryable(err: any): boolean {
  const status: number | undefined = err?.response?.status;
  return status !== undefined && status >= 500 && status < 600;
}

/** Sleep helper local to this module. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch imminent Up/Down markets for the given assets and window size.
 * Sorted soonest-resolving first. Returns [] on error AND on no-match.
 */
export async function fetchMarkets(assets: Asset[], windowMin: number): Promise<ShortMarket[]> {
  try {
    const nowIso = new Date().toISOString();
    const url = `${GAMMA}/markets?active=true&closed=false&limit=500&order=endDate&ascending=true&end_date_min=${encodeURIComponent(nowIso)}`;

    let response: Awaited<ReturnType<typeof axios.get<GammaMarketRaw[]>>>;
    let attempt = 0;
    while (true) {
      try {
        response = await axios.get<GammaMarketRaw[]>(url, { timeout: 15000 });
        break;
      } catch (retryErr: any) {
        attempt++;
        if (attempt <= GAMMA_MAX_RETRIES && isRetryable(retryErr)) {
          logger.debug(
            { attempt, status: retryErr?.response?.status },
            'Gamma fetchMarkets 5xx — retrying',
          );
          await sleep(GAMMA_RETRY_DELAY_MS);
          continue;
        }
        throw retryErr;
      }
    }
    const raw = Array.isArray(response.data) ? response.data : [];
    const wanted = new Set(assets);

    if (gammaFailures > 0) {
      logger.info({ priorFailures: gammaFailures }, 'Gamma API recovered');
    }
    gammaFailures = 0;

    const out: ShortMarket[] = [];
    for (const m of raw) {
      const q = m.question ?? '';
      if (!q.toLowerCase().includes('up or down') && !q.toLowerCase().includes('up/down')) continue;
      const asset = assetOf(q);
      if (!asset || !wanted.has(asset)) continue;
      if (windowMinutes(q) !== windowMin) continue;
      if (m.acceptingOrders === false) continue;
      if (!m.endDate) continue;

      const tokens = parseTokenIds(m.clobTokenIds);
      if (tokens.length !== 2) continue;

      const resolvesAt = new Date(m.endDate);
      if (isNaN(resolvesAt.getTime())) continue;

      out.push({
        id: String(m.id),
        conditionId: String(m.conditionId ?? ''),
        question: q,
        asset,
        windowMinutes: windowMin,
        yesTokenId: tokens[0],
        noTokenId: tokens[1],
        resolvesAt,
        rewardsMaxSpread: numOrNull(m.rewardsMaxSpread),
        rewardsMinSize: numOrNull(m.rewardsMinSize),
        gammaSpread: numOrNull(m.spread),
        feeRate: numOrNull(m.feeSchedule?.rate),
        feeExponent: numOrNull(m.feeSchedule?.exponent),
        feeTakerOnly: typeof m.feeSchedule?.takerOnly === 'boolean' ? m.feeSchedule.takerOnly : null,
        rebateRate: numOrNull(m.feeSchedule?.rebateRate),
      });
    }

    out.sort((a, b) => a.resolvesAt.getTime() - b.resolvesAt.getTime());
    logger.debug({ count: out.length, assets, windowMin }, 'Fetched markets');
    return out;
  } catch (err: any) {
    gammaFailures++;
    // Throttle logging: warn on the first failure, then only once per 30s
    // during the outage. The orchestrator already pauses with backoff so
    // there's no decision being made on every silent retry.
    const now = Date.now();
    if (gammaFailures === 1 || now - lastErrorLogMs >= 30_000) {
      logger.warn(
        { error: err.message, consecutiveFailures: gammaFailures, nextBackoffMs: gammaBackoffMs() },
        'Gamma API failing',
      );
      lastErrorLogMs = now;
    }
    return [];
  }
}

const CLOB = 'https://clob.polymarket.com';

export interface ClobRewards {
  /** Reward emission rates. null/empty => the market pays NO liquidity rewards
   *  (the case for 5m crypto markets as of 2026-05). Non-empty => active pool. */
  rates: unknown[] | null;
  minSize: number | null;
  maxSpread: number | null;
}

/**
 * Authoritative liquidity-rewards config from the CLOB market object. Gamma
 * exposes `rewardsMinSize`/`rewardsMaxSpread` but NOT whether a reward rate is
 * actually funded — only the CLOB `rewards.rates` field tells us that. We record
 * it so a future reward model has ground truth (and so we notice if/when these
 * markets start paying rewards). Returns null on error.
 */
export async function fetchClobRewards(conditionId: string): Promise<ClobRewards | null> {
  if (!conditionId) return null;
  try {
    const resp = await axios.get<any>(`${CLOB}/markets/${conditionId}`, { timeout: 15000 });
    const r = resp.data?.rewards;
    if (!r) return { rates: null, minSize: null, maxSpread: null };
    return {
      rates: Array.isArray(r.rates) ? r.rates : null,
      minSize: numOrNull(r.min_size),
      maxSpread: numOrNull(r.max_spread),
    };
  } catch (err: any) {
    logger.debug({ error: err.message, conditionId }, 'fetchClobRewards failed');
    return null;
  }
}

export interface Resolution {
  /** True if the "Up" (YES, token index 0) outcome won. */
  yesWon: boolean;
  /** Settled price of the Up outcome (~1 if Up won, ~0 if Down won). */
  upPrice: number;
}

/**
 * Read a market's resolution by its YES token id. Works even while the market
 * still reports `closed:false`: once settled, `outcomePrices` converge to ~0/1
 * (e.g. ["0.005","0.995"] = Down won). Returns null while the result is not yet
 * decisive, so the caller should retry.
 *
 * `decisiveThreshold` is the minimum winning-side price required before we trust
 * the result (guards against reading a mid-ish price right at/after close).
 */
export async function fetchResolution(
  yesTokenId: string,
  decisiveThreshold = 0.9,
): Promise<Resolution | null> {
  try {
    const url = `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(yesTokenId)}`;

    let resp: Awaited<ReturnType<typeof axios.get<GammaMarketRaw[] | GammaMarketRaw>>>;
    let attempt = 0;
    while (true) {
      try {
        resp = await axios.get<GammaMarketRaw[] | GammaMarketRaw>(url, { timeout: 15000 });
        break;
      } catch (retryErr: any) {
        attempt++;
        if (attempt <= GAMMA_MAX_RETRIES && isRetryable(retryErr)) {
          logger.debug(
            { attempt, status: retryErr?.response?.status },
            'Gamma fetchResolution 5xx — retrying',
          );
          await sleep(GAMMA_RETRY_DELAY_MS);
          continue;
        }
        throw retryErr;
      }
    }
    const m: any = Array.isArray(resp.data) ? resp.data[0] : resp.data;
    if (!m) return null;

    let prices: any = m.outcomePrices;
    if (typeof prices === 'string') {
      try {
        prices = JSON.parse(prices);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(prices) || prices.length < 2) return null;

    const upPrice = Number(prices[0]);
    const downPrice = Number(prices[1]);
    if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;
    if (Math.max(upPrice, downPrice) < decisiveThreshold) return null; // not settled yet

    return { yesWon: upPrice > downPrice, upPrice };
  } catch (err: any) {
    logger.debug({ error: err.message, yesTokenId }, 'fetchResolution failed');
    return null;
  }
}
