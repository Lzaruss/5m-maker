// Afternoon session deep-dive analysis
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const FILE = 'data/live-events-2026-06-01.jsonl';

const events = [];
const rl = createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch {}
}

// ── Split into sessions ─────────────────────────────────────────────────────
const sessions = [];
let cur = null;

for (const e of events) {
  const isNewSession = e.kind === 'start';
  if (isNewSession) {
    if (cur) sessions.push(cur);
    cur = { startTs: e.ts, stopTs: null, stopReason: null,
            windows: [], entries: [], avgs: [], takeProfit: [],
            walletStart: null, walletEnd: null, realityChecks: [] };
  }
  if (!cur) continue;

  if (e.kind === 'reality_check') {
    cur.realityChecks.push(e);
    if (cur.walletStart === null) { cur.walletStart = e.netWorthUsd; cur.cashStart = e.cashUsd; }
    cur.walletEnd = e.netWorthUsd; cur.cashEnd = e.cashUsd;
  }
  if (e.kind === 'window_result') cur.windows.push(e);
  if (e.kind === 'momentum_entry') cur.entries.push(e);
  if (e.kind === 'martingale_avg') cur.avgs.push(e);
  if (e.kind === 'momentum_take_profit') cur.takeProfit.push(e);
  if (e.kind === 'shutdown' || e.kind === 'session_halt' || e.kind === 'net_worth_halt') {
    cur.stopTs = e.ts;
    cur.stopReason = e.kind === 'net_worth_halt' ? 'net_worth_halt'
                   : e.kind === 'shutdown' ? 'shutdown'
                   : (e.reason ?? 'session_halt');
    sessions.push(cur); cur = null;
  }
}
if (cur && (cur.windows.length + cur.entries.length > 0)) sessions.push(cur);

// ── Filter to afternoon sessions only (>= 14:00 UTC today) ─────────────────
// Actually show ALL sessions so we have full context
console.log(`Total sesiones detectadas: ${sessions.length}`);
console.log(`Eventos totales: ${events.length}`);

// ── Per-session report ──────────────────────────────────────────────────────
let grandEntries = 0, grandWins = 0, grandLosses = 0, grandPnl = 0;
let grandAvgs = 0, grandTP = 0;

for (let i = 0; i < sessions.length; i++) {
  const s = sessions[i];
  const startUTC = s.startTs ? new Date(s.startTs).toISOString().slice(11,19) : '??:??:??';
  const wins = s.windows.filter(w => (w.windowPnl ?? w.settlePnl ?? 0) > 0).length;
  const losses = s.windows.filter(w => (w.windowPnl ?? w.settlePnl ?? 0) < 0).length;
  const pnl = s.windows.reduce((a, w) => a + (w.windowPnl ?? w.settlePnl ?? 0), 0);
  const walletDelta = (s.walletEnd != null && s.walletStart != null) ? s.walletEnd - s.walletStart : null;
  const asks = s.entries.map(e => e.ask).filter(Boolean);
  const avgAsk = asks.length ? asks.reduce((a,b) => a+b, 0) / asks.length : null;
  const under57 = asks.filter(a => a <= 0.57).length;
  const over57 = asks.filter(a => a > 0.57).length;
  const longEntries = s.entries.filter(e => e.leg === 'YES').length;
  const shortEntries = s.entries.filter(e => e.leg === 'NO').length;
  
  grandEntries += s.entries.length;
  grandWins += wins; grandLosses += losses; grandPnl += pnl;
  grandAvgs += s.avgs.length; grandTP += s.takeProfit.length;

  const dur = (s.stopTs && s.startTs) ? Math.round((s.stopTs - s.startTs)/60000) : '?';

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`SESIÓN ${i+1}  inicio=${startUTC} UTC  stop=${s.stopReason ?? 'activa'}  dur=${dur}min`);
  console.log(`${'─'.repeat(64)}`);
  console.log(`  Wallet    : $${s.walletStart?.toFixed(2) ?? '?'} → $${s.walletEnd?.toFixed(2) ?? '?'}  ${walletDelta != null ? (walletDelta >= 0 ? '(+' : '(') + walletDelta.toFixed(2) + ')' : ''}`);
  console.log(`  Ventanas  : ${s.windows.length} | ${wins}W / ${losses}L | WR=${s.windows.length ? ((wins/s.windows.length)*100).toFixed(0) : 0}%`);
  console.log(`  Mark PnL  : ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  console.log(`  Entradas  : ${s.entries.length}  YES=${longEntries}  NO=${shortEntries}  avg ask=${avgAsk?.toFixed(3) ?? '-'}`);
  console.log(`              ≤0.57: ${under57}  >0.57: ${over57}`);
  console.log(`  Martingale: ${s.avgs.length} fires`);
  if (s.avgs.length) {
    const byL = {};
    let totalUSDC = 0;
    for (const a of s.avgs) {
      byL[a.levelIdx] = (byL[a.levelIdx] || 0) + 1;
      totalUSDC += a.addUsdc ?? 0;
    }
    console.log(`              ${Object.entries(byL).map(([l,c]) => `L${l}:${c}x`).join(' ')}  USDC=$${totalUSDC}`);
  }
  if (s.takeProfit.length) {
    const avgTP = s.takeProfit.reduce((a,e) => a + (e.exitBid ?? e.bid ?? 0), 0) / s.takeProfit.length;
    const avgGain = s.takeProfit.reduce((a,e) => a + ((e.gainPerShare ?? 0) * (e.shares ?? 0)), 0);
    console.log(`  Take-profit: ${s.takeProfit.length}x  avg exit bid=${avgTP.toFixed(3)}  total gain≈$${avgGain.toFixed(2)}`);
  }

  // Show PnL of windows with entries
  const entryWindows = s.windows.filter(w => (w.windowPnl ?? w.settlePnl ?? 0) !== 0);
  if (entryWindows.length > 0) {
    const avgW = wins > 0 ? s.windows.filter(w=>(w.windowPnl??0)>0).reduce((a,w)=>a+(w.windowPnl??0),0)/wins : 0;
    const avgL = losses > 0 ? s.windows.filter(w=>(w.windowPnl??0)<0).reduce((a,w)=>a+(w.windowPnl??0),0)/losses : 0;
    console.log(`  Avg +/-   : win=+$${avgW.toFixed(2)}  loss=$${avgL.toFixed(2)}`);
    console.log(`  Payoff    : ${wins > 0 && losses > 0 ? (Math.abs(avgW/avgL)).toFixed(2) + ':1' : 'n/a'}`);
  }
}

// ── Grand totals ────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`);
console.log('TOTALES DEL DÍA (todas las sesiones)');
console.log(`${'─'.repeat(64)}`);
const firstRC = events.filter(e => e.kind === 'reality_check')[0];
const lastRC  = [...events].reverse().find(e => e.kind === 'reality_check');
console.log(`  Wallet inicio : $${firstRC?.netWorthUsd?.toFixed(2) ?? '?'}`);
console.log(`  Wallet ahora  : $${lastRC?.netWorthUsd?.toFixed(2) ?? '?'}`);
if (firstRC && lastRC) {
  const delta = lastRC.netWorthUsd - firstRC.netWorthUsd;
  console.log(`  Delta real    : ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`);
}
console.log(`  Entradas      : ${grandEntries}  avgs=${grandAvgs}  TP=${grandTP}`);
console.log(`  W/L           : ${grandWins}/${grandLosses}  WR=${grandWins+grandLosses > 0 ? ((grandWins/(grandWins+grandLosses))*100).toFixed(1) : 0}%`);
console.log(`  Mark PnL tot  : ${grandPnl >= 0 ? '+' : ''}$${grandPnl.toFixed(2)}`);

// ── Loss analysis: what are losses costing? ─────────────────────────────────
const allLossWindows = sessions.flatMap(s => s.windows.filter(w => (w.windowPnl ?? w.settlePnl ?? 0) < 0));
if (allLossWindows.length > 0) {
  console.log(`\n── Análisis pérdidas (${allLossWindows.length} ventanas) ──────────────────────────`);
  const sorted = [...allLossWindows].sort((a,b) => (a.windowPnl??0) - (b.windowPnl??0));
  const avg = sorted.reduce((a,w) => a + (w.windowPnl??0), 0) / sorted.length;
  const under5 = sorted.filter(w => (w.windowPnl??0) < -5).length;
  const under10 = sorted.filter(w => (w.windowPnl??0) < -10).length;
  const under20 = sorted.filter(w => (w.windowPnl??0) < -20).length;
  console.log(`  Peor pérdida  : $${sorted[0].windowPnl?.toFixed(2)}`);
  console.log(`  Pérdida media : $${avg.toFixed(2)}`);
  console.log(`  >$5 loss      : ${under5} ventanas`);
  console.log(`  >$10 loss     : ${under10} ventanas`);
  console.log(`  >$20 loss     : ${under20} ventanas`);
}

// ── Win analysis ─────────────────────────────────────────────────────────────
const allWinWindows = sessions.flatMap(s => s.windows.filter(w => (w.windowPnl ?? w.settlePnl ?? 0) > 0));
if (allWinWindows.length > 0) {
  console.log(`\n── Análisis ganancias (${allWinWindows.length} ventanas) ─────────────────────────`);
  const sorted = [...allWinWindows].sort((a,b) => (b.windowPnl??0) - (a.windowPnl??0));
  const avg = sorted.reduce((a,w) => a + (w.windowPnl??0), 0) / sorted.length;
  console.log(`  Mejor ganancia: +$${sorted[0].windowPnl?.toFixed(2)}`);
  console.log(`  Ganancia media: +$${avg.toFixed(2)}`);
}

// ── Entry ask distribution ───────────────────────────────────────────────────
const allEntries = sessions.flatMap(s => s.entries);
if (allEntries.length > 0) {
  console.log(`\n── Distribución asks de entrada (${allEntries.length} entradas) ──────────────────`);
  const buckets = { '≤0.50':0, '0.50-0.53':0, '0.53-0.57':0, '0.57-0.62':0, '≥0.62':0 };
  for (const e of allEntries) {
    const a = e.ask;
    if (a <= 0.50) buckets['≤0.50']++;
    else if (a <= 0.53) buckets['0.50-0.53']++;
    else if (a <= 0.57) buckets['0.53-0.57']++;
    else if (a <= 0.62) buckets['0.57-0.62']++;
    else buckets['≥0.62']++;
  }
  for (const [k,v] of Object.entries(buckets)) {
    const pct = (v/allEntries.length*100).toFixed(0);
    const bar = '█'.repeat(Math.round(v/allEntries.length*25));
    console.log(`  ${k.padEnd(12)}: ${String(v).padStart(3)} (${pct.padStart(3)}%) ${bar}`);
  }
}

// ── Martingale depth vs outcome ──────────────────────────────────────────────
const martingaleAvgs = sessions.flatMap(s => s.avgs);
if (martingaleAvgs.length > 0) {
  console.log(`\n── Martingale: asks al momento del averaging ──────────────────────`);
  const byLevel = {};
  for (const a of martingaleAvgs) {
    if (!byLevel[a.levelIdx]) byLevel[a.levelIdx] = { asks: [], usdc: 0, count: 0 };
    byLevel[a.levelIdx].asks.push(a.currentAsk);
    byLevel[a.levelIdx].usdc += a.addUsdc ?? 0;
    byLevel[a.levelIdx].count++;
  }
  for (const [lvl, d] of Object.entries(byLevel)) {
    const avgAsk = d.asks.reduce((a,b) => a+b, 0) / d.asks.length;
    const minAsk = Math.min(...d.asks);
    console.log(`  L${lvl}: ${d.count}x  avg_ask=${avgAsk.toFixed(3)}  min_ask=${minAsk.toFixed(3)}  total_usdc=$${d.usdc}`);
  }
}

// ── Take-profit stats ─────────────────────────────────────────────────────────
const allTP = sessions.flatMap(s => s.takeProfit);
if (allTP.length > 0) {
  console.log(`\n── Take-profit events (${allTP.length} total) ─────────────────────────────────`);
  for (const tp of allTP) {
    const ts = new Date(tp.ts).toISOString().slice(11,19);
    const xb = tp.exitBid ?? tp.bid;
    console.log(`  ${ts}  entry=${tp.entryAsk?.toFixed(3) ?? '?'}  exit_bid=${xb?.toFixed(3) ?? '?'}  shares=${tp.shares?.toFixed(2)}  gain≈$${(((xb ?? 0) - (tp.entryAsk ?? xb ?? 0)) * (tp.shares ?? 0)).toFixed(2)}`);
  }
}
