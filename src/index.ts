/**
 * src/index.ts — LIVE market-making orchestrator (Task 9).
 *
 * ============================ SAFETY OVERVIEW ============================
 * This is the ONLY file that places real orders with real money. Every real
 * order call (placeLimitMaker / cancelByIds / cancelAll / marketFlatten) is
 * gated behind `cfg.live.enabled === true`. When `enabled !== true` the bot
 * runs the full decision loop and LOGS the intended place/cancel/flatten
 * actions via logEvent, but performs NO venue mutations — a safe dry preview.
 *
 * Layered guardrails (all implemented below):
 *   1. enabled gate — no real order calls unless cfg.live.enabled === true.
 *   2. shutdown handler — SIGINT/SIGTERM/uncaughtException -> cancelAll (if
 *      enabled) -> closeLog -> exit, running exactly once.
 *   3. per-place deployed-capital check — recomputed immediately before each
 *      placeLimitMaker; the place is skipped if it would breach maxDeployedUsd.
 *   4. daily-loss halt — if realized+marked PnL for the UTC day reaches
 *      -dailyLossHaltUsd we cancel everything and stop quoting until 00:00 UTC.
 *   5. single asset (BTC), single window at a time.
 *
 * When anything is ambiguous we make the SAFER choice (fewer / smaller orders,
 * more cancels). See inline notes marked "SAFER:".
 * ========================================================================
 */

import { loadBotYaml, loadEnv, type BotConfig } from './util/config.js';
import { logger } from './util/logger.js';
import { getUsdcBalance } from './clob/client.js';
import { fetchMarkets, fetchResolution, type ShortMarket } from './markets/gammaPoller.js';
import { PriceFeed } from './signals/priceFeed.js';
import { ClobMarketFeed, type BookSnapshot } from './marketFeed/clobMarketFeed.js';
import { computeQuotes } from './engine/quoter.js';
import { checkGates } from './live/riskGate.js';
import { reconcile, type DesiredQuote, type LiveOrder } from './live/reconciler.js';
import { emptyAccount, applyTrade, pnl, type Account } from './live/accounting.js';
import {
  placeLimitMaker,
  cancelByIds,
  cancelAll,
  listOpenOrders,
  marketFlatten,
} from './clob/orders.js';
import { fetchOurTrades } from './clob/trades.js';
import { logEvent, closeLog } from './persistence/eventLog.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** UTC calendar-day string (YYYY-MM-DD) used to scope the daily loss halt. */
function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Epoch-ms of the next UTC midnight after `now` (when a halt may lift). */
function nextUtcMidnightMs(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}

/** Sum of resting BUY-order notional (price*size). Used for deployed capital. */
function openBuyNotional(open: LiveOrder[]): number {
  let sum = 0;
  for (const o of open) if (o.side === 'BUY') sum += o.price * o.size;
  return sum;
}

// --------------------------------------------------------------------------
// Shutdown — runs exactly once.
// --------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Graceful shutdown. SAFER: always attempt cancelAll when live, even if we are
 * not certain anything is resting, so we never leave orphaned orders behind.
 */
async function shutdown(reason: string, enabled: boolean, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    logger.warn({ reason }, 'shutting down');
    logEvent({ kind: 'shutdown', reason });
    if (enabled) {
      try {
        await cancelAll();
      } catch (err: any) {
        logger.error({ err: err.message }, 'cancelAll during shutdown failed');
      }
    }
  } finally {
    await closeLog();
    process.exit(code);
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg: BotConfig = loadBotYaml();
  const env = loadEnv();
  const enabled = cfg.live.enabled === true;

  // Install signal / crash handlers up front so an early failure still cleans up.
  process.on('SIGINT', () => void shutdown('SIGINT', enabled, 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', enabled, 0));
  process.on('uncaughtException', (err) => {
    logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'uncaughtException');
    void shutdown('uncaughtException', enabled, 1);
  });
  process.on('unhandledRejection', (reason: any) => {
    logger.error({ reason: reason?.message ?? String(reason) }, 'unhandledRejection');
    void shutdown('unhandledRejection', enabled, 1);
  });

  // Read balance once at startup for the audit trail. SAFER: tolerate failure
  // (e.g. read-only preview without creds) — log NaN rather than crashing.
  let balance = NaN;
  try {
    balance = await getUsdcBalance();
  } catch (err: any) {
    logger.warn({ err: err.message }, 'getUsdcBalance failed at startup');
  }

  logEvent({
    kind: 'start',
    enabled,
    dryRun: env.dryRun,
    balanceUsd: balance,
    live: cfg.live,
    maker: cfg.maker,
  });
  logger.info(
    { enabled, balanceUsd: balance, live: cfg.live },
    enabled ? 'LIVE TRADING ENABLED — real orders will be placed' : 'DRY PREVIEW — no real orders',
  );

  // Single asset by design. SAFER: pin to BTC regardless of config breadth so a
  // misconfigured assets list can never widen the blast radius.
  const ASSET = 'BTC' as const;

  // Warm up the Binance price feed so the 30s return (adverse-selection guard)
  // is populated before we quote.
  const priceFeed = new PriceFeed();
  priceFeed.start([ASSET]);
  await sleep(3000);

  // Per-UTC-day realized PnL accounting and halt state.
  let today = utcDay();
  let realizedTodayUsd = 0;
  let halted = false;
  let haltUntilMs = 0;

  // Latest order book for the current window, fed by the CLOB market feed.
  // Held in a mutable object so the onBook closure write and the loop reads
  // share one reference without TS control-flow narrowing it to `never`.
  const bookHolder: { current: BookSnapshot | null } = { current: null };
  const marketFeed = new ClobMarketFeed({
    onBook: (snap) => {
      bookHolder.current = snap;
    },
  });
  // Typed accessor: returns the declared union so reads aren't narrowed to
  // `never` by the `bookHolder.current = null` reset between windows.
  const getBook = (): BookSnapshot | null => bookHolder.current;

  // ------------------------------------------------------------------ outer loop
  // One iteration per trading window. We only ever track a single window at a
  // time (single asset, single window — guardrail #5).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shuttingDown) return;

    // Roll the day over: reset realized PnL and clear any halt at UTC midnight.
    const nowDay = utcDay();
    if (nowDay !== today) {
      logEvent({ kind: 'day_rollover', from: today, to: nowDay, realizedClosedUsd: realizedTodayUsd });
      today = nowDay;
      realizedTodayUsd = 0;
      halted = false;
      haltUntilMs = 0;
    }

    // If halted, idle until the next UTC midnight (or until the day rolls over).
    if (halted) {
      const waitMs = Math.max(1000, Math.min(60_000, haltUntilMs - Date.now()));
      if (Date.now() >= haltUntilMs) {
        halted = false; // day boundary reached; loop top will reset accounting
        continue;
      }
      await sleep(waitMs);
      continue;
    }

    // Discover the soonest-resolving BTC 5-minute window that hasn't resolved.
    const markets = await fetchMarkets([ASSET], 5);
    const now = Date.now();
    const market: ShortMarket | undefined = markets
      .filter((m) => m.resolvesAt.getTime() > now)
      .sort((a, b) => a.resolvesAt.getTime() - b.resolvesAt.getTime())[0];

    if (!market) {
      await sleep(2000);
      continue;
    }

    const token = market.yesTokenId;
    const resolvesAtMs = market.resolvesAt.getTime();
    logEvent({
      kind: 'window_open',
      token,
      question: market.question,
      resolvesAt: market.resolvesAt.toISOString(),
    });
    logger.info({ token: token.slice(0, 10), resolvesAt: market.resolvesAt.toISOString() }, 'window open');

    // Fresh per-window state.
    let account: Account = emptyAccount();
    let sinceMs = Date.now();
    let flattened = false;
    bookHolder.current = null;

    // Subscribe the market feed to this window's YES token.
    marketFeed.setAssets([token]);

    // ------------------------------------------------------------ inner loop
    // Quote/flatten cadence until 60s past resolution (gives fills time to land).
    while (Date.now() <= resolvesAtMs + 60_000) {
      if (shuttingDown) return;
      await sleep(cfg.live.pollIntervalMs);

      // 1. Pull our executed trades and fold them into the account. Idempotent
      //    on trade id; advance the cursor past the newest trade we have seen.
      const trades = await fetchOurTrades(token, sinceMs);
      for (const t of trades) {
        if (account.seen.has(t.id)) continue;
        account = applyTrade(account, t);
        if (t.tsMs > sinceMs) sinceMs = t.tsMs;
        logEvent({ kind: 'fill', token, id: t.id, side: t.side, price: t.price, shares: t.shares });
      }

      // 2. Need a book to do anything.
      const book = getBook();
      if (!book || book.bids.length === 0 || book.asks.length === 0) continue;
      const bestBid = book.bids[0].price;
      const bestAsk = book.asks[0].price;
      if (!(bestBid > 0) || !(bestAsk > 0)) continue;

      const mid = (bestBid + bestAsk) / 2;
      const tNow = Date.now();
      const timeToResolveSec = (resolvesAtMs - tNow) / 1000;
      const inventoryUsd = account.shares * mid;

      // 3. Daily-loss halt (guardrail #4). Mark the open window to current mid.
      const dayPnl = realizedTodayUsd + pnl(account, mid);
      if (dayPnl <= -cfg.live.dailyLossHaltUsd) {
        logEvent({ kind: 'halt', token, dayPnl, dailyLossHaltUsd: cfg.live.dailyLossHaltUsd });
        logger.error({ dayPnl }, 'DAILY LOSS HALT — cancelling everything and pausing until UTC midnight');
        if (enabled) await cancelAll();
        halted = true;
        haltUntilMs = nextUtcMidnightMs();
        break; // leave inner loop; outer loop idles until the new UTC day
      }

      // 4. FLATTEN PHASE (guardrail: close out before resolution). Inside the
      //    flatten window we never quote — only cancel resting orders and, if
      //    inventory is meaningful, market-flatten it once.
      if (timeToResolveSec <= cfg.maker.flattenBeforeSec) {
        const open = await listOpenOrders(token);
        if (open.length > 0) {
          logEvent({ kind: 'flatten_cancel', token, ids: open.map((o) => o.id) });
          if (enabled) await cancelByIds(open.map((o) => o.id));
        }
        if (Math.abs(inventoryUsd) > cfg.maker.flattenIfNetAboveUsd && !flattened) {
          const side = account.shares > 0 ? 'SELL' : 'BUY';
          const amount = Math.abs(account.shares);
          logEvent({ kind: 'flatten', token, side, amount, inventoryUsd });
          logger.warn({ side, amount, inventoryUsd }, 'flattening residual inventory');
          if (enabled) await marketFlatten(token, side, amount);
          flattened = true; // flatten at most once per window regardless of fills
        }
        continue; // no quoting in the flatten window
      }

      // 5. QUOTE PHASE.
      //    Deployed capital = resting BUY notional + |inventory| value. This is
      //    the figure both the risk gate and the per-place check use.
      const openNow = await listOpenOrders(token);
      const deployed = openBuyNotional(openNow) + Math.abs(account.shares) * mid;

      const gates = checkGates({
        realizedPnlTodayUsd: dayPnl,
        deployedUsd: deployed,
        inventoryUsd,
        maxDeployedUsd: cfg.live.maxDeployedUsd,
        dailyLossHaltUsd: cfg.live.dailyLossHaltUsd,
        maxInventoryUsd: cfg.maker.maxInventoryUsd,
      });

      const decision = computeQuotes(
        {
          bestBid,
          bestAsk,
          inventoryShares: account.shares,
          inventoryUsd,
          btcReturn30s: priceFeed.getReturn(ASSET, 30),
          timeToResolveSec,
        },
        cfg.maker,
      );

      // Build the desired quote set, filtered by the risk gate. If the gate is
      // halted or the quoter declines, desired is empty -> reconcile cancels all.
      const desired: DesiredQuote[] = [];
      if (!gates.halted && decision.action === 'quote') {
        if (decision.bid && gates.allowBuy) {
          desired.push({ side: 'BUY', price: decision.bid.price, size: decision.bid.sizeShares });
        }
        if (decision.ask && gates.allowSell) {
          desired.push({ side: 'SELL', price: decision.ask.price, size: decision.ask.sizeShares });
        }
      }

      // Reconcile against what is actually resting (no churn if already correct).
      const open: LiveOrder[] = openNow;
      const { toCancel, toPlace } = reconcile(open, desired, cfg.maker.tickSize);
      logEvent({
        kind: 'reconcile',
        token,
        reason: decision.reason,
        gate: gates.reason,
        toCancel,
        toPlace,
        deployed,
        dayPnl,
      });

      if (!enabled) continue; // DRY PREVIEW — logged intentions only, no mutations.

      // Cancel first so freed capital is available before we place.
      await cancelByIds(toCancel);

      // Per-place deployed-capital recheck (guardrail #3). We track deployed as
      // we go so a batch of places can't collectively breach the cap.
      let deployedSoFar = deployed;
      for (const p of toPlace) {
        const add = p.price * p.size;
        if (deployedSoFar + add > cfg.live.maxDeployedUsd) {
          logEvent({ kind: 'place_skipped', token, reason: 'max_deployed', side: p.side, price: p.price, size: p.size, deployedSoFar });
          continue; // SAFER: skip rather than shrink — never exceed the cap
        }
        const placed = await placeLimitMaker(token, p.side, p.price, p.size);
        logEvent({ kind: 'place', token, side: p.side, price: p.price, size: p.size, ok: !!placed, orderId: placed?.orderId ?? null });
        if (placed) deployedSoFar += add; // only count capital that actually rested
      }
    }
    // ---------------------------------------------------------- end inner loop

    // If we halted, skip settlement bookkeeping for this window — the outer loop
    // will idle until the next UTC day.
    if (halted) {
      marketFeed.setAssets([]);
      continue;
    }

    // Settle the window: prefer the on-chain resolution; fall back to last mid.
    const res = await fetchResolution(token);
    const finalBook = getBook();
    const fallbackMid =
      finalBook && finalBook.bids.length && finalBook.asks.length
        ? (finalBook.bids[0].price + finalBook.asks[0].price) / 2
        : 0.5;
    const settle = res ? (res.yesWon ? 1 : 0) : fallbackMid;
    const windowPnl = pnl(account, settle);
    realizedTodayUsd += windowPnl;

    logEvent({
      kind: 'window_result',
      token,
      windowPnl,
      realizedTodayUsd,
      shares: account.shares,
      settle,
      resolved: !!res,
    });
    logger.info({ token: token.slice(0, 10), windowPnl, realizedTodayUsd, settle }, 'window result');

    // Unsubscribe the feed before moving to the next window.
    marketFeed.setAssets([]);
  }
  // -------------------------------------------------------------- end outer loop
}

main().catch(async (err: any) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal error in main');
  logEvent({ kind: 'fatal', err: err.message });
  // We don't know enabled here for certain; re-derive defensively and cancel.
  let enabled = false;
  try {
    enabled = loadBotYaml().live.enabled === true;
  } catch {
    /* ignore — fall back to no real calls */
  }
  await shutdown('fatal', enabled, 1);
});
