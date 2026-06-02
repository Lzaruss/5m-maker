/**
 * strategy-research.mjs
 *
 * Comprehensive live-data research script. Loads ALL live-events-*.jsonl files,
 * correlates every momentum_entry with its window_leg_result outcome, then slices
 * the data along every meaningful dimension to find where the strategy is leaking
 * edge and where it is strongest.
 *
 * Run:  node scripts/strategy-research.mjs
 *       node scripts/strategy-research.mjs --day 2026-06-01   (single day)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, '..', 'data');
const MATCH_WINDOW_MS = 360_000; // 6 min — window is ≤5 min; allow a bit of slack

// ── CLI arg ──────────────────────────────────────────────────────────────────
const dayFilter = (() => {
  const i = process.argv.indexOf('--day');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// ── Load events ──────────────────────────────────────────────────────────────
const files = fs.readdirSync(DATA_DIR)
  .filter(f => f.startsWith('live-events-') && f.endsWith('.jsonl'))
  .filter(f => !dayFilter || f.includes(dayFilter))
  .sort();

if (files.length === 0) {
  console.error('No data files found. Run from the project root or use --day YYYY-MM-DD.');
  process.exit(1);
}

const events = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
}
events.sort((a, b) => a.ts - b.ts);

const totalEvents = events.length;
const dateRange = `${files[0].replace('live-events-','').replace('.jsonl','')} → ${files[files.length-1].replace('live-events-','').replace('.jsonl','')}`;

// ── Build token→result lookup ─────────────────────────────────────────────
// window_leg_result keyed by tokenId, in time order
const resultsByToken = new Map(); // tokenId → [{ts, legPnl, settle, buyShares, sellShares, ...}]
const tpByToken      = new Map(); // tokenId → [momentum_take_profit event]
const avgByToken     = new Map(); // tokenId → [martingale_avg events]

for (const e of events) {
  if (e.kind === 'window_leg_result' && e.token) {
    if (!resultsByToken.has(e.token)) resultsByToken.set(e.token, []);
    resultsByToken.get(e.token).push(e);
  }
  if (e.kind === 'momentum_take_profit' && e.token) {
    if (!tpByToken.has(e.token)) tpByToken.set(e.token, []);
    tpByToken.get(e.token).push(e);
  }
  if (e.kind === 'martingale_avg' && e.token) {
    if (!avgByToken.has(e.token)) avgByToken.set(e.token, []);
    avgByToken.get(e.token).push(e);
  }
}

// ── Match each entry to its outcome ─────────────────────────────────────────
const entries = events.filter(e => e.kind === 'momentum_entry');

// Track session context per "run" (start→shutdown group)
// We'll use a simple running consecutive-loss counter over the whole dataset
// reset at each 'start' event. Build a ts→sessionId map first.
let sessionId = 0;
const tsToSession = new Map();
const sessionLossCounts = new Map(); // sessionId → cumulative consec losses at each entry ts

{
  let curSession = 0;
  const sessionStarts = events.filter(e => e.kind === 'start').map(e => e.ts);
  for (const e of events) {
    if (e.kind === 'start') curSession++;
    tsToSession.set(e.ts, curSession); // approximate
  }
}

// For each entry: find the FIRST window_leg_result for the same token AFTER the entry
const matched = [];
const unmatched = [];

// Track consecutive losses per session for context tagging
const sessionConsecLoss = {}; // sessionId → count at time of last entry
let curSessionId = 0;
let consecLoss = 0;

for (const entry of entries) {
  // Detect session boundaries
  const nearStart = events.find(e => e.kind === 'start' && e.ts <= entry.ts && entry.ts - e.ts < 3_600_000);
  const sId = nearStart ? nearStart.ts : 0;
  if (sId !== curSessionId) { curSessionId = sId; consecLoss = 0; }

  const candidates = resultsByToken.get(entry.token) ?? [];
  const result = candidates.find(r => r.ts > entry.ts && r.ts - entry.ts <= MATCH_WINDOW_MS);

  if (!result) { unmatched.push(entry); continue; }

  const win     = result.legPnl > 0.005;
  const loss    = result.legPnl < -0.005;
  const tpExit  = (result.sellShares ?? 0) > 0;
  const avgs    = (avgByToken.get(entry.token) ?? []).filter(a => a.ts > entry.ts && a.ts - entry.ts <= MATCH_WINDOW_MS);
  const hadMart = avgs.length > 0;
  const prAbs   = Math.abs(entry.priorReturn ?? 0);
  const hour    = new Date(entry.ts).getUTCHours();

  const rec = {
    ts: entry.ts,
    leg: entry.leg,
    ask: entry.ask ?? 0,
    priorReturn: entry.priorReturn ?? 0,
    priorReturnAbs: prAbs,
    ttrSec: entry.ttrSec ?? 0,
    contrarian: entry.contrarian === true,
    martingaleEnabled: entry.martingale === true,
    hadMartingale: hadMart,
    tpExit,
    legPnl: result.legPnl,
    win,
    loss,
    settle: result.settle,
    usdcIn: result.buyUsd ?? 0,
    hour,
    consecLossBefore: consecLoss,
    sessionId: sId,
  };

  matched.push(rec);

  // Update consecutive loss counter
  if (win)       consecLoss = 0;
  else if (loss) consecLoss++;
}

// ── Utility functions ─────────────────────────────────────────────────────
function stats(arr) {
  if (!arr.length) return { n: 0, wins: 0, losses: 0, wr: 0, avgWin: 0, avgLoss: 0, ev: 0, totalPnl: 0 };
  const wins   = arr.filter(r => r.win);
  const losses = arr.filter(r => r.loss);
  const avgWin  = wins.length  ? wins.reduce((s,r) => s + r.legPnl, 0) / wins.length  : 0;
  const avgLoss = losses.length ? losses.reduce((s,r) => s + r.legPnl, 0) / losses.length : 0;
  const wr      = wins.length / arr.length;
  const ev      = wr * avgWin + (1-wr) * avgLoss;
  const totalPnl = arr.reduce((s,r) => s + r.legPnl, 0);
  return { n: arr.length, wins: wins.length, losses: losses.length, wr, avgWin, avgLoss, ev, totalPnl };
}

function bar(wr, width = 20) {
  const fill = Math.round(wr * width);
  return '█'.repeat(fill) + '░'.repeat(width - fill);
}

function fmt(n, digits = 2) {
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function printTable(title, rows) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`);
  const header = `  ${'Bucket'.padEnd(18)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(8)} ${'EV'.padStart(7)} ${'Bar'}`;
  console.log(header);
  console.log('  ' + '─'.repeat(76));
  for (const [label, subset] of rows) {
    if (!subset.length) continue;
    const s = stats(subset);
    const row = [
      label.padEnd(18),
      String(s.n).padStart(4),
      String(s.wins).padStart(4),
      String(s.losses).padStart(4),
      (s.wr*100).toFixed(1).padStart(6),
      fmt(s.avgWin).padStart(7),
      fmt(s.avgLoss).padStart(8),
      fmt(s.ev,3).padStart(7),
      `  ${bar(s.wr, 16)}`,
    ];
    console.log('  ' + row.join(' '));
  }
}

// ── REPORT ────────────────────────────────────────────────────────────────
const W = '═'.repeat(65);
console.log('\n' + W);
console.log('  STRATEGY RESEARCH REPORT');
console.log(`  Datos: ${dateRange}  |  Archivos: ${files.length}  |  Eventos: ${totalEvents.toLocaleString()}`);
console.log(W);

// ── 1. Global overview ────────────────────────────────────────────────────
const all = stats(matched);
console.log('\n── OVERVIEW ' + '─'.repeat(52));
console.log(`  Entradas totales   : ${entries.length}`);
console.log(`  Matcheadas c/result: ${matched.length}  (sin match: ${unmatched.length})`);
console.log(`  Wins / Losses      : ${all.wins} / ${all.losses}  (${(all.wr*100).toFixed(1)}% WR)`);
console.log(`  Avg win            : ${fmt(all.avgWin)}`);
console.log(`  Avg loss           : ${fmt(all.avgLoss)}`);
console.log(`  EV por entrada     : ${fmt(all.ev, 3)}`);
console.log(`  PnL total          : ${fmt(all.totalPnl)}`);
console.log(`  Take-profit exits  : ${matched.filter(r => r.tpExit).length}`);
console.log(`  Con martingale avg : ${matched.filter(r => r.hadMartingale).length}`);

// ── 2. Por dirección (YES / NO) ───────────────────────────────────────────
printTable('POR DIRECCIÓN', [
  ['YES (long)', matched.filter(r => r.leg === 'YES')],
  ['NO  (short)', matched.filter(r => r.leg === 'NO')],
]);

// ── 3. Contrarian vs Momentum ────────────────────────────────────────────
printTable('CONTRARIAN vs MOMENTUM', [
  ['Momentum (normal)', matched.filter(r => !r.contrarian)],
  ['Contrarian (fade)', matched.filter(r => r.contrarian)],
]);

// ── 4. Por precio de entrada (ask) ───────────────────────────────────────
printTable('POR ASK DE ENTRADA', [
  ['≤0.35',     matched.filter(r => r.ask <= 0.35)],
  ['0.35-0.40', matched.filter(r => r.ask > 0.35 && r.ask <= 0.40)],
  ['0.40-0.45', matched.filter(r => r.ask > 0.40 && r.ask <= 0.45)],
  ['0.45-0.50', matched.filter(r => r.ask > 0.45 && r.ask <= 0.50)],
  ['0.50-0.53', matched.filter(r => r.ask > 0.50 && r.ask <= 0.53)],
  ['0.53-0.57', matched.filter(r => r.ask > 0.53 && r.ask <= 0.57)],
  ['0.57-0.65', matched.filter(r => r.ask > 0.57 && r.ask <= 0.65)],
  ['>0.65',     matched.filter(r => r.ask > 0.65)],
]);

// ── 5. Por magnitud del prior return ─────────────────────────────────────
printTable('POR MAGNITUD PRIOR RETURN (|r|)', [
  ['0.10-0.15%', matched.filter(r => r.priorReturnAbs >= 0.0010 && r.priorReturnAbs < 0.0015)],
  ['0.15-0.20%', matched.filter(r => r.priorReturnAbs >= 0.0015 && r.priorReturnAbs < 0.0020)],
  ['0.20-0.35%', matched.filter(r => r.priorReturnAbs >= 0.0020 && r.priorReturnAbs < 0.0035)],
  ['0.35-0.50%', matched.filter(r => r.priorReturnAbs >= 0.0035 && r.priorReturnAbs < 0.0050)],
  ['0.50-1.00%', matched.filter(r => r.priorReturnAbs >= 0.0050 && r.priorReturnAbs < 0.0100)],
  ['>1.00%',     matched.filter(r => r.priorReturnAbs >= 0.0100)],
]);

// ── 6. Por timing de entrada (ttrSec) ─────────────────────────────────────
printTable('POR TIMING ENTRADA (ttrSec al entrar)', [
  ['270-260s', matched.filter(r => r.ttrSec >= 260 && r.ttrSec <= 270)],
  ['260-240s', matched.filter(r => r.ttrSec >= 240 && r.ttrSec < 260)],
  ['240-220s', matched.filter(r => r.ttrSec >= 220 && r.ttrSec < 240)],
  ['220-200s', matched.filter(r => r.ttrSec >= 200 && r.ttrSec < 220)],
  ['200-180s', matched.filter(r => r.ttrSec >= 180 && r.ttrSec < 200)],
  ['<180s',   matched.filter(r => r.ttrSec < 180)],
]);

// ── 7. Por hora del día (UTC) ────────────────────────────────────────────
const hourBuckets = [];
for (let h = 0; h < 24; h += 3) {
  const label = `${String(h).padStart(2,'0')}:00-${String(h+3).padStart(2,'0')}:00`;
  hourBuckets.push([label, matched.filter(r => r.hour >= h && r.hour < h+3)]);
}
printTable('POR HORA UTC (ventanas de 3h)', hourBuckets);

// ── 8. Martingale: con/sin averaging ─────────────────────────────────────
printTable('MARTINGALE — ¿se promedió la posición?', [
  ['Sin averaging', matched.filter(r => r.martingaleEnabled && !r.hadMartingale)],
  ['Con averaging', matched.filter(r => r.martingaleEnabled && r.hadMartingale)],
  ['Mart desactivado', matched.filter(r => !r.martingaleEnabled)],
]);

// ── 9. Take-profit vs hold to resolution ─────────────────────────────────
printTable('TAKE-PROFIT vs HOLD TO RESOLUTION', [
  ['Hold (resolución)', matched.filter(r => !r.tpExit)],
  ['Take-profit exit',  matched.filter(r => r.tpExit)],
]);

// ── 10. Contexto de pérdidas consecutivas ────────────────────────────────
printTable('CONTEXTO: pérdidas consec. PREVIAS', [
  ['0 previas (primera)', matched.filter(r => r.consecLossBefore === 0)],
  ['1 pérdida previa',    matched.filter(r => r.consecLossBefore === 1)],
  ['2 pérdidas previas',  matched.filter(r => r.consecLossBefore === 2)],
  ['3+ pérdidas previas', matched.filter(r => r.consecLossBefore >= 3)],
]);

// ── 11. Distribución de PnL por entrada ──────────────────────────────────
console.log('\n── DISTRIBUCIÓN PNL POR ENTRADA ' + '─'.repeat(32));
const pnls = matched.map(r => r.legPnl).sort((a,b) => a-b);
const buckets = [
  ['< -20',    pnls.filter(p => p < -20)],
  ['-20 a -10',pnls.filter(p => p >= -20 && p < -10)],
  ['-10 a -5', pnls.filter(p => p >= -10 && p < -5)],
  ['-5 a 0',   pnls.filter(p => p >= -5  && p < 0)],
  ['0',        pnls.filter(p => p === 0)],
  ['0 a +2',   pnls.filter(p => p > 0 && p < 2)],
  ['+2 a +5',  pnls.filter(p => p >= 2 && p < 5)],
  ['+5 a +10', pnls.filter(p => p >= 5 && p < 10)],
  ['+10 a +20',pnls.filter(p => p >= 10 && p < 20)],
  ['> +20',    pnls.filter(p => p >= 20)],
];
const maxCount = Math.max(...buckets.map(([,v]) => v.length));
for (const [label, vals] of buckets) {
  if (!maxCount) continue;
  const barLen = Math.round((vals.length / maxCount) * 30);
  console.log(`  ${label.padStart(10)} : ${String(vals.length).padStart(3)}  ${'█'.repeat(barLen)}`);
}

// ── 12. Señal de prior return — distribución de entradas vs wins ──────────
console.log('\n── ANÁLISIS SEÑAL: PRIOR RETURN MAGNITUD ' + '─'.repeat(23));
console.log('  (¿cuánto prior return necesitamos para que el momentum sea real?)');
const prBuckets = [
  [0.0000, 0.0010, '<0.10%  (bajo el threshold — no debería entrar)'],
  [0.0010, 0.0015, '0.10-0.15%'],
  [0.0015, 0.0020, '0.15-0.20%'],
  [0.0020, 0.0030, '0.20-0.30%'],
  [0.0030, 0.0050, '0.30-0.50%'],
  [0.0050, 0.0100, '0.50-1.00%'],
  [0.0100, 9999,   '>1.00%  (señal fuerte)'],
];
console.log(`  ${'Bucket'.padEnd(28)} ${'N'.padStart(4)} ${'WR%'.padStart(6)} ${'EV'.padStart(7)}`);
for (const [lo, hi, label] of prBuckets) {
  const sub = matched.filter(r => r.priorReturnAbs >= lo && r.priorReturnAbs < hi);
  if (!sub.length) continue;
  const s = stats(sub);
  console.log(`  ${label.padEnd(28)} ${String(s.n).padStart(4)} ${(s.wr*100).toFixed(1).padStart(6)}% ${fmt(s.ev,3).padStart(7)}`);
}

// ── 13. YES vs NO separado por prior return ──────────────────────────────
console.log('\n── YES vs NO x MAGNITUD PRIOR RETURN ' + '─'.repeat(26));
for (const [lo, hi, label] of prBuckets) {
  const sub = matched.filter(r => r.priorReturnAbs >= lo && r.priorReturnAbs < hi);
  if (!sub.length) continue;
  const yes = stats(sub.filter(r => r.leg === 'YES'));
  const no  = stats(sub.filter(r => r.leg === 'NO'));
  const pad = label.padEnd(20);
  const yStr = yes.n ? `YES: ${yes.n} entries, ${(yes.wr*100).toFixed(0)}% WR, EV=${fmt(yes.ev,3)}` : 'YES: n/a';
  const nStr = no.n  ? `NO:  ${no.n} entries, ${(no.wr*100).toFixed(0)}% WR, EV=${fmt(no.ev,3)}`  : 'NO: n/a';
  console.log(`  ${pad} | ${yStr.padEnd(38)} | ${nStr}`);
}

// ── 14. Entradas perdedoras — qué tenían en común ────────────────────────
const losers = matched.filter(r => r.loss);
const winners = matched.filter(r => r.win);
console.log('\n── PERFIL ENTRADAS PERDEDORAS (' + losers.length + ') ' + '─'.repeat(25));
console.log(`  Ask promedio    : WINS=${(winners.reduce((s,r)=>s+r.ask,0)/Math.max(winners.length,1)).toFixed(3)}  LOSSES=${(losers.reduce((s,r)=>s+r.ask,0)/Math.max(losers.length,1)).toFixed(3)}`);
console.log(`  |priorReturn|   : WINS=${(winners.reduce((s,r)=>s+r.priorReturnAbs,0)/Math.max(winners.length,1)*100).toFixed(3)}%  LOSSES=${(losers.reduce((s,r)=>s+r.priorReturnAbs,0)/Math.max(losers.length,1)*100).toFixed(3)}%`);
console.log(`  ttrSec          : WINS=${(winners.reduce((s,r)=>s+r.ttrSec,0)/Math.max(winners.length,1)).toFixed(0)}s  LOSSES=${(losers.reduce((s,r)=>s+r.ttrSec,0)/Math.max(losers.length,1)).toFixed(0)}s`);
console.log(`  % YES           : WINS=${(winners.filter(r=>r.leg==='YES').length/Math.max(winners.length,1)*100).toFixed(0)}%  LOSSES=${(losers.filter(r=>r.leg==='YES').length/Math.max(losers.length,1)*100).toFixed(0)}%`);
console.log(`  % contrarian    : WINS=${(winners.filter(r=>r.contrarian).length/Math.max(winners.length,1)*100).toFixed(0)}%  LOSSES=${(losers.filter(r=>r.contrarian).length/Math.max(losers.length,1)*100).toFixed(0)}%`);
console.log(`  % con averaging : WINS=${(winners.filter(r=>r.hadMartingale).length/Math.max(winners.length,1)*100).toFixed(0)}%  LOSSES=${(losers.filter(r=>r.hadMartingale).length/Math.max(losers.length,1)*100).toFixed(0)}%`);
console.log(`  Hora promedio   : WINS=${(winners.reduce((s,r)=>s+r.hour,0)/Math.max(winners.length,1)).toFixed(1)}h UTC  LOSSES=${(losers.reduce((s,r)=>s+r.hour,0)/Math.max(losers.length,1)).toFixed(1)}h UTC`);

// ── 15. Resumen ejecutivo ────────────────────────────────────────────────
console.log('\n' + W);
console.log('  RESUMEN EJECUTIVO');
console.log(W);

// Find best/worst ask buckets
const askRows = [
  ['≤0.35',     matched.filter(r => r.ask <= 0.35)],
  ['0.35-0.40', matched.filter(r => r.ask > 0.35 && r.ask <= 0.40)],
  ['0.40-0.45', matched.filter(r => r.ask > 0.40 && r.ask <= 0.45)],
  ['0.45-0.50', matched.filter(r => r.ask > 0.45 && r.ask <= 0.50)],
  ['0.50-0.53', matched.filter(r => r.ask > 0.50 && r.ask <= 0.53)],
  ['0.53-0.57', matched.filter(r => r.ask > 0.53 && r.ask <= 0.57)],
  ['0.57-0.65', matched.filter(r => r.ask > 0.57 && r.ask <= 0.65)],
  ['>0.65',     matched.filter(r => r.ask > 0.65)],
].filter(([,s]) => s.length >= 3).map(([l,s]) => [l, stats(s)]);

const bestAsk  = askRows.sort((a,b) => b[1].ev - a[1].ev)[0];
const worstAsk = [...askRows].sort((a,b) => a[1].ev - b[1].ev)[0];

const hourSt = hourBuckets.filter(([,s]) => s.length >= 3).map(([l,s]) => [l, stats(s)]);
const bestHr  = hourSt.sort((a,b) => b[1].ev - a[1].ev)[0];
const worstHr = [...hourSt].sort((a,b) => a[1].ev - b[1].ev)[0];

const yesS = stats(matched.filter(r => r.leg === 'YES'));
const noS  = stats(matched.filter(r => r.leg === 'NO'));
const momS = stats(matched.filter(r => !r.contrarian));
const conS = stats(matched.filter(r => r.contrarian));
const tpS  = stats(matched.filter(r => r.tpExit));
const holdS= stats(matched.filter(r => !r.tpExit));
const martS= stats(matched.filter(r => r.hadMartingale));
const noMartS = stats(matched.filter(r => r.martingaleEnabled && !r.hadMartingale));

console.log(`
  Dirección:
    YES: WR=${(yesS.wr*100).toFixed(1)}%  EV=${fmt(yesS.ev,3)}  (${yesS.n} entradas)
    NO:  WR=${(noS.wr*100).toFixed(1)}%  EV=${fmt(noS.ev,3)}  (${noS.n} entradas)
    → ${yesS.ev > noS.ev ? 'YES supera a NO' : 'NO supera a YES'} en EV

  Modo:
    Momentum: WR=${(momS.wr*100).toFixed(1)}%  EV=${fmt(momS.ev,3)}  (${momS.n} entradas)
    Contrarian: WR=${(conS.wr*100).toFixed(1)}%  EV=${fmt(conS.ev,3)}  (${conS.n} entradas)
    → ${momS.ev > conS.ev ? 'Momentum supera a contrarian' : 'Contrarian supera a momentum'}

  Mejor rango de ask: ${bestAsk?.[0] ?? 'n/a'}  (WR=${bestAsk?.[1] ? (bestAsk[1].wr*100).toFixed(1) : 0}%  EV=${bestAsk?.[1] ? fmt(bestAsk[1].ev,3) : 'n/a'})
  Peor rango de ask:  ${worstAsk?.[0] ?? 'n/a'}  (WR=${worstAsk?.[1] ? (worstAsk[1].wr*100).toFixed(1) : 0}%  EV=${worstAsk?.[1] ? fmt(worstAsk[1].ev,3) : 'n/a'})

  Mejor bloque horario: ${bestHr?.[0] ?? 'n/a'}  (EV=${bestHr?.[1] ? fmt(bestHr[1].ev,3) : 'n/a'})
  Peor bloque horario:  ${worstHr?.[0] ?? 'n/a'}  (EV=${worstHr?.[1] ? fmt(worstHr[1].ev,3) : 'n/a'})

  Take-profit (${tpS.n} exits):  WR=${(tpS.wr*100).toFixed(1)}%  EV=${fmt(tpS.ev,3)}
  Hold to resolution (${holdS.n}):  WR=${(holdS.wr*100).toFixed(1)}%  EV=${fmt(holdS.ev,3)}

  Martingale con averaging (${martS.n}):  WR=${(martS.wr*100).toFixed(1)}%  EV=${fmt(martS.ev,3)}
  Martingale sin averaging (${noMartS.n}): WR=${(noMartS.wr*100).toFixed(1)}%  EV=${fmt(noMartS.ev,3)}
`);

console.log(W + '\n');
