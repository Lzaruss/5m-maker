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
   *  rewards. Null when the field is absent. */
  rewardsMaxSpread: number | null;
  rewardsMinSize: number | null;
  /** Gamma's reported book spread at discovery time (reference snapshot). */
  gammaSpread: number | null;
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

/**
 * Fetch imminent Up/Down markets for the given assets and window size.
 * Sorted soonest-resolving first.
 */
export async function fetchMarkets(assets: Asset[], windowMin: number): Promise<ShortMarket[]> {
  try {
    const nowIso = new Date().toISOString();
    const url = `${GAMMA}/markets?active=true&closed=false&limit=500&order=endDate&ascending=true&end_date_min=${encodeURIComponent(nowIso)}`;
    const response = await axios.get<GammaMarketRaw[]>(url, { timeout: 15000 });
    const raw = Array.isArray(response.data) ? response.data : [];
    const wanted = new Set(assets);

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
      });
    }

    out.sort((a, b) => a.resolvesAt.getTime() - b.resolvesAt.getTime());
    logger.debug({ count: out.length, assets, windowMin }, 'Fetched markets');
    return out;
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to fetch Gamma markets');
    return [];
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
    const resp = await axios.get<GammaMarketRaw[] | GammaMarketRaw>(url, { timeout: 15000 });
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
