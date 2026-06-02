// Dissect a Polymarket account's real mechanic from the data-api activity feed.
// Answers: fast-flip (BUY then SELL seconds later) or hold-to-resolution (BUY then
// REDEEM)? hold times, win rate, sizes, which markets. Delete after use.
const https = require('node:https');
const ADDR = process.argv[2] || '0x5583a19d5b76276562a9880e7eaa6f3cf5243def';

function get(url) {
  return new Promise((res) => {
    https.get(url, { timeout: 20000 }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } }); }).on('error', () => res(null)).on('timeout', function () { this.destroy(); res(null); });
  });
}

(async () => {
  // paginate
  let all = [];
  for (let off = 0; off < 2000; off += 500) {
    const r = await get(`https://data-api.polymarket.com/activity?user=${ADDR}&limit=500&offset=${off}`);
    if (!Array.isArray(r) || r.length === 0) break;
    all = all.concat(r);
    if (r.length < 500) break;
  }
  console.log(`fetched ${all.length} activity entries for ${ADDR}\n`);

  const types = {};
  for (const a of all) types[a.type] = (types[a.type] || 0) + 1;
  console.log('=== types ===', JSON.stringify(types));

  // time range
  const ts = all.map((a) => Number(a.timestamp)).filter(Boolean).sort((x, y) => x - y);
  if (ts.length) console.log('span:', new Date(ts[0] * 1000).toISOString(), '->', new Date(ts[ts.length - 1] * 1000).toISOString());

  // markets traded (titles) — are they 5m crypto?
  const titles = {};
  for (const a of all) if (a.type === 'TRADE' && a.title) { const key = a.title.replace(/\d+:\d+[AP]M-\d+:\d+[AP]M ET|\w+ \d+,?/g, '').trim().slice(0, 40); titles[key] = (titles[key] || 0) + 1; }
  console.log('\n=== market families (TRADE) ===');
  for (const [t, n] of Object.entries(titles).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n}x  ${t}`);

  // BUY vs SELL trades, sizes
  const trades = all.filter((a) => a.type === 'TRADE');
  const buys = trades.filter((t) => String(t.side).toUpperCase() === 'BUY');
  const sells = trades.filter((t) => String(t.side).toUpperCase() === 'SELL');
  const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  console.log(`\n=== trades ===`);
  console.log(`  BUY: ${buys.length}  notional $${sum(buys, (x) => x.usdcSize).toFixed(0)}  avgSize $${(sum(buys, (x) => x.usdcSize) / Math.max(1, buys.length)).toFixed(1)}  maxSize $${Math.max(0, ...buys.map((x) => Number(x.usdcSize) || 0)).toFixed(0)}`);
  console.log(`  SELL: ${sells.length}  notional $${sum(sells, (x) => x.usdcSize).toFixed(0)}  avgSize $${(sum(sells, (x) => x.usdcSize) / Math.max(1, sells.length)).toFixed(1)}`);
  const redeems = all.filter((a) => a.type === 'REDEEM');
  console.log(`  REDEEM: ${redeems.length}  total $${sum(redeems, (x) => x.usdcSize).toFixed(0)}  maxSize $${Math.max(0, ...redeems.map((x) => Number(x.usdcSize) || 0)).toFixed(0)}`);

  // SELL vs REDEEM ratio = flip vs hold. If SELLs >> REDEEMs, it's flipping.
  console.log(`\n  EXIT STYLE: ${sells.length} SELLs vs ${redeems.length} REDEEMs  => ${sells.length > redeems.length * 1.5 ? 'FAST-FLIP (sells out, rarely holds to redeem)' : redeems.length > sells.length * 1.5 ? 'HOLD-TO-RESOLUTION (redeems)' : 'MIXED'}`);

  // hold-time: per (conditionId, outcomeIndex), match BUY->next SELL chronologically
  const byPos = {};
  for (const t of trades) { const k = `${t.conditionId}|${t.outcomeIndex}`; (byPos[k] = byPos[k] || []).push(t); }
  const holds = [];
  for (const k in byPos) {
    const arr = byPos[k].sort((a, b) => a.timestamp - b.timestamp);
    let openTs = null;
    for (const t of arr) {
      if (String(t.side).toUpperCase() === 'BUY' && openTs == null) openTs = t.timestamp;
      else if (String(t.side).toUpperCase() === 'SELL' && openTs != null) { holds.push(t.timestamp - openTs); openTs = null; }
    }
  }
  if (holds.length) {
    holds.sort((a, b) => a - b);
    const med = holds[Math.floor(holds.length / 2)];
    console.log(`\n  HOLD TIME (BUY->SELL round trips): n=${holds.length}  median ${med}s  min ${holds[0]}s  max ${holds[holds.length - 1]}s`);
    const under60 = holds.filter((h) => h <= 60).length, under300 = holds.filter((h) => h <= 300).length;
    console.log(`    <=60s: ${(100 * under60 / holds.length).toFixed(0)}%   <=300s (one 5m window): ${(100 * under300 / holds.length).toFixed(0)}%`);
  }

  // sample biggest trades
  console.log('\n=== biggest BUYs ===');
  for (const b of buys.sort((a, b) => Number(b.usdcSize) - Number(a.usdcSize)).slice(0, 6)) console.log(`  $${Number(b.usdcSize).toFixed(0).padStart(5)}  @${Number(b.price).toFixed(2)}  ${b.outcome}  ${String(b.title).slice(0, 45)}`);
})();
