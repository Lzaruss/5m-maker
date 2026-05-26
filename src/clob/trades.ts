import axios from 'axios';
import { logger } from '../util/logger.js';
import { loadEnv } from '../util/config.js';
import type { Trade } from '../live/accounting.js';

const DATA_API = 'https://data-api.polymarket.com';

/** Fetch our executed trades for a token since `sinceMs`. Maps to accounting.Trade. */
export async function fetchOurTrades(tokenId: string, sinceMs: number): Promise<Trade[]> {
  const user = loadEnv().clobFunderAddress;
  try {
    const { data } = await axios.get(`${DATA_API}/trades`, { params: { user, limit: 200 }, timeout: 15000 });
    const arr: any[] = Array.isArray(data) ? data : (data?.trades ?? data?.data ?? []);
    const out: Trade[] = [];
    for (const r of arr) {
      const asset = String(r.asset ?? r.asset_id ?? r.tokenId ?? '');
      if (asset !== tokenId) continue;
      const tsMs = Number(r.timestamp ?? 0) > 1e12 ? Number(r.timestamp) : Number(r.timestamp ?? 0) * 1000;
      if (tsMs <= sinceMs) continue;
      out.push({
        id: String(r.transactionHash ?? r.id ?? `${asset}-${tsMs}-${r.price}-${r.size}`),
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
