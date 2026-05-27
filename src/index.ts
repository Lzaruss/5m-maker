/**
 * src/index.ts — LIVE market-making orchestrator (dual-token: YES + NO).
 *
 * ============================ SAFETY OVERVIEW ============================
 * This is the ONLY file that places real orders with real money. Every real
 * order call (placeLimitMaker / cancelByIds / cancelAll / marketFlatten) is
 * gated behind `cfg.live.enabled === true`. When `enabled !== true` the bot
 * runs the full decision loop and LOGS the intended place/cancel/flatten
 * actions via logEvent, but performs NO venue mutations — a safe dry preview.
 *
 * STRATEGY (two-sided market-making WITHOUT shorting):
 *   For each 5m binary market we quote BUY on BOTH outcome tokens (YES + NO)
 *   in parallel. Polymarket rejects SELL orders unless we own the underlying
 *   token, so the canonical Polymarket maker design is "BUY both legs". If we
 *   get filled on each leg, `1 YES + 1 NO = $1` at settlement regardless of
 *   outcome — the combined spread we captured is risk-free profit. If only one
 *   leg fills we carry that directional position to resolution.
 *
 *   SELL orders are still posted, BUT suppressed automatically when we don't
 *   own enough shares to back them (avoids the venue's "insufficient balance"
 *   rejection storm). This lets the bot capture spread on the way OUT once a
 *   BUY has filled.
 *
 * Layered guardrails:
 *   1. enabled gate — no real order calls unless cfg.live.enabled === true.
 *   2. shutdown handler — SIGINT/SIGTERM/uncaughtException -> cancelAll (if
 *      enabled) -> closeLog -> exit, running exactly once.
 *   3. per-place deployed-capital check — recomputed immediately before each
 *      placeLimitMaker; the place is skipped if it would breach maxDeployedUsd.
 *      Tracked GLOBALLY across both YES and NO legs.
 *   4. daily-loss halt — if realized+marked PnL for the UTC day reaches
 *      -dailyLossHaltUsd we cancel everything and stop quoting until 00:00 UTC.
 *   5. single asset (BTC), single window at a time.
 *
 * When anything is ambiguous we make the SAFER choice (fewer / smaller orders,
 * more cancels). See inline notes marked "SAFER:".
 * ========================================================================
 */

import { loadBotYaml, loadEnv, assertLiveEnv, type BotConfig } from './util/config.js';
import { logger } from './util/logger.js';
import { getUsdcBalance } from './clob/client.js';
import { fetchMarkets, fetchResolution, gammaBackoffMs, type ShortMarket } from './markets/gammaPoller.js';
import { PriceFeed } from './signals/priceFeed.js';
import { ClobMarketFeed, type BookSnapshot } from './marketFeed/clobMarketFeed.js';
import { computeQuotes } from './engine/quoter.js';
import { checkGates } from './live/riskGate.js';
import { reconcile, type DesiredQuote, type LiveOrder } from './live/reconciler.js';
import { emptyAccount, applyTrade, pnl, reconcileAccount, type Account } from './live/accounting.js';
import {
  buildDesired,
  hedgeBlocksBuy as computeHedgeBlock,
  spendBlocksBuy as computeSpendBlock,
  legSettlePrice,
} from './live/legPolicy.js';
import { fetchOnchainShares } from './clob/reconcileInventory.js';
import {
  placeLimitMaker,
  cancelByIds,
  cancelAll,
  listOpenOrders,
  marketFlatten,
  isThrottled,
  throttleRemainingMs,
  isSellBalanceRejected,
  clearSellBalanceRejected,
} from './clob/orders.js';
import { fetchOurTrades } from './clob/trades.js';
import { logEvent, closeLog } from './persistence/eventLog.js';
import { createBot } from './telegram/bot.js';
import { registerCommands } from './telegram/commands.js';
import { Notifier } from './telegram/notifier.js';
import { emptyState, type BotState } from './telegram/state.js';

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

interface TokenLeg {
  tokenId: string;
  label: 'YES' | 'NO';
  account: Account;
  sinceMs: number;
  flattened: boolean;
  /** Cumulative BUY notional successfully placed on this leg in the current
   *  window. Used by the per-leg spend cap (`maxSpendPerLegUsd`) — once we
   *  cross the cap, no more BUYs on this leg until the next window. Counts
   *  ALL placed BUYs (including ones that ended up cancelled) which makes
   *  the cap conservative but immune to /activity polling lag. */
  buyNotionalCommitted: number;
}

// --------------------------------------------------------------------------
// Shutdown — runs exactly once.
// --------------------------------------------------------------------------

let shuttingDown = false;

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

  if (enabled) assertLiveEnv(env);

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

  // ------------------------------------------------------------------ Telegram
  // Shared state lives here so commands can read/write it concurrently with the
  // main loop. Bot creation is silent if creds are missing (createBot returns
  // null) — Telegram is optional, not load-bearing for trading.
  const state: BotState = emptyState();
  state.enabled = enabled;
  state.startBalanceUsd = balance;
  const tgBot = createBot({ token: env.telegramBotToken, allowedChatId: env.telegramChatId });
  const notifier = new Notifier(tgBot, env.telegramChatId);
  if (tgBot) {
    registerCommands({
      bot: tgBot,
      chatId: env.telegramChatId,
      state,
      cfg: {
        dailyLossHaltUsd: cfg.live.dailyLossHaltUsd,
        sessionLossHaltUsd: cfg.live.sessionLossHaltUsd,
        maxDeployedUsd: cfg.live.maxDeployedUsd,
      },
      requestShutdown: (reason) => void shutdown(reason, enabled, 0),
    });
    logger.info('telegram bot online');
    void notifier.start(balance, cfg.live.sessionLossHaltUsd, cfg.live.dailyLossHaltUsd);
  }

  const ASSET = 'BTC' as const;

  // Warm up the Binance price feed BEFORE quoting — `getReturn(30)` needs ~24s
  // of buffered ticks to return a non-null value.
  const priceFeed = new PriceFeed();
  priceFeed.start([ASSET]);
  const ready = await priceFeed.waitUntilReady([ASSET], 40_000);
  if (!ready) {
    logger.warn('priceFeed warm-up timed out — adverse-selection guard will activate once data arrives');
  }

  // Per-UTC-day realized PnL accounting and halt state (shared across both legs).
  let today = utcDay();
  let realizedTodayUsd = 0;
  // Cumulative realized P&L since process startup — survives the UTC-midnight
  // reset that wipes `realizedTodayUsd`. Used by the HARD session-loss halt
  // (overnight safety net: when crossed, bot exits and requires manual restart).
  let realizedSessionUsd = 0;
  let halted = false;
  let haltUntilMs = 0;

  // Per-token book holder. The market feed maintains its own per-asset book
  // internally; we mirror the latest snapshot here keyed by tokenId so the loop
  // can read either leg's touch in O(1). Reset between windows.
  const books: Map<string, BookSnapshot> = new Map();
  // Last-known mid per token. Used as fallback when the current book is empty
  // or one-sided for a moment (it happens during violent moves) — without this
  // fallback, `mid=0` would mark inventory at $0 and spuriously trip the
  // daily-loss halt while we're actually holding valuable shares. Reset
  // between windows along with `books`.
  const lastMids: Map<string, number> = new Map();
  const marketFeed = new ClobMarketFeed({
    onBook: (snap) => {
      books.set(snap.assetId, snap);
      if (snap.bids.length > 0 && snap.asks.length > 0) {
        const mid = (snap.bids[0].price + snap.asks[0].price) / 2;
        if (mid > 0) lastMids.set(snap.assetId, mid);
      }
    },
  });

  // Rolling counters for the periodic `summary` event. Reset only on process
  // restart — useful for overnight monitoring without grepping the full log.
  const sessionStartMs = Date.now();
  let lastSummaryMs = sessionStartMs;
  let placeOkCount = 0;
  let placeFailCount = 0;
  let hedgeBlockCount = 0;
  let spendBlockCount = 0;
  let windowsCount = 0;
  let winningWindows = 0;
  let losingWindows = 0;
  const SUMMARY_INTERVAL_MS = 5 * 60_000;
  // Last on-chain reconciliation timestamp (0 => fire on the first eligible tick).
  let lastReconcileMs = 0;

  // ------------------------------------------------------------------ outer loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shuttingDown) return;

    const nowDay = utcDay();
    if (nowDay !== today) {
      logEvent({ kind: 'day_rollover', from: today, to: nowDay, realizedClosedUsd: realizedTodayUsd });
      today = nowDay;
      realizedTodayUsd = 0;
      halted = false;
      haltUntilMs = 0;
    }

    if (halted) {
      const waitMs = Math.max(1000, Math.min(60_000, haltUntilMs - Date.now()));
      if (Date.now() >= haltUntilMs) {
        halted = false;
        continue;
      }
      await sleep(waitMs);
      continue;
    }

    const markets = await fetchMarkets([ASSET], 5);
    const now = Date.now();
    const market: ShortMarket | undefined = markets
      .filter((m) => m.resolvesAt.getTime() > now)
      .sort((a, b) => a.resolvesAt.getTime() - b.resolvesAt.getTime())[0];

    if (!market) {
      // Use exponential backoff during Gamma API outages — without this the
      // 2s retry floods the log and burns rate-limit budget. Returns 0 when
      // Gamma is healthy (empty result means "no matching market right now").
      const backoff = gammaBackoffMs();
      await sleep(Math.max(2000, backoff));
      continue;
    }

    const resolvesAtMs = market.resolvesAt.getTime();
    // sinceMs floor for fetchOurTrades. Start 60s BEFORE window open so any
    // fill that happens in the first second of the window (before our first
    // poll) is still captured. fetchOurTrades adds its own slack on top.
    const windowSinceMs = Date.now() - 60_000;
    const legs: TokenLeg[] = [
      { tokenId: market.yesTokenId, label: 'YES', account: emptyAccount(), sinceMs: windowSinceMs, flattened: false, buyNotionalCommitted: 0 },
      { tokenId: market.noTokenId, label: 'NO', account: emptyAccount(), sinceMs: windowSinceMs, flattened: false, buyNotionalCommitted: 0 },
    ];
    // Clear any SELL suppression from the previous window so both legs start clean.
    for (const leg of legs) clearSellBalanceRejected(leg.tokenId);

    logEvent({
      kind: 'window_open',
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
      question: market.question,
      resolvesAt: market.resolvesAt.toISOString(),
    });
    logger.info(
      {
        yesToken: market.yesTokenId.slice(0, 10),
        noToken: market.noTokenId.slice(0, 10),
        resolvesAt: market.resolvesAt.toISOString(),
      },
      'window open',
    );

    // Reset per-window book + last-mid state and subscribe to BOTH outcome tokens.
    for (const leg of legs) {
      books.delete(leg.tokenId);
      lastMids.delete(leg.tokenId);
    }
    marketFeed.setAssets(legs.map((l) => l.tokenId));

    // ------------------------------------------------------------ inner loop
    while (Date.now() <= resolvesAtMs + 60_000) {
      if (shuttingDown) return;
      await sleep(cfg.live.pollIntervalMs);

      // Mirror live counters into the shared state so /status etc. are O(1).
      state.realizedTodayUsd = realizedTodayUsd;
      state.realizedSessionUsd = realizedSessionUsd;
      state.windowsCount = windowsCount;
      state.winningWindows = winningWindows;
      state.losingWindows = losingWindows;
      state.placeOkCount = placeOkCount;
      state.placeFailCount = placeFailCount;
      state.haltedDaily = halted;
      state.haltUntilMs = haltUntilMs;

      // Periodic summary so overnight sessions are scan-friendly without
      // grepping per-window events. Includes everything needed at-a-glance:
      // P&L (realized today + session), throughput, failure rate, and how
      // often each cap is gating BUYs.
      if (Date.now() - lastSummaryMs >= SUMMARY_INTERVAL_MS) {
        const placeTotal = placeOkCount + placeFailCount;
        const failRate = placeTotal > 0 ? placeFailCount / placeTotal : 0;
        const uptimeMin = Math.round((Date.now() - sessionStartMs) / 60_000);
        logEvent({
          kind: 'summary',
          uptimeMin,
          realizedTodayUsd,
          realizedSessionUsd,
          windowsCount,
          winningWindows,
          losingWindows,
          placeOkCount,
          placeFailCount,
          placeFailRatePct: Math.round(failRate * 100),
          hedgeBlockCount,
          spendBlockCount,
          throttled: isThrottled(),
        });
        logger.info(
          {
            uptimeMin,
            realizedSessionUsd: Number(realizedSessionUsd.toFixed(2)),
            windowsCount,
            winRate: windowsCount > 0 ? Math.round((100 * winningWindows) / windowsCount) : 0,
            placeFailRatePct: Math.round(failRate * 100),
          },
          'summary',
        );
        lastSummaryMs = Date.now();
      }

      // 1. Pull fills for each leg independently. We do NOT advance sinceMs
      //    based on individual fills — that previously dropped late-arriving
      //    fills permanently and led to the 2026-05-27 -$47 stuck-positions
      //    leak. Dedup is the responsibility of `leg.account.seen`.
      for (const leg of legs) {
        const trades = await fetchOurTrades(leg.tokenId, leg.sinceMs);
        for (const t of trades) {
          if (leg.account.seen.has(t.id)) continue;
          leg.account = applyTrade(leg.account, t);
          logEvent({
            kind: 'fill',
            token: leg.tokenId,
            leg: leg.label,
            id: t.id,
            side: t.side,
            price: t.price,
            shares: t.shares,
          });
        }
      }

      // 1b. ON-CHAIN RECONCILIATION (drift guard). The fill poller can lag/miss
      //     trades; periodically compare tracked shares to the venue's true
      //     holdings. When we hold a real position the tracker under-counts
      //     (the stuck-position leak), snap to truth and debit cash at the real
      //     cost basis. The ambiguous "tracked>0 but none on-chain" case is only
      //     LOGGED (likely poll lag or post-resolution worthless) — never auto-
      //     zeroed, which would fabricate PnL.
      if (
        cfg.live.reconcileEverySec > 0 &&
        Date.now() - lastReconcileMs >= cfg.live.reconcileEverySec * 1000
      ) {
        lastReconcileMs = Date.now();
        const onchain = await fetchOnchainShares(legs.map((l) => l.tokenId));
        if (onchain) {
          for (const leg of legs) {
            const oc = onchain.get(leg.tokenId);
            if (oc) {
              const before = leg.account.shares;
              const r = reconcileAccount(leg.account, oc.shares, oc.avgPrice);
              logEvent({
                kind: 'reconcile_check',
                token: leg.tokenId,
                leg: leg.label,
                tracked: before,
                onchain: oc.shares,
                avgPrice: oc.avgPrice,
                drift: r.drift,
                corrected: r.corrected && cfg.live.reconcileCorrect,
              });
              if (r.corrected && cfg.live.reconcileCorrect) {
                leg.account = r.account;
                logger.warn(
                  { leg: leg.label, before, onchain: oc.shares, avgPrice: oc.avgPrice, drift: r.drift },
                  'inventory drift CORRECTED to on-chain truth',
                );
              }
            } else if (Math.abs(leg.account.shares) > 0.5) {
              logEvent({
                kind: 'reconcile_phantom',
                token: leg.tokenId,
                leg: leg.label,
                tracked: leg.account.shares,
                note: 'tracked shares but none on-chain (poll lag or worthless) — not auto-zeroed',
              });
            }
          }
        }
      }

      // 2. Compute marks and the global dayPnl. A leg with no usable book is
      //    EXCLUDED from the mark — falling back to mid=0 there would value
      //    real inventory at $0 and falsely trip the daily-loss halt during
      //    transient empty-book moments (the violent-move scenario that bit
      //    us on 2026-05-26 19:49 UTC).
      const legMids: Record<string, number> = {};
      let markPnl = 0;
      let unmarkedLegs = 0;
      for (const leg of legs) {
        const book = books.get(leg.tokenId);
        const bookMid =
          book && book.bids.length && book.asks.length
            ? (book.bids[0].price + book.asks[0].price) / 2
            : 0;
        const mid = bookMid > 0 ? bookMid : (lastMids.get(leg.tokenId) ?? 0);
        legMids[leg.tokenId] = mid;
        if (mid > 0) {
          markPnl += pnl(leg.account, mid);
        } else if (leg.account.shares !== 0) {
          // We hold shares but have NO mark — be conservative for the gate but
          // do not trip the halt on a noisy book moment.
          unmarkedLegs++;
        }
      }
      const dayPnl = realizedTodayUsd + markPnl;

      const tNow = Date.now();
      const timeToResolveSec = (resolvesAtMs - tNow) / 1000;

      // 3. Daily-loss halt (guardrail #4). REALIZED-only: only locked-in P&L
      //    from closed windows can trip the halt. Mark-to-mid mid-window is
      //    advisory because in binary markets the mid is a probability while
      //    the eventual settle is 0/1 — a "marked loser" hedged inventory can
      //    redeem profitably (the 2026-05-26 20:09 UTC episode: marked -$3.54
      //    but actually +$0.81 after NO redeemed). We do log a `mark_warn`
      //    event so the operator sees mark stress without forcing a halt.
      if (markPnl <= -cfg.live.dailyLossHaltUsd && unmarkedLegs === 0) {
        logEvent({ kind: 'mark_warn', markPnl, threshold: -cfg.live.dailyLossHaltUsd, realizedTodayUsd });
      }
      if (realizedTodayUsd <= -cfg.live.dailyLossHaltUsd) {
        logEvent({ kind: 'halt', realizedTodayUsd, dailyLossHaltUsd: cfg.live.dailyLossHaltUsd, dayPnl });
        logger.error({ realizedTodayUsd, dayPnl }, 'DAILY LOSS HALT (realized) — cancelling, flattening, and pausing until UTC midnight');
        void notifier.dailyHalt(realizedTodayUsd, cfg.live.dailyLossHaltUsd);
        if (enabled) await cancelAll();
        for (const leg of legs) {
          if (leg.account.shares === 0) continue;
          const book = books.get(leg.tokenId);
          if (!book || book.bids.length === 0 || book.asks.length === 0) continue;
          const side: 'BUY' | 'SELL' = leg.account.shares > 0 ? 'SELL' : 'BUY';
          const shares = Math.abs(leg.account.shares);
          const refPrice = side === 'BUY' ? book.asks[0].price : book.bids[0].price;
          logEvent({ kind: 'halt_flatten', token: leg.tokenId, leg: leg.label, side, shares, refPrice });
          if (enabled) await marketFlatten(leg.tokenId, side, shares, refPrice);
        }
        halted = true;
        haltUntilMs = nextUtcMidnightMs();
        break;
      }

      // 4. FLATTEN PHASE — applies to BOTH legs. We always cancel resting
      //    orders at the boundary (otherwise we'd get lifted on the converging
      //    touch). Whether to ALSO market-flatten residual inventory depends
      //    on the strategy mode: classic mode flattens; BUY-only / hold-to-
      //    resolution mode (disable_sell) lets the residual ride to settlement.
      if (timeToResolveSec <= cfg.maker.flattenBeforeSec) {
        for (const leg of legs) {
          const mid = legMids[leg.tokenId];
          if (!(mid > 0)) continue;
          const open = await listOpenOrders(leg.tokenId);
          if (open.length > 0) {
            logEvent({ kind: 'flatten_cancel', token: leg.tokenId, leg: leg.label, ids: open.map((o) => o.id) });
            if (enabled) await cancelByIds(open.map((o) => o.id));
          }
          if (cfg.maker.disableSell) continue; // hold residual to resolution
          const invUsd = leg.account.shares * mid;
          if (Math.abs(invUsd) > cfg.maker.flattenIfNetAboveUsd && !leg.flattened) {
            // `mid` may have come from lastMids while the CURRENT book is empty
            // on the side we'd cross. Skip the flatten this tick if so — we'll
            // retry next tick when the book recovers. SAFER than market-crossing
            // with no real reference price.
            const book = books.get(leg.tokenId);
            const side: 'BUY' | 'SELL' = leg.account.shares > 0 ? 'SELL' : 'BUY';
            const touchSide = side === 'BUY' ? book?.asks : book?.bids;
            if (!touchSide || touchSide.length === 0) {
              logEvent({
                kind: 'flatten_skip', token: leg.tokenId, leg: leg.label, side, invUsd,
                reason: 'no_touch_side',
              });
              continue;
            }
            const shares = Math.abs(leg.account.shares);
            const refPrice = touchSide[0].price;
            logEvent({
              kind: 'flatten', token: leg.tokenId, leg: leg.label, side, shares, refPrice, invUsd,
            });
            logger.warn({ leg: leg.label, side, shares, refPrice, invUsd }, 'flattening residual inventory');
            // Mark as flattened BEFORE the call so that if the FOK is rejected
            // (no liquidity near window close) we do NOT retry every tick for
            // 30 seconds — a tight loop that previously fired 54 times on a
            // single token and spammed the venue with failing taker orders.
            // One attempt is enough: if the FOK fills we're flat; if it's
            // rejected, the position settles at resolution price (often better
            // than the 0.76-0.84 bids available in the final seconds anyway).
            leg.flattened = true;
            if (enabled) await marketFlatten(leg.tokenId, side, shares, refPrice);
          }
        }
        continue;
      }

      // 5. QUOTE PHASE — per-leg compute desired, reconcile, place. Deployed
      //    capital is summed ACROSS BOTH LEGS so the global cap is respected.
      //
      // If the venue circuit breaker tripped (transient 425/429/5xx storm),
      // skip the entire quote phase for this tick. We don't cancel resting
      // orders either — if the venue is broken, cancels will also fail and
      // the bot would just hammer it. The next tick will re-check.
      if (isThrottled()) {
        logEvent({ kind: 'throttled_skip', remainingMs: throttleRemainingMs() });
        continue;
      }
      // Manual pause from Telegram /pause — skip the entire quote phase. The
      // flatten phase before close still runs so we don't carry residuals.
      if (state.paused) continue;
      const openByToken: Record<string, LiveOrder[]> = {};
      let deployedTotal = 0;
      for (const leg of legs) {
        const open = await listOpenOrders(leg.tokenId);
        openByToken[leg.tokenId] = open;
        const mid = legMids[leg.tokenId];
        deployedTotal += openBuyNotional(open) + Math.abs(leg.account.shares) * mid;
      }

      // Quotes/places per leg. The per-place cap check tracks deployedSoFar
      // across both legs (guardrail #3).
      let deployedSoFar = deployedTotal;
      const btcReturn30s = priceFeed.getReturn(ASSET, 30);

      for (const leg of legs) {
        const book = books.get(leg.tokenId);
        if (!book || book.bids.length === 0 || book.asks.length === 0) continue;
        const bestBid = book.bids[0].price;
        const bestAsk = book.asks[0].price;
        if (!(bestBid > 0) || !(bestAsk > 0)) continue;
        const mid = legMids[leg.tokenId];
        const inventoryUsd = leg.account.shares * mid;

        // Effective inventory the BUY gate sees = realized inventory + any
        // resting BUY notional on THIS leg. Without this, the gate only sees
        // realized fills (lagged by ~15s via /activity polling) while the
        // venue may already have additional BUYs that could fill imminently.
        // Including pending BUYs prevents stacking another order on top of
        // one that hasn't filled yet — the 2026-05-26 19:49 UTC over-fill
        // scenario (31 NO shares vs $3 cap).
        const pendingBuyUsd = openBuyNotional(openByToken[leg.tokenId]);
        const effectiveLongUsd = inventoryUsd + pendingBuyUsd;

        const gates = checkGates({
          realizedPnlTodayUsd: dayPnl,
          deployedUsd: deployedTotal,
          inventoryUsd: effectiveLongUsd,
          maxDeployedUsd: cfg.live.maxDeployedUsd,
          dailyLossHaltUsd: cfg.live.dailyLossHaltUsd,
          maxInventoryUsd: cfg.maker.maxInventoryUsd,
        });

        const decision = computeQuotes(
          {
            bestBid,
            bestAsk,
            inventoryShares: leg.account.shares,
            inventoryUsd,
            btcReturn30s,
            timeToResolveSec,
          },
          cfg.maker,
        );

        // Hedge cap: don't add to the over-represented leg. `sharesDiff > 0`
        // means THIS leg has more inventory than the other. Once that exceeds
        // `maxUnmatchedShares`, BUY is suppressed on this leg until the other
        // catches up — forces matched-pair accumulation. Bounds worst-case
        // single-window directional exposure to ~maxUnmatchedShares * $1.
        // Hedge + spend caps (pure helpers in legPolicy). hedge cap forces
        // matched-pair accumulation; spend cap bounds per-leg per-window outlay.
        const otherLeg = legs.find((l) => l.tokenId !== leg.tokenId);
        const sharesDiff = leg.account.shares - (otherLeg?.account.shares ?? 0);
        const hedgeBlock = computeHedgeBlock(
          leg.account.shares,
          otherLeg?.account.shares ?? 0,
          cfg.maker.maxUnmatchedShares,
        );
        const spendBlock = computeSpendBlock(leg.buyNotionalCommitted, cfg.maker.maxSpendPerLegUsd);

        // Desired resting orders for this leg — all suppression rules (cross
        // filter, naked-SELL guard, hedge/spend caps, disable_sell, and
        // balance-error suppression) live in the pure, unit-tested buildDesired.
        const desired = buildDesired({
          decision,
          halted: gates.halted,
          allowBuy: gates.allowBuy,
          allowSell: gates.allowSell,
          bestBid,
          bestAsk,
          legShares: leg.account.shares,
          hedgeBlocksBuy: hedgeBlock,
          spendBlocksBuy: spendBlock,
          disableSell: cfg.maker.disableSell || isSellBalanceRejected(leg.tokenId),
        });

        if (hedgeBlock) hedgeBlockCount++;
        if (spendBlock) spendBlockCount++;
        const { toCancel, toPlace } = reconcile(
          openByToken[leg.tokenId],
          desired,
          cfg.maker.tickSize,
          cfg.maker.tickSize * cfg.maker.replaceDeadbandTicks,
        );
        logEvent({
          kind: 'reconcile',
          token: leg.tokenId,
          leg: leg.label,
          reason: decision.reason,
          gate: gates.reason,
          hedgeBlocksBuy: hedgeBlock,
          spendBlocksBuy: spendBlock,
          spent: leg.buyNotionalCommitted,
          toCancel,
          toPlace,
          deployedTotal,
          dayPnl,
          invShares: leg.account.shares,
          sharesDiff,
        });

        if (!enabled) continue;

        await cancelByIds(toCancel);

        for (const p of toPlace) {
          // Only BUY orders ADD to deployed exposure (USDC committed to a
          // potential fill). SELL orders REDUCE exposure — they liquidate
          // inventory we already hold, which is already counted in `deployed`
          // via |inventory|*mid. Treating SELLs the same way previously caused
          // valid liquidations to be skipped during volatile windows, leaving
          // stale SELL prices on the book that got picked off at fire-sale
          // (the 2026-05-26 20:08 UTC YES SELL @ 0.19 after buying at 0.26-0.41).
          const add = p.side === 'BUY' ? p.price * p.size : 0;
          if (add > 0 && deployedSoFar + add > cfg.live.maxDeployedUsd) {
            logEvent({
              kind: 'place_skipped',
              token: leg.tokenId,
              leg: leg.label,
              reason: 'max_deployed',
              side: p.side,
              price: p.price,
              size: p.size,
              deployedSoFar,
            });
            continue;
          }
          const placed = await placeLimitMaker(leg.tokenId, p.side, p.price, p.size);
          logEvent({
            kind: 'place',
            token: leg.tokenId,
            leg: leg.label,
            side: p.side,
            price: p.price,
            size: p.size,
            ok: !!placed,
            orderId: placed?.orderId ?? null,
          });
          if (placed) {
            placeOkCount++;
            deployedSoFar += add;
            // Track every BUY placement against the per-leg spend cap. Once
            // exceeded, no more BUYs on this leg this window.
            if (p.side === 'BUY') leg.buyNotionalCommitted += p.price * p.size;
          } else {
            placeFailCount++;
          }
        }
      }
    }
    // ---------------------------------------------------------- end inner loop

    if (halted) {
      marketFeed.setAssets([]);
      continue;
    }

    // FINAL SWEEP: pull fills one last time for each leg before computing
    // legPnl. /activity has up to ~20s lag, so fills that filled in the last
    // 30s of the window may not have been visible during the inner loop. With
    // sinceMs frozen at window_open-60s and the seen-set dedup, this sweep
    // is safe to call repeatedly and only adds what we missed.
    for (const leg of legs) {
      const lateTrades = await fetchOurTrades(leg.tokenId, leg.sinceMs);
      let lateCount = 0;
      for (const t of lateTrades) {
        if (leg.account.seen.has(t.id)) continue;
        leg.account = applyTrade(leg.account, t);
        lateCount++;
        logEvent({
          kind: 'fill',
          token: leg.tokenId,
          leg: leg.label,
          id: t.id,
          side: t.side,
          price: t.price,
          shares: t.shares,
          late: true,
        });
      }
      if (lateCount > 0) {
        logEvent({ kind: 'final_sweep', token: leg.tokenId, leg: leg.label, lateCount, sharesAfter: leg.account.shares });
      }
    }

    // Settle the window per leg. YES settles to 1 if yesWon, NO settles to the
    // complement; fall back to last mid if the resolution isn't decisive yet.
    const res = await fetchResolution(market.yesTokenId);
    let windowPnl = 0;
    for (const leg of legs) {
      const fallback = legMidFromBook(books.get(leg.tokenId));
      const settle: number = res ? legSettlePrice(leg.label, res.yesWon) : fallback;
      const legPnl = pnl(leg.account, settle);
      windowPnl += legPnl;
      logEvent({
        kind: 'window_leg_result',
        token: leg.tokenId,
        leg: leg.label,
        legPnl,
        shares: leg.account.shares,
        settle,
        resolved: !!res,
      });
    }
    realizedTodayUsd += windowPnl;
    realizedSessionUsd += windowPnl;
    windowsCount++;
    if (windowPnl > 0) winningWindows++;
    else if (windowPnl < 0) losingWindows++;

    logEvent({
      kind: 'window_result',
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
      windowPnl,
      realizedTodayUsd,
      realizedSessionUsd,
      resolved: !!res,
      yesWon: res ? res.yesWon : null,
    });
    logger.info({ windowPnl, realizedTodayUsd, realizedSessionUsd, resolved: !!res }, 'window result');
    state.lastWindow = {
      ts: Date.now(),
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
      windowPnl,
      yesWon: res ? res.yesWon : null,
    };
    // Push notable windows to Telegram (skip the noise of zero-PnL windows).
    if (Math.abs(windowPnl) >= 0.01) {
      void notifier.windowResult(windowPnl, realizedTodayUsd, res ? res.yesWon : null);
    }

    marketFeed.setAssets([]);

    // HARD session-loss check after every window settlement. Unlike the daily
    // halt which idles until UTC midnight, this one EXITS the process — the
    // overnight kill-switch. Operator must restart manually after reviewing.
    if (realizedSessionUsd <= -cfg.live.sessionLossHaltUsd) {
      logEvent({
        kind: 'session_halt',
        realizedSessionUsd,
        realizedTodayUsd,
        sessionLossHaltUsd: cfg.live.sessionLossHaltUsd,
      });
      logger.error(
        { realizedSessionUsd, sessionLossHaltUsd: cfg.live.sessionLossHaltUsd },
        'SESSION LOSS HALT — exiting process; restart manually after reviewing balance',
      );
      state.haltedSession = true;
      // Best-effort Telegram alert; do not block shutdown waiting for the
      // network — the send is fire-and-forget (Notifier swallows errors).
      try {
        await notifier.sessionHalt(realizedSessionUsd, cfg.live.sessionLossHaltUsd);
      } catch {
        /* ignore — shutdown is more important than the notification */
      }
      // shutdown() runs cancelAll (if enabled), closes the log, and exits.
      await shutdown('session_loss_halt', enabled, 0);
      return; // unreachable, but TS-clean
    }
  }
}

function legMidFromBook(book: BookSnapshot | undefined): number {
  if (!book || book.bids.length === 0 || book.asks.length === 0) return 0.5;
  return (book.bids[0].price + book.asks[0].price) / 2;
}

main().catch(async (err: any) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal error in main');
  logEvent({ kind: 'fatal', err: err.message });
  let enabled = false;
  try {
    enabled = loadBotYaml().live.enabled === true;
  } catch {
    /* ignore */
  }
  await shutdown('fatal', enabled, 1);
});
