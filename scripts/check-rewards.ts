/**
 * One-off: query the LIVE rewards config of current 5m crypto markets, to confirm
 * whether liquidity rewards/rebates are active NOW (the tape from 2026-05-28/29
 * showed them inactive, but the user reports collecting rebates 2026-06). Prints
 * the full CLOB `rewards` object (rates with amounts, min_size, max_spread) so we
 * know the mechanism + magnitude. Read-only, no orders.
 *
 *   npx tsx scripts/check-rewards.ts
 */
import axios from 'axios';
import { fetchMarkets } from '../src/markets/gammaPoller.js';
import type { Asset } from '../src/util/assets.js';

const CLOB = 'https://clob.polymarket.com';

async function main(): Promise<void> {
  const assets: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'];
  const markets = await fetchMarkets(assets, 5);
  console.log(`fetched ${markets.length} live 5m markets`);
  const seen = new Set<string>();
  for (const m of markets) {
    if (seen.has(m.asset)) continue;
    seen.add(m.asset);
    try {
      const resp = await axios.get<any>(`${CLOB}/markets/${m.conditionId}`, { timeout: 15000 });
      const d = resp.data ?? {};
      console.log(`\n=== ${m.asset}  (${m.question}) ===`);
      console.log(`  fee_rate_bps: ${d.fee_rate_bps ?? d.feeRateBps ?? '?'}   maker_base_fee: ${d.maker_base_fee ?? '?'}   taker_base_fee: ${d.taker_base_fee ?? '?'}`);
      console.log(`  rewards: ${JSON.stringify(d.rewards, null, 2)}`);
    } catch (err: any) {
      console.log(`\n=== ${m.asset} === fetch failed: ${err.message}`);
    }
  }
}
main().catch((e) => { console.error('check-rewards fatal:', e?.message ?? e); process.exit(1); });
