/**
 * One-off: inspect the funder wallet's activity feed for MAKER_REBATE income, to
 * understand the mechanism + magnitude (user reports collecting maker rebates
 * 2026-06; the market `rewards.rates` field is null, so it must be paid as an
 * activity-level rebate). Read-only — no orders. Prints distinct activity types,
 * and details + total for any rebate/reward entries.
 *
 *   npx tsx scripts/check-rebate.ts
 */
import axios from 'axios';
import { loadEnv } from '../src/util/config.js';

const DATA_API = 'https://data-api.polymarket.com';

async function main(): Promise<void> {
  const env = loadEnv();
  const user = env.clobFunderAddress;
  if (!user) { console.error('no CLOB_FUNDER_ADDRESS in env'); process.exit(1); }
  console.log(`wallet: ${user}\n`);

  const resp = await axios.get<any>(`${DATA_API}/activity?user=${user}&limit=500`, { timeout: 20000 });
  const arr: any[] = Array.isArray(resp.data) ? resp.data : [];
  console.log(`fetched ${arr.length} activity entries\n`);

  // distinct types
  const types = new Map<string, number>();
  for (const a of arr) { const t = String(a.type ?? '?'); types.set(t, (types.get(t) ?? 0) + 1); }
  console.log('=== activity types ===');
  for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${n}`);

  // rebate / reward entries
  const isRebate = (t: string) => /REBATE|REWARD/i.test(t);
  const rebates = arr.filter((a) => isRebate(String(a.type ?? '')));
  console.log(`\n=== rebate/reward entries: ${rebates.length} ===`);
  let total = 0;
  for (const a of rebates.slice(0, 25)) {
    const usd = Number(a.usdcSize ?? a.size ?? a.amount ?? 0);
    total += usd;
    const ts = a.timestamp ? new Date(Number(a.timestamp) * 1000).toISOString().slice(0, 19) : '?';
    console.log(`  ${ts}  type=${a.type}  usd=${usd.toFixed(4)}  cond=${String(a.conditionId ?? '').slice(0, 12)}`);
  }
  if (rebates.length) {
    let allTotal = 0; for (const a of rebates) allTotal += Number(a.usdcSize ?? a.size ?? a.amount ?? 0);
    console.log(`\n  TOTAL rebate over ${rebates.length} entries: $${allTotal.toFixed(4)}`);
    console.log('\n  raw sample:', JSON.stringify(rebates[0], null, 2));
  } else {
    // show a raw non-trade sample so we can see field names
    const nonTrade = arr.find((a) => String(a.type ?? '').toUpperCase() !== 'TRADE');
    console.log('  (none matched REBATE/REWARD). Raw non-TRADE sample:', JSON.stringify(nonTrade ?? arr[0], null, 2));
  }
}
main().catch((e) => { console.error('check-rebate fatal:', e?.message ?? e); process.exit(1); });
