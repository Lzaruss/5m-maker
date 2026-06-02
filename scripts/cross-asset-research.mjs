/**
 * cross-asset-research.mjs
 *
 * Hipótesis: si BTC y ETH están trending en la misma dirección en la misma
 * ventana de 5 minutos, la señal de momentum es más fiable que cuando solo
 * un asset lo hace.
 *
 * Metodología:
 *  1. Construir mapa token → asset (BTC/ETH) desde window_open events
 *  2. Construir timeline de window_result por asset y franja temporal
 *  3. Para cada momentum_entry, determinar el contexto cross-asset:
 *     - ¿Cuál era el resultado del prior window del OTRO asset en el mismo slot?
 *  4. Agrupar entradas por:
 *     - CONSENSUS: el otro asset también iba en la misma dirección que nuestra entrada
 *     - SOLO: el otro asset no tenía datos o no había señal
 *     - CONFLICT: el otro asset iba en dirección opuesta
 *  5. Calcular WR y EV por grupo
 *
 * Uso: node scripts/cross-asset-research.mjs
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_DIR = 'data';
const MATCH_WINDOW_MS = 6 * 60 * 1000; // 6 min para encontrar resultado

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

console.log(`Loaded ${allEvents.length.toLocaleString()} events from ${files.length} files\n`);

// ── 1. Build token → asset map from window_open events ──────────────────────
const tokenToAsset = new Map(); // token → 'BTC' | 'ETH' | etc.
const tokenToResolvesAt = new Map(); // token → resolvesAt ms

for (const e of allEvents) {
  if (e.kind !== 'window_open') continue;
  const question = e.question || '';
  let asset = 'OTHER';
  if (question.startsWith('Bitcoin')) asset = 'BTC';
  else if (question.startsWith('Ethereum')) asset = 'ETH';
  else if (question.startsWith('Solana')) asset = 'SOL';
  else if (question.startsWith('XRP')) asset = 'XRP';
  else if (question.startsWith('BNB')) asset = 'BNB';
  else if (question.startsWith('Dogecoin')) asset = 'DOGE';

  const resolvesAt = e.resolvesAt ? new Date(e.resolvesAt).getTime() : null;
  if (e.yesToken) { tokenToAsset.set(e.yesToken, asset); if (resolvesAt) tokenToResolvesAt.set(e.yesToken, resolvesAt); }
  if (e.noToken)  { tokenToAsset.set(e.noToken,  asset); if (resolvesAt) tokenToResolvesAt.set(e.noToken, resolvesAt); }
}

// ── 2. Build per-asset window results timeline ───────────────────────────────
// Key: "ASSET_resolvesAt" → yesWon (true/false)
const windowResults = new Map(); // "BTC_1780272363000" → true|false

for (const e of allEvents) {
  if (e.kind !== 'window_result') continue;
  const question = e.question || '';
  let asset = 'OTHER';
  if (question.startsWith('Bitcoin')) asset = 'BTC';
  else if (question.startsWith('Ethereum')) asset = 'ETH';
  else if (question.startsWith('Solana')) asset = 'SOL';
  else if (question.startsWith('XRP')) asset = 'XRP';
  else if (question.startsWith('BNB')) asset = 'BNB';
  else if (question.startsWith('Dogecoin')) asset = 'DOGE';
  if (asset === 'OTHER') continue;

  // Get resolvesAt from yesToken or noToken
  const resolvesAt = tokenToResolvesAt.get(e.yesToken) || tokenToResolvesAt.get(e.noToken);
  if (resolvesAt) {
    windowResults.set(`${asset}_${resolvesAt}`, e.yesWon === true);
  }
}

// Also build an ordered list per asset for lookups
// assetWindows: asset → sorted array of {resolvesAt, yesWon}
const assetWindows = new Map();
for (const [key, yesWon] of windowResults) {
  const [asset, rAt] = key.split('_');
  if (!assetWindows.has(asset)) assetWindows.set(asset, []);
  assetWindows.get(asset).push({ resolvesAt: Number(rAt), yesWon });
}
for (const [, arr] of assetWindows) arr.sort((a, b) => a.resolvesAt - b.resolvesAt);

function getPriorWindowResult(asset, beforeTs) {
  const windows = assetWindows.get(asset);
  if (!windows) return null;
  // Find the most recent window that resolved BEFORE this timestamp
  let best = null;
  for (const w of windows) {
    if (w.resolvesAt < beforeTs) best = w;
    else break;
  }
  return best; // { resolvesAt, yesWon }
}

// ── 3. Build entry → result map ──────────────────────────────────────────────
const entries = allEvents.filter(e => e.kind === 'momentum_entry' && !e.dryRun);
const results = allEvents.filter(e => e.kind === 'window_leg_result');

// Map: token → array of results
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
// Stats buckets: consensus / solo / conflict / total
function makeBucket() { return { n: 0, w: 0, l: 0, sumWin: 0, sumLoss: 0 }; }

const buckets = {
  consensus:    makeBucket(), // other asset trending same direction
  solo:         makeBucket(), // other asset no data available
  conflict:     makeBucket(), // other asset trending opposite direction
};

// Cross-asset pairs we'll analyze
const PAIRS = {
  BTC: ['ETH'],
  ETH: ['BTC'],
};

const detailedRows = [];
let noMatch = 0;
let noAsset = 0;

for (const entry of entries) {
  const asset = tokenToAsset.get(entry.token);
  if (!asset || asset === 'OTHER') { noAsset++; continue; }

  const result = findResult(entry);
  if (!result) { noMatch++; continue; }

  const entryLeg = entry.leg; // 'YES' or 'NO'
  const win = result.settle === 1 || result.cashUsd > 0;
  const pnl = result.legPnl || result.cashUsd || 0;

  // Determine what direction this entry predicts: YES means "expects YES to win"
  const entryPrediction = entryLeg === 'YES' ? 'YES' : 'NO';

  // Get cross-asset context: look at paired assets
  const peers = PAIRS[asset] || [];
  let crossContext = 'solo'; // default

  for (const peerAsset of peers) {
    // Find the most recent window_result for the peer asset before this entry
    const priorPeer = getPriorWindowResult(peerAsset, entry.ts);
    if (!priorPeer) continue;

    // Only use if the prior window was recent (within last 10 minutes)
    if (entry.ts - priorPeer.resolvesAt > 10 * 60 * 1000) continue;

    // Peer direction: if yesWon → peer was trending UP (would suggest YES)
    const peerDirection = priorPeer.yesWon ? 'YES' : 'NO';

    if (peerDirection === entryPrediction) {
      crossContext = 'consensus';
    } else {
      crossContext = 'conflict';
    }
    break; // only one peer for now
  }

  const bucket = buckets[crossContext];
  bucket.n++;
  if (win) { bucket.w++; bucket.sumWin += Math.abs(pnl); }
  else      { bucket.l++; bucket.sumLoss += Math.abs(pnl); }

  detailedRows.push({
    ts: entry.ts,
    asset,
    leg: entryLeg,
    ask: entry.ask,
    priorReturn: entry.priorReturn,
    ttrSec: entry.ttrSec,
    crossContext,
    win,
    pnl,
  });
}

// ── 5. Per-asset breakdown ────────────────────────────────────────────────────
const assetBuckets = {};
for (const row of detailedRows) {
  const key = `${row.asset}_${row.crossContext}`;
  if (!assetBuckets[key]) assetBuckets[key] = makeBucket();
  const b = assetBuckets[key];
  b.n++;
  if (row.win) { b.w++; b.sumWin += Math.abs(row.pnl); }
  else          { b.l++; b.sumLoss += Math.abs(row.pnl); }
}

// ── 6. Print ──────────────────────────────────────────────────────────────────
function ev(b) {
  const wr = b.n ? b.w / b.n : 0;
  const avgW = b.w ? b.sumWin / b.w : 0;
  const avgL = b.l ? b.sumLoss / b.l : 0;
  const evVal = wr * avgW - (1 - wr) * avgL;
  return { wr, avgW, avgL, evVal };
}

function bar(evVal, scale = 16) {
  const maxE = 15;
  const filled = Math.round((Math.max(0, evVal) / maxE) * scale);
  return '█'.repeat(Math.min(filled, scale)) + '░'.repeat(Math.max(0, scale - filled));
}

function fmt(b, label) {
  const { wr, avgW, avgL, evVal } = ev(b);
  const wrPct = (wr * 100).toFixed(1);
  const evStr = (evVal >= 0 ? '+' : '') + evVal.toFixed(3);
  const avgWStr = ('+' + avgW.toFixed(2)).padStart(7);
  const avgLStr = ('-' + avgL.toFixed(2)).padStart(7);
  return `  ${label.padEnd(20)} ${String(b.n).padStart(4)} ${String(b.w).padStart(4)} ${String(b.l).padStart(4)}  ${wrPct.padStart(5)}% ${avgWStr} ${avgLStr}  ${evStr.padStart(8)}   ${bar(evVal)}`;
}

const W = 78;
console.log('═'.repeat(W));
console.log('  CROSS-ASSET CONFIRMATION RESEARCH');
console.log(`  Entries analizadas: ${detailedRows.length}  |  Sin match: ${noMatch}  |  Sin asset: ${noAsset}`);
console.log('═'.repeat(W));
console.log('\n── CONTEXTO CROSS-ASSET GLOBAL ──────────────────────────────────────');
console.log(`  ${'Contexto'.padEnd(20)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)}  ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(7)}  ${'EV'.padStart(8)}   Bar`);
console.log('  ' + '─'.repeat(76));

for (const [key, b] of Object.entries(buckets)) {
  const label = key === 'consensus' ? 'CONSENSUS (acuerdo)' :
                key === 'solo'      ? 'SOLO (sin par)'     :
                                     'CONFLICT (opuesto)';
  console.log(fmt(b, label));
}

console.log('\n── DESGLOSE POR ASSET ───────────────────────────────────────────────');
console.log(`  ${'Asset+Contexto'.padEnd(20)} ${'N'.padStart(4)} ${'W'.padStart(4)} ${'L'.padStart(4)}  ${'WR%'.padStart(6)} ${'avgWin'.padStart(7)} ${'avgLoss'.padStart(7)}  ${'EV'.padStart(8)}   Bar`);
console.log('  ' + '─'.repeat(76));

const assetOrder = ['BTC_consensus', 'BTC_solo', 'BTC_conflict', 'ETH_consensus', 'ETH_solo', 'ETH_conflict'];
for (const key of assetOrder) {
  const b = assetBuckets[key];
  if (!b || b.n === 0) continue;
  console.log(fmt(b, key));
}

// ── 7. Detailed entry list ────────────────────────────────────────────────────
console.log('\n── ENTRADAS INDIVIDUALES ────────────────────────────────────────────');
console.log('  Timestamp              Asset  Leg  Ask    PriorRet%  ttrSec  Context    W/L   PnL');
console.log('  ' + '─'.repeat(90));
for (const row of detailedRows) {
  const dt = new Date(row.ts).toISOString().replace('T', ' ').substring(0, 19);
  const pr = (row.priorReturn * 100).toFixed(3) + '%';
  const wl = row.win ? 'WIN ' : 'LOSS';
  const pnlStr = (row.pnl >= 0 ? '+' : '') + row.pnl.toFixed(2);
  console.log(`  ${dt}  ${row.asset.padEnd(5)} ${row.leg.padEnd(4)} ${String(row.ask).padStart(5)}  ${pr.padStart(9)}  ${String(row.ttrSec).padStart(6)}  ${row.crossContext.padEnd(10)} ${wl}  ${pnlStr}`);
}

// ── 8. Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(W));
console.log('  RESUMEN EJECUTIVO');
console.log('═'.repeat(W));

const consensusEv = ev(buckets.consensus);
const soloEv = ev(buckets.solo);
const conflictEv = ev(buckets.conflict);

console.log(`\n  CONSENSUS (otro asset alineado): N=${buckets.consensus.n}  WR=${(consensusEv.wr*100).toFixed(1)}%  EV=${consensusEv.evVal >= 0 ? '+' : ''}${consensusEv.evVal.toFixed(3)}`);
console.log(`  SOLO (sin info del otro asset):  N=${buckets.solo.n}  WR=${(soloEv.wr*100).toFixed(1)}%  EV=${soloEv.evVal >= 0 ? '+' : ''}${soloEv.evVal.toFixed(3)}`);
console.log(`  CONFLICT (otro asset opuesto):   N=${buckets.conflict.n}  WR=${(conflictEv.wr*100).toFixed(1)}%  EV=${conflictEv.evVal >= 0 ? '+' : ''}${conflictEv.evVal.toFixed(3)}`);

const delta = consensusEv.evVal - conflictEv.evVal;
console.log(`\n  Delta EV consensus vs conflict: ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`);
if (buckets.consensus.n >= 5 && delta > 2) {
  console.log('  → SEÑAL FUERTE: consensus entra claramente mejor. Vale la pena implementar filtro.');
} else if (buckets.consensus.n >= 5 && delta > 0.5) {
  console.log('  → SEÑAL MODERADA: consensus algo mejor, pero muestra pequeña. Necesita más datos.');
} else if (buckets.consensus.n < 5) {
  console.log('  → MUESTRA INSUFICIENTE: pocas entradas con consenso. No concluyente todavía.');
} else {
  console.log('  → SIN SEÑAL: consensus no mejora el resultado vs solo.');
}
console.log('═'.repeat(W));
