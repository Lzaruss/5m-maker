/**
 * multi-window-research.mjs
 *
 * Hipótesis: el momentum es más fiable cuando HAY RACHA — cuando las últimas
 * N ventanas consecutivas del mismo asset resolvieron en la misma dirección.
 * Una sola ventana alcista (señal T-1) puede ser ruido; dos o tres consecutivas
 * son tendencia real.
 *
 * Metodología:
 *  1. Construir secuencia cronológica de window_result por asset
 *  2. Para cada momentum_entry, mirar hacia atrás:
 *     - T-1: ¿la ventana inmediatamente anterior resolvió en la dirección de la entrada?
 *     - T-2: ¿y la de antes?
 *     - T-3: ¿y la de antes también?
 *  3. Agrupar entradas por "profundidad de racha":
 *     - RACHA 3+: T-1, T-2 y T-3 todas en la misma dirección → tendencia fuerte
 *     - RACHA 2:  T-1 y T-2 alineadas, T-3 no o sin datos
 *     - RACHA 1:  solo T-1 alineada (la mayoría de las entradas actuales)
 *     - CONTRA:   T-1 iba en dirección OPUESTA a la entrada (el priorReturn dice una cosa,
 *                 pero el resultado real del mercado dijo otra — posible señal falsa)
 *  4. Calcular WR y EV por grupo
 *  5. Análisis secundario: ¿importa si T-1 fue una victoria o derrota?
 *
 * Nota: priorReturn en momentum_entry es el retorno de precio (continuo).
 *       yesWon en window_result es la resolución discreta del mercado.
 *       Pueden diferir ligeramente. Se usa yesWon como señal más "oficial".
 *
 * Uso: node scripts/multi-window-research.mjs
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_DIR = 'data';
const MATCH_WINDOW_MS = 6 * 60 * 1000;
const MAX_LOOKBACK_STALE_MS = 12 * 60 * 1000; // ignore T-1 if older than 12 min

// ── Load all events ──────────────────────────────────────────────────────────
const files = readdirSync(DATA_DIR)
  .filter(f => f.startsWith('live-events-') && f.endsWith('.jsonl'))
  .sort();

const allEvents = [];
for (const f of files) {
  const lines = readFileSync(join(DATA_DIR, f), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try { allEvents.push(JSON.parse(line)); } catch {}
  }
}
allEvents.sort((a, b) => a.ts - b.ts);
console.log(`Loaded ${allEvents.length.toLocaleString()} events\n`);

// ── 1. Build token → asset map ───────────────────────────────────────────────
const tokenToAsset = new Map();
const tokenToResolvesAt = new Map();

for (const e of allEvents) {
  if (e.kind !== 'window_open') continue;
  const q = e.question || '';
  let asset = 'OTHER';
  if (q.startsWith('Bitcoin'))  asset = 'BTC';
  else if (q.startsWith('Ethereum')) asset = 'ETH';
  else if (q.startsWith('Solana'))   asset = 'SOL';
  else if (q.startsWith('XRP'))      asset = 'XRP';
  else if (q.startsWith('BNB'))      asset = 'BNB';
  else if (q.startsWith('Dogecoin')) asset = 'DOGE';

  const ra = e.resolvesAt ? new Date(e.resolvesAt).getTime() : null;
  if (e.yesToken) { tokenToAsset.set(e.yesToken, asset); if (ra) tokenToResolvesAt.set(e.yesToken, ra); }
  if (e.noToken)  { tokenToAsset.set(e.noToken,  asset); if (ra) tokenToResolvesAt.set(e.noToken, ra); }
}

// ── 2. Build per-asset ordered window_result sequence ───────────────────────
// assetHistory[asset] = [{resolvesAt, yesWon, question}] sorted asc
const assetHistory = new Map();

for (const e of allEvents) {
  if (e.kind !== 'window_result') continue;
  const q = e.question || '';
  let asset = 'OTHER';
  if (q.startsWith('Bitcoin'))  asset = 'BTC';
  else if (q.startsWith('Ethereum')) asset = 'ETH';
  else if (q.startsWith('Solana'))   asset = 'SOL';
  else if (q.startsWith('XRP'))      asset = 'XRP';
  else if (q.startsWith('BNB'))      asset = 'BNB';
  else if (q.startsWith('Dogecoin')) asset = 'DOGE';
  if (asset === 'OTHER') continue;

  const ra = tokenToResolvesAt.get(e.yesToken) || tokenToResolvesAt.get(e.noToken);
  if (!ra) continue;

  if (!assetHistory.has(asset)) assetHistory.set(asset, []);
  assetHistory.get(asset).push({ resolvesAt: ra, yesWon: e.yesWon === true, question: q });
}
for (const [, arr] of assetHistory) {
  arr.sort((a, b) => a.resolvesAt - b.resolvesAt);
  // deduplicate by resolvesAt
  const seen = new Set();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (seen.has(arr[i].resolvesAt)) arr.splice(i, 1);
    else seen.add(arr[i].resolvesAt);
  }
}

// Log asset coverage
for (const [asset, hist] of assetHistory) {
  console.log(`  ${asset}: ${hist.length} window results`);
}
console.log();

/**
 * Get the N windows before `beforeTs` for a given asset.
 * Returns array [T-1, T-2, T-3, ...] (most recent first), only those
 * that are not stale (within MAX_LOOKBACK_STALE_MS of the previous one).
 */
function getPriorWindows(asset, beforeTs, n = 3) {
  const hist = assetHistory.get(asset);
  if (!hist) return [];
  // Find the last window that resolved before beforeTs
  let idx = -1;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].resolvesAt < beforeTs) idx = i;
    else break;
  }
  if (idx < 0) return [];

  const result = [];
  let prevTs = beforeTs;
  for (let i = idx; i >= 0 && result.length < n; i--) {
    const w = hist[i];
    // Check staleness: gap between this window and the next event
    if (prevTs - w.resolvesAt > MAX_LOOKBACK_STALE_MS) break;
    result.push(w);
    prevTs = w.resolvesAt;
  }
  return result; // [T-1, T-2, T-3, ...]
}

// ── 3. Build entry → result map ──────────────────────────────────────────────
const entries = allEvents.filter(e => e.kind === 'momentum_entry' && !e.dryRun);
const results = allEvents.filter(e => e.kind === 'window_leg_result');

const resultsByToken = new Map();
for (const r of results) {
  if (!resultsByToken.has(r.token)) resultsByToken.set(r.token, []);
  resultsByToken.get(r.token).push(r);
}

function findResult(entry) {
  const candidates = resultsByToken.get(entry.token) || [];
  const matched = candidates.filter(r => r.ts > entry.ts && r.ts <= entry.ts + MATCH_WINDOW_MS);
  if (!matched.length) return null;
  matched.sort((a, b) => a.ts - b.ts);
  return matched[0];
}

// ── 4. Analyze each entry ────────────────────────────────────────────────────
function makeBucket() { return { n: 0, w: 0, l: 0, sumWin: 0, sumLoss: 0 }; }

// Main grouping: streak depth
const streakBuckets = {
  'streak_3+': makeBucket(),
  'streak_2':  makeBucket(),
  'streak_1':  makeBucket(),
  'contra_t1': makeBucket(), // T-1 resolved OPPOSITE to our entry direction
  'no_history': makeBucket(),
};

// Secondary: T-1 aligned by depth of agreement
const byDepth = {}; // depth (1..4+) → bucket

// Detailed rows for tabular output
const rows = [];
let noMatch = 0;
let noAsset = 0;

for (const entry of entries) {
  const asset = tokenToAsset.get(entry.token);
  if (!asset || asset === 'OTHER') { noAsset++; continue; }

  const result = findResult(entry);
  if (!result) { noMatch++; continue; }

  const win = result.settle === 1 || result.cashUsd > 0;
  const pnl = result.legPnl || result.cashUsd || 0;

  // Entry predicts: YES (bet on YES) or NO (bet on NO)
  const entryPrediction = entry.leg === 'YES' ? true : false; // true = expects YES to win

  // Get prior windows
  const priorWindows = getPriorWindows(asset, entry.ts, 3);

  let streakKey;
  let streakDepth = 0;
  let t1Aligned = null;

  if (priorWindows.length === 0) {
    streakKey = 'no_history';
  } else {
    const t1 = priorWindows[0];
    t1Aligned = t1.yesWon === entryPrediction;

    if (!t1Aligned) {
      streakKey = 'contra_t1';
    } else {
      // Count how many consecutive prior windows agree
      streakDepth = 0;
      for (const w of priorWindows) {
        if (w.yesWon === entryPrediction) streakDepth++;
        else break;
      }
      if (streakDepth >= 3) streakKey = 'streak_3+';
      else if (streakDepth === 2) streakKey = 'streak_2';
      else streakKey = 'streak_1';
    }
  }

  const bucket = streakBuckets[streakKey];
  bucket.n++;
  if (win) { bucket.w++; bucket.sumWin += Math.abs(pnl); }
  else      { bucket.l++; bucket.sumLoss += Math.abs(pnl); }

  // Depth bucket (0 = contra, 1-3 = streak depth)
  const depthKey = streakKey === 'contra_t1' ? 'CONTRA' :
                   streakKey === 'no_history' ? 'NO_HIST' :
                   `STREAK_${streakDepth}`;
  if (!byDepth[depthKey]) byDepth[depthKey] = makeBucket();
  const db = byDepth[depthKey];
  db.n++;
  if (win) { db.w++; db.sumWin += Math.abs(pnl); }
  else      { db.l++; db.sumLoss += Math.abs(pnl); }

  rows.push({
    ts: entry.ts, asset, leg: entry.leg, ask: entry.ask,
    priorReturn: entry.priorReturn, ttrSec: entry.ttrSec,
    streakKey, streakDepth, t1Aligned,
    win, pnl,
    priorWindowsStr: priorWindows.map(w => w.yesWon ? 'Y' : 'N').join(''),
  });
}

// ── 5. Print ──────────────────────────────────────────────────────────────────
function ev(b) {
  const wr = b.n ? b.w / b.n : 0;
  const avgW = b.w ? b.sumWin / b.w : 0;
  const avgL = b.l ? b.sumLoss / b.l : 0;
  return { wr, avgW, avgL, evVal: wr * avgW - (1 - wr) * avgL };
}

function bar(evVal, scale = 16) {
  const maxE = 15;
  const filled = Math.round((Math.max(0, evVal) / maxE) * scale);
  return '█'.repeat(Math.min(filled, scale)) + '░'.repeat(Math.max(0, scale - filled));
}

function fmtRow(b, label) {
  const { wr, avgW, avgL, evVal } = ev(b);
  const evStr = (evVal >= 0 ? '+' : '') + evVal.toFixed(3);
  return `  ${label.padEnd(22)} ${String(b.n).padStart(4)} ${String(b.w).padStart(4)} ${String(b.l).padStart(4)}  ${(wr*100).toFixed(1).padStart(5)}% ${('+'+avgW.toFixed(2)).padStart(7)} ${('-'+avgL.toFixed(2)).padStart(7)}  ${evStr.padStart(8)}   ${bar(evVal)}`;
}

const W = 80;
console.log('═'.repeat(W));
console.log('  MULTI-WINDOW STREAK RESEARCH');
console.log(`  Entries: ${rows.length}  |  Sin match: ${noMatch}  |  Sin asset: ${noAsset}`);
console.log('═'.repeat(W));

console.log('\n── PROFUNDIDAD DE RACHA ANTES DE LA ENTRADA ─────────────────────────');
console.log(`  ${'Contexto'.padEnd(22)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)}  ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(7)}  ${'EV'.padStart(8)}   Bar`);
console.log('  ' + '─'.repeat(78));

const streakOrder = ['streak_3+', 'streak_2', 'streak_1', 'contra_t1', 'no_history'];
const streakLabels = {
  'streak_3+': 'RACHA 3+ (T1+T2+T3 alin.)',
  'streak_2':  'RACHA 2  (T1+T2 alin.)',
  'streak_1':  'RACHA 1  (solo T1 alin.)',
  'contra_t1': 'CONTRA   (T1 opuesto)',
  'no_history':'SIN HIST (sin prev data)',
};
for (const key of streakOrder) {
  const b = streakBuckets[key];
  if (b.n > 0) console.log(fmtRow(b, streakLabels[key]));
}

// ── Racha 1 breakdown: was it a WIN or LOSS in T-1? ──────────────────────────
const t1WinBucket = makeBucket();
const t1LossBucket = makeBucket();

for (const row of rows) {
  if (row.streakKey !== 'streak_1') continue;
  // T-1 was aligned (same direction). Was T-1 a win (meaning it resolved in the expected direction)?
  // Since t1Aligned = true means T-1 yesWon matches our prediction, and streak_1 means T-1 aligned,
  // the T-1 "win" here means the PRIOR window resolved correctly for that direction.
  // We can infer: if row.t1Aligned and streak_depth=1, T-1 was correct but T-2 wasn't
  // For this secondary breakdown, let's look at T-2 alignment
  const priorStr = row.priorWindowsStr;
  // T-1 aligned. T-2 = priorStr[1] (if exists)
  const t2Aligned = priorStr.length >= 2 && (
    (row.leg === 'YES' && priorStr[1] === 'Y') ||
    (row.leg === 'NO' && priorStr[1] === 'N')
  );
  const target = t2Aligned ? t1WinBucket : t1LossBucket;
  target.n++;
  if (row.win) { target.w++; target.sumWin += Math.abs(row.pnl); }
  else          { target.l++; target.sumLoss += Math.abs(row.pnl); }
}

// ── Streak direction analysis ─────────────────────────────────────────────────
// For streak_1 entries: where did T-2 go?
console.log('\n── DENTRO DE "RACHA 1": contexto T-2 ────────────────────────────────');
console.log('  (¿La ventana hace 2 períodos también iba a favor?)');
console.log(`  ${'Sub-contexto'.padEnd(22)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)}  ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(7)}  ${'EV'.padStart(8)}   Bar`);
console.log('  ' + '─'.repeat(78));
if (t1WinBucket.n > 0)  console.log(fmtRow(t1WinBucket, 'T2 también alineada'));
if (t1LossBucket.n > 0) console.log(fmtRow(t1LossBucket, 'T2 opuesta o sin datos'));

// ── Per-asset breakdown ───────────────────────────────────────────────────────
const assetStreaks = {};
for (const row of rows) {
  const key = `${row.asset}_${row.streakKey}`;
  if (!assetStreaks[key]) assetStreaks[key] = makeBucket();
  const b = assetStreaks[key];
  b.n++;
  if (row.win) { b.w++; b.sumWin += Math.abs(row.pnl); }
  else          { b.l++; b.sumLoss += Math.abs(row.pnl); }
}

console.log('\n── DESGLOSE POR ASSET ───────────────────────────────────────────────');
console.log(`  ${'Asset+Streak'.padEnd(22)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)}  ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(7)}  ${'EV'.padStart(8)}   Bar`);
console.log('  ' + '─'.repeat(78));
const assets = [...new Set(rows.map(r => r.asset))].sort();
for (const asset of assets) {
  for (const sKey of streakOrder) {
    const key = `${asset}_${sKey}`;
    const b = assetStreaks[key];
    if (b && b.n > 0) console.log(fmtRow(b, `${asset} ${sKey}`));
  }
}

// ── Detailed entry table ──────────────────────────────────────────────────────
console.log('\n── ENTRADAS INDIVIDUALES ────────────────────────────────────────────');
console.log('  Timestamp              Asset  Leg  Ask    PriorRet%  TTR  PrevWin  Streak    W/L    PnL');
console.log('  ' + '─'.repeat(95));
for (const row of rows) {
  const dt = new Date(row.ts).toISOString().replace('T', ' ').substring(0, 19);
  const pr = (row.priorReturn * 100).toFixed(3) + '%';
  const wl = row.win ? 'WIN ' : 'LOSS';
  const pnlStr = (row.pnl >= 0 ? '+' : '') + row.pnl.toFixed(2);
  const prev = row.priorWindowsStr.padEnd(4);
  console.log(`  ${dt}  ${row.asset.padEnd(5)} ${row.leg.padEnd(4)} ${String(row.ask).padStart(5)}  ${pr.padStart(9)}  ${String(row.ttrSec).padStart(3)}  ${prev}     ${row.streakKey.padEnd(10)} ${wl}  ${pnlStr}`);
}

// ── Executive summary ─────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(W));
console.log('  RESUMEN EJECUTIVO');
console.log('═'.repeat(W));

const s3  = ev(streakBuckets['streak_3+']);
const s2  = ev(streakBuckets['streak_2']);
const s1  = ev(streakBuckets['streak_1']);
const sc  = ev(streakBuckets['contra_t1']);

console.log('\n  Por profundidad de racha:');
if (streakBuckets['streak_3+'].n > 0)
  console.log(`    RACHA 3+:  N=${streakBuckets['streak_3+'].n}  WR=${(s3.wr*100).toFixed(1)}%  EV=${s3.evVal>=0?'+':''}${s3.evVal.toFixed(3)}`);
if (streakBuckets['streak_2'].n > 0)
  console.log(`    RACHA 2:   N=${streakBuckets['streak_2'].n}  WR=${(s2.wr*100).toFixed(1)}%  EV=${s2.evVal>=0?'+':''}${s2.evVal.toFixed(3)}`);
if (streakBuckets['streak_1'].n > 0)
  console.log(`    RACHA 1:   N=${streakBuckets['streak_1'].n}  WR=${(s1.wr*100).toFixed(1)}%  EV=${s1.evVal>=0?'+':''}${s1.evVal.toFixed(3)}`);
if (streakBuckets['contra_t1'].n > 0)
  console.log(`    CONTRA T1: N=${streakBuckets['contra_t1'].n}  WR=${(sc.wr*100).toFixed(1)}%  EV=${sc.evVal>=0?'+':''}${sc.evVal.toFixed(3)}`);

const bestKey = streakOrder
  .filter(k => streakBuckets[k].n >= 3)
  .sort((a, b) => ev(streakBuckets[b]).evVal - ev(streakBuckets[a]).evVal)[0];

const worstKey = streakOrder
  .filter(k => streakBuckets[k].n >= 3)
  .sort((a, b) => ev(streakBuckets[a]).evVal - ev(streakBuckets[b]).evVal)[0];

if (bestKey)  console.log(`\n  → Mejor contexto:  ${bestKey} (EV=${ev(streakBuckets[bestKey]).evVal.toFixed(3)})`);
if (worstKey) console.log(`  → Peor contexto:   ${worstKey} (EV=${ev(streakBuckets[worstKey]).evVal.toFixed(3)})`);

const streak2or3 = makeBucket();
for (const key of ['streak_2', 'streak_3+']) {
  streak2or3.n      += streakBuckets[key].n;
  streak2or3.w      += streakBuckets[key].w;
  streak2or3.l      += streakBuckets[key].l;
  streak2or3.sumWin += streakBuckets[key].sumWin;
  streak2or3.sumLoss+= streakBuckets[key].sumLoss;
}
const s23 = ev(streak2or3);

console.log(`\n  Comparación filtro "exigir racha ≥ 2":`);
console.log(`    Con filtro (streak ≥ 2): N=${streak2or3.n}  WR=${(s23.wr*100).toFixed(1)}%  EV=${s23.evVal>=0?'+':''}${s23.evVal.toFixed(3)}`);
console.log(`    Sin filtro (racha 1):    N=${streakBuckets['streak_1'].n}  WR=${(s1.wr*100).toFixed(1)}%  EV=${s1.evVal>=0?'+':''}${s1.evVal.toFixed(3)}`);

if (s23.evVal > s1.evVal + 1.5 && streak2or3.n >= 5) {
  console.log(`\n  → SEÑAL FUERTE: exigir racha ≥ 2 mejora EV en ${(s23.evVal - s1.evVal).toFixed(2)} por entrada.`);
  console.log(`     Implementación: nuevo parámetro momentum_min_streak: 2 en bot.yml`);
  console.log(`     + Lógica en momentum.ts: contar consecutive yesWon en window_results`);
} else if (s23.evVal > s1.evVal + 0.5 && streak2or3.n >= 5) {
  console.log(`\n  → SEÑAL MODERADA: racha ≥ 2 algo mejor (+${(s23.evVal - s1.evVal).toFixed(2)} EV), pero pocas muestras.`);
} else if (streak2or3.n < 5) {
  console.log(`\n  → MUESTRA INSUFICIENTE: solo ${streak2or3.n} entradas con racha ≥ 2. No concluyente.`);
} else {
  console.log(`\n  → SIN SEÑAL CLARA: racha ≥ 2 no mejora significativamente sobre racha 1.`);
}

console.log('═'.repeat(W));
