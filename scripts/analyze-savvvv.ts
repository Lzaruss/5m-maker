/**
 * Análisis de la cuenta Polymarket @savvvv (0x5583a19d5b76276562a9880e7eaa6f3cf5243def)
 * Objetivo: diseccionar la lógica de entrada agrupando trades por conditionId
 */

const WALLET = "0x5583a19d5b76276562a9880e7eaa6f3cf5243def";

interface Trade {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: "TRADE" | "REDEEM";
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: "BUY" | "SELL" | "";
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string;
}

interface WindowStats {
  conditionId: string;
  title: string;
  outcome: string; // "Up" | "Down" | ""
  trades: Trade[];
  buyTrades: Trade[];
  sellTrades: Trade[];
  redeems: Trade[];

  // Entry analysis
  entryPrices: number[];      // price of each BUY
  entryUsdc: number[];        // USDC spent per BUY
  entryTimestamps: number[];
  totalUsdcIn: number;
  totalTokensBought: number;
  avgEntryPrice: number;
  minEntryPrice: number;
  maxEntryPrice: number;
  priceSpread: number;        // max - min entry price (sign of averaging)
  numBuys: number;
  numBuyBursts: number;       // distinct timestamp clusters

  // Exit analysis
  totalUsdcOut: number;       // from SELLs
  totalRedeemed: number;      // from REDEEMs
  totalReturn: number;        // usdcOut + redeemed - usdcIn
  won: boolean | null;        // null = unresolved

  // Averaging signature
  hasAveragingDown: boolean;  // did prices drop then more buys?
  priceSequence: string;      // e.g. "0.51 → 0.38 → 0.30"
  buyBurstPrices: { ts: number; avgPrice: number; usdc: number }[];
}

async function fetchAllTrades(): Promise<Trade[]> {
  const all: Trade[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const url = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=${limit}&offset=${offset}`;
    console.log(`Fetching offset=${offset}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const batch: Trade[] = await res.json();
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return all;
}

function groupByCondition(trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = map.get(t.conditionId) ?? [];
    arr.push(t);
    map.set(t.conditionId, arr);
  }
  return map;
}

/** Group trades within a condition into time-bursts (trades within 5s of each other = same "decision") */
function getBurstGroups(buys: Trade[]): { ts: number; avgPrice: number; usdc: number }[] {
  if (buys.length === 0) return [];
  const sorted = [...buys].sort((a, b) => a.timestamp - b.timestamp);
  const bursts: { ts: number; avgPrice: number; usdc: number }[] = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timestamp - sorted[i - 1].timestamp <= 10) {
      current.push(sorted[i]);
    } else {
      const totalUsdc = current.reduce((s, t) => s + t.usdcSize, 0);
      const totalTokens = current.reduce((s, t) => s + t.size, 0);
      bursts.push({
        ts: current[0].timestamp,
        avgPrice: totalUsdc / totalTokens,
        usdc: totalUsdc,
      });
      current = [sorted[i]];
    }
  }
  // last group
  const totalUsdc = current.reduce((s, t) => s + t.usdcSize, 0);
  const totalTokens = current.reduce((s, t) => s + t.size, 0);
  bursts.push({ ts: current[0].timestamp, avgPrice: totalUsdc / totalTokens, usdc: totalUsdc });

  return bursts;
}

function analyzeWindow(conditionId: string, trades: Trade[]): WindowStats {
  const buys = trades.filter(t => t.type === "TRADE" && t.side === "BUY");
  const sells = trades.filter(t => t.type === "TRADE" && t.side === "SELL");
  const redeems = trades.filter(t => t.type === "REDEEM");

  const entryPrices = buys.map(t => t.price);
  const entryUsdc = buys.map(t => t.usdcSize);
  const entryTimestamps = buys.map(t => t.timestamp);

  const totalUsdcIn = buys.reduce((s, t) => s + t.usdcSize, 0);
  const totalTokensBought = buys.reduce((s, t) => s + t.size, 0);
  const avgEntryPrice = totalUsdcIn / totalTokensBought;
  const minEntryPrice = Math.min(...entryPrices);
  const maxEntryPrice = Math.max(...entryPrices);
  const priceSpread = maxEntryPrice - minEntryPrice;

  const totalUsdcOut = sells.reduce((s, t) => s + t.usdcSize, 0);
  const totalRedeemed = redeems.reduce((s, t) => s + t.usdcSize, 0);
  const totalReturn = totalUsdcOut + totalRedeemed - totalUsdcIn;

  const bursts = getBurstGroups(buys);
  const numBuyBursts = bursts.length;

  // Check for averaging down: later bursts at lower prices
  let hasAveragingDown = false;
  if (bursts.length >= 2) {
    for (let i = 1; i < bursts.length; i++) {
      if (bursts[i].avgPrice < bursts[i - 1].avgPrice * 0.95) {
        hasAveragingDown = true;
        break;
      }
    }
  }

  const priceSequence = bursts.map(b => b.avgPrice.toFixed(3)).join(" → ");

  const title = trades[0]?.title ?? conditionId;
  // outcome from redeem or sell context
  const outcome = trades.find(t => t.outcome)?.outcome ?? "";

  let won: boolean | null = null;
  if (totalRedeemed > 0) won = totalReturn > 0;
  else if (totalUsdcOut > 0) won = totalReturn > 0;

  return {
    conditionId,
    title,
    outcome,
    trades,
    buyTrades: buys,
    sellTrades: sells,
    redeems,
    entryPrices,
    entryUsdc,
    entryTimestamps,
    totalUsdcIn,
    totalTokensBought,
    avgEntryPrice,
    minEntryPrice,
    maxEntryPrice,
    priceSpread,
    numBuys: buys.length,
    numBuyBursts,
    totalUsdcOut,
    totalRedeemed,
    totalReturn,
    won,
    hasAveragingDown,
    priceSequence,
    buyBurstPrices: bursts,
  };
}

function fmt(n: number, d = 2) { return n.toFixed(d); }
function pct(n: number) { return (n * 100).toFixed(1) + "%"; }

async function main() {
  const trades = await fetchAllTrades();
  console.log(`\nTotal records fetched: ${trades.length}`);

  const byType = { TRADE: 0, REDEEM: 0 };
  const bySide = { BUY: 0, SELL: 0 };
  for (const t of trades) {
    byType[t.type] = (byType[t.type] ?? 0) + 1;
    if (t.type === "TRADE") bySide[t.side as "BUY" | "SELL"] = (bySide[t.side as "BUY" | "SELL"] ?? 0) + 1;
  }
  console.log(`TRADEs: ${byType.TRADE}  REDEEMs: ${byType.REDEEM}`);
  console.log(`BUYs: ${bySide.BUY}  SELLs: ${bySide.SELL}`);

  const grouped = groupByCondition(trades);
  console.log(`\nUnique conditionIds (ventanas): ${grouped.size}`);

  const windows = [...grouped.entries()].map(([cid, ts]) => analyzeWindow(cid, ts));

  // ── ESTADÍSTICAS GLOBALES ────────────────────────────────────────────
  const totalUsdcIn = windows.reduce((s, w) => s + w.totalUsdcIn, 0);
  const totalUsdcOut = windows.reduce((s, w) => s + w.totalUsdcOut, 0);
  const totalRedeemed = windows.reduce((s, w) => s + w.totalRedeemed, 0);
  const netPnl = totalUsdcOut + totalRedeemed - totalUsdcIn;

  console.log("\n═══════════════════════════════════════════════");
  console.log("  RESUMEN FINANCIERO GLOBAL");
  console.log("═══════════════════════════════════════════════");
  console.log(`  USDC apostado (BUYs):    $${fmt(totalUsdcIn)}`);
  console.log(`  USDC cobrado (SELLs):    $${fmt(totalUsdcOut)}`);
  console.log(`  USDC redimido:           $${fmt(totalRedeemed)}`);
  console.log(`  PnL neto:                $${fmt(netPnl)}`);

  // ── WIN RATE POR VENTANA ─────────────────────────────────────────────
  const resolved = windows.filter(w => w.won !== null);
  const wins = resolved.filter(w => w.won === true);
  const losses = resolved.filter(w => w.won === false);
  console.log("\n═══════════════════════════════════════════════");
  console.log("  WIN RATE POR VENTANA (conditionId)");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Ventanas resueltas:  ${resolved.length}`);
  console.log(`  Wins:  ${wins.length}  (${pct(wins.length / resolved.length)})`);
  console.log(`  Losses:${losses.length}  (${pct(losses.length / resolved.length)})`);

  // ── ANÁLISIS DE ENTRADA ──────────────────────────────────────────────
  const avgingWindows = windows.filter(w => w.hasAveragingDown);
  const multiburstWindows = windows.filter(w => w.numBuyBursts >= 2);
  console.log("\n═══════════════════════════════════════════════");
  console.log("  ANÁLISIS DE LÓGICA DE ENTRADA");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Ventanas con promediado a la baja: ${avgingWindows.length} / ${windows.length} (${pct(avgingWindows.length / windows.length)})`);
  console.log(`  Ventanas con ≥2 bursts de compra:  ${multiburstWindows.length} / ${windows.length} (${pct(multiburstWindows.length / windows.length)})`);

  // Price distribution of FIRST burst (true entry signal)
  const firstBurstPrices = windows
    .filter(w => w.buyBurstPrices.length > 0)
    .map(w => w.buyBurstPrices[0].avgPrice);

  const buckets: Record<string, number> = {};
  for (const p of firstBurstPrices) {
    const bucket = Math.floor(p * 10) / 10; // round to 0.1
    const key = `${fmt(bucket, 1)}-${fmt(bucket + 0.1, 1)}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  console.log("\n  Distribución de precio de PRIMERA entrada:");
  for (const [range, cnt] of Object.entries(buckets).sort()) {
    const bar = "█".repeat(Math.round(cnt));
    console.log(`    ${range}: ${bar} (${cnt})`);
  }

  // ── SIDE PREFERENCE ──────────────────────────────────────────────────
  const upWindows = windows.filter(w => w.outcome === "Up" || w.title.includes("Up or Down"));
  const downBuys = windows.filter(w => {
    const firstBuy = w.buyTrades[0];
    return firstBuy && w.outcome === "Down";
  });
  const upBuys = windows.filter(w => {
    const firstBuy = w.buyTrades[0];
    return firstBuy && w.outcome === "Up";
  });
  // Count by outcome of the token they bought
  const allBuys = windows.flatMap(w => w.buyTrades);
  // We need to check outcome on the trade
  const upBuyCount = allBuys.filter(t => t.outcome === "Up").length;
  const downBuyCount = allBuys.filter(t => t.outcome === "Down").length;
  console.log("\n═══════════════════════════════════════════════");
  console.log("  SIDE PREFERENCE (qué lado compra)");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Compras en 'Up':   ${upBuyCount} (${pct(upBuyCount / (upBuyCount + downBuyCount))})`);
  console.log(`  Compras en 'Down': ${downBuyCount} (${pct(downBuyCount / (upBuyCount + downBuyCount))})`);

  // ── TOP VENTANAS (por USDC apostado) ─────────────────────────────────
  const top10 = [...windows].sort((a, b) => b.totalUsdcIn - a.totalUsdcIn).slice(0, 15);
  console.log("\n═══════════════════════════════════════════════");
  console.log("  TOP 15 VENTANAS (por USDC apostado)");
  console.log("═══════════════════════════════════════════════");
  console.log("  Título                                        | OutcomeToken | Bursts | AvgEntry | USDCin  | PnL    | Averaging | Seq");
  console.log("  " + "─".repeat(120));
  for (const w of top10) {
    const label = w.title.replace("Bitcoin Up or Down - ", "").substring(0, 30).padEnd(30);
    const outcomeLabel = (w.buyTrades[0]?.outcome ?? "?").padEnd(5);
    const bursts = String(w.numBuyBursts).padStart(2);
    const avgE = fmt(w.avgEntryPrice, 3).padStart(7);
    const usdcIn = fmt(w.totalUsdcIn).padStart(8);
    const pnl = (w.totalReturn >= 0 ? "+" : "") + fmt(w.totalReturn).padStart(7);
    const avg = w.hasAveragingDown ? "YES" : "no ";
    console.log(`  ${label} | ${outcomeLabel}       |  ${bursts}    | ${avgE} | ${usdcIn} | ${pnl} | ${avg}       | ${w.priceSequence}`);
  }

  // ── ANÁLISIS DE AVERAGING DOWN ────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  PATRÓN DE AVERAGING DOWN — Detalle");
  console.log("═══════════════════════════════════════════════");
  const avgDownExamples = avgingWindows.slice(0, 10);
  for (const w of avgDownExamples) {
    console.log(`\n  ${w.title}`);
    console.log(`  Outcome token: ${w.buyTrades[0]?.outcome ?? "?"}`);
    console.log(`  Bursts de compra:`);
    for (const b of w.buyBurstPrices) {
      const ts = new Date(b.ts * 1000).toISOString();
      console.log(`    [${ts}] precio=${fmt(b.avgPrice, 3)}  USDC=$${fmt(b.usdc)}`);
    }
    console.log(`  AvgEntry final: ${fmt(w.avgEntryPrice, 3)}  PnL: ${w.totalReturn >= 0 ? "+" : ""}$${fmt(w.totalReturn)}`);
  }

  // ── DETECTAR SI TIENE SEÑAL DE MOMENTO ───────────────────────────────
  // Proxy: ¿las primeras entradas (precio ~0.50) son antes de window start?
  // ¿Luego promedia a precios bajos (0.25-0.40) cuando el token cayó?
  // Evidencia: en ventanas con averaging, ¿el avg entry es < primera entrada?
  const avgDownData = avgingWindows.map(w => ({
    firstPrice: w.buyBurstPrices[0]?.avgPrice ?? 0,
    lastPrice: w.buyBurstPrices[w.buyBurstPrices.length - 1]?.avgPrice ?? 0,
    avgFinal: w.avgEntryPrice,
    usdcInFirst: w.buyBurstPrices[0]?.usdc ?? 0,
    usdcInTotal: w.totalUsdcIn,
    pnl: w.totalReturn,
  }));

  const withAvgDown = avgDownData.filter(d => d.firstPrice > 0.48);
  console.log("\n═══════════════════════════════════════════════");
  console.log("  SEÑAL DE ENTRADA INICIAL (primer burst ≥ 0.48)");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Ventanas donde entra cerca de 0.50 y luego promedia: ${withAvgDown.length}`);
  if (withAvgDown.length > 0) {
    const avgFirstEntry = withAvgDown.reduce((s, d) => s + d.firstPrice, 0) / withAvgDown.length;
    const avgFinalEntry = withAvgDown.reduce((s, d) => s + d.avgFinal, 0) / withAvgDown.length;
    const pnlSum = withAvgDown.reduce((s, d) => s + d.pnl, 0);
    console.log(`  Precio primer burst promedio: ${fmt(avgFirstEntry, 3)}`);
    console.log(`  Precio entrada final promedio: ${fmt(avgFinalEntry, 3)}`);
    console.log(`  PnL total de este subgrupo:  $${fmt(pnlSum)}`);
  }

  // ── ESTADÍSTICA DE RETORNO SEGÚN PRECIO DE ENTRADA ───────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  RETORNO POR RANGO DE PRECIO PRIMERA ENTRADA");
  console.log("═══════════════════════════════════════════════");
  const priceRanges = [
    [0.10, 0.20], [0.20, 0.30], [0.30, 0.40], [0.40, 0.50], [0.50, 0.60], [0.60, 0.70], [0.70, 1.0],
  ];
  for (const [lo, hi] of priceRanges) {
    const inRange = windows.filter(w => {
      const fp = w.buyBurstPrices[0]?.avgPrice ?? -1;
      return fp >= lo && fp < hi;
    });
    if (inRange.length === 0) continue;
    const totalPnl = inRange.reduce((s, w) => s + w.totalReturn, 0);
    const resInRange = inRange.filter(w => w.won !== null);
    const winsInRange = resInRange.filter(w => w.won === true);
    const wr = resInRange.length > 0 ? winsInRange.length / resInRange.length : NaN;
    console.log(`  ${fmt(lo, 1)}-${fmt(hi, 1)}: n=${String(inRange.length).padStart(3)}  WR=${isNaN(wr) ? "  n/a" : pct(wr).padStart(6)}  PnL=$${fmt(totalPnl).padStart(8)}`);
  }

  // ── TIMING: distribución horaria de trades ───────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  TIMING: ¿Entra al inicio de ventana o mid-window?");
  console.log("═══════════════════════════════════════════════");
  // The market slug contains epoch start time: btc-updown-5m-{epochStart}
  let earlyEntries = 0, lateEntries = 0;
  for (const w of windows) {
    const slug = w.trades[0]?.slug ?? "";
    const match = slug.match(/btc-updown-5m-(\d+)/);
    if (!match) continue;
    const windowStart = parseInt(match[1]);
    const windowEnd = windowStart + 300; // 5 min
    if (w.buyBurstPrices.length === 0) continue;
    const firstBuyTs = w.buyBurstPrices[0].ts;
    const elapsed = firstBuyTs - windowStart;
    if (elapsed < 120) earlyEntries++;
    else lateEntries++;
  }
  console.log(`  Entradas en primeros 2min de ventana: ${earlyEntries} (${pct(earlyEntries / (earlyEntries + lateEntries))})`);
  console.log(`  Entradas tardías (>2min):             ${lateEntries} (${pct(lateEntries / (earlyEntries + lateEntries))})`);

  console.log("\n═══════════════════════════════════════════════");
  console.log("  CONCLUSIONES");
  console.log("═══════════════════════════════════════════════");
}

main().catch(console.error);
