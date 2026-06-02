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
   *   5. all configured assets run concurrently, each one window at a time.
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
import { decideHarvest } from './engine/harvester.js';
import { decideMomentum } from './engine/momentum.js';
import { decideMartingale } from './engine/martingale.js';
import { checkGates } from './live/riskGate.js';
import { reconcile, type DesiredQuote, type LiveOrder } from './live/reconciler.js';
import {
  emptyAccount,
  applyTrade,
  pnl,
  reconcileAccount,
  driftPersistedMs,
  newDriftWatch,
  type Account,
  type DriftWatch,
} from './live/accounting.js';
import {
  buildDesired,
  spendBlocksBuy as computeSpendBlock,
  legSettlePrice,
} from './live/legPolicy.js';
import { fetchOnchainShares } from './clob/reconcileInventory.js';
import { getAccountValue } from './clob/positions.js';
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
import { fetchOurTrades, fetchAllOurTrades } from './clob/trades.js';
import { logEvent, closeLog } from './persistence/eventLog.js';
import { createBot } from './telegram/bot.js';
import { registerCommands } from './telegram/commands.js';
import { Notifier } from './telegram/notifier.js';
import { emptyState, type BotState } from './telegram/state.js';
import { type Asset } from './util/assets.js';

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
  /** Snapshot of `account.shares` at the moment the LAST flatten was attempted.
   *  If late fills change shares after the attempt, the flatten phase re-arms
   *  to catch the new inventory. Bounded by `flattenAttempts` so a stream of
   *  late fills can't spam the venue with rejected FOKs. */
  sharesAtFlatten: number;
  /** Cumulative flatten attempts on this leg this window. Cap prevents the
   *  pre-2026-05-27 incident where a tight retry loop fired 54 FOKs on a single
   *  token after liquidity dried up. */
  flattenAttempts: number;
  /** Cumulative BUY notional FILLED on this leg in the current window. Updated
   *  from /activity polls. Combined with the resting BUY notional (queried via
   *  listOpenOrders each tick) this is the effective per-leg exposure that the
   *  spend cap protects. Replaces the previous "count every placement" approach,
   *  which inflated the cap by every cancel+replace cycle (median 9.8s to hit
   *  cap → 73% of ticks at-cap idle in the 2026-05-27 logs). */
  buyNotionalFilled: number;
  /** Per-window fill tallies for CASH ATTRIBUTION (emitted in window_leg_result).
   *  Lets post-hoc analysis decompose PnL into spread captured (round-trips) vs
   *  hold-to-resolution vs the held tail — from real fills, not the mark. */
  buyShares: number;
  sellShares: number;
  sellNotional: number;
  /** Debounce state for reconcile corrections: how long the current drift has
   *  persisted. Prevents snapping (and then double-counting) a drift that is just
   *  a lagging /activity fill. See `driftPersistedMs`. */
  driftWatch: DriftWatch;
  /** Most recent ON-CHAIN share count from the reconcile poll (NaN until the
   *  first poll). The hedge cap uses this instead of the /activity-tracked count
   *  so fill lag (~20-60s) can't hide real inventory and let the leg over-buy —
   *  the mechanism behind the 2026-05-29 21.7-share naked-NO position. */
  lastOnchainShares: number;
  /** Epoch ms of the last opportunistic taker pair-completion on THIS leg. A
   *  short cooldown stops a second completion firing before the just-bought
   *  shares surface (via the 2s reconcile) and close the unmatched excess. */
  lastPairCompleteMs: number;
}

/** Maximum flatten attempts per leg per window. See `flattenAttempts` above. */
const MAX_FLATTEN_ATTEMPTS = 2;

/** Cooldown after a taker pair-completion so the just-bought shares can surface
 *  via the 2s reconcile before we evaluate completing again (avoids double-buys
 *  while the fill is in flight). */
const PAIR_COMPLETE_COOLDOWN_MS = 6000;

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
        enabled: cfg.live.enabled,
        assets: cfg.live.assets,
        dailyLossHaltUsd: cfg.live.dailyLossHaltUsd,
        sessionLossHaltUsd: cfg.live.sessionLossHaltUsd,
        maxDeployedUsd: cfg.live.maxDeployedUsd,
        quoteSizeUsd: cfg.maker.quoteSizeUsd,
        maxBuyPrice: cfg.maker.maxBuyPrice,
        flattenBeforeSec: cfg.maker.flattenBeforeSec,
        cashFloorUsd: cfg.live.cashFloorUsd,
      },
      requestShutdown: (reason) => void shutdown(reason, enabled, 0),
      requestReset: () => {
        // Reset all halt flags and counters as if the bot just launched.
        halted = false;
        haltUntilMs = 0;
        consecLosses = 0;
        realizedTodayUsd = 0;
        realizedSessionUsd = 0;
        windowsCount = 0;
        winningWindows = 0;
        losingWindows = 0;
        placeOkCount = 0;
        placeFailCount = 0;
        netWorthHaltTriggered = false;
        cashFloorWarned = false;
        lastHourlyBalanceMs = 0;
        // Mirror into shared state so /status reflects the reset immediately.
        state.paused = false;
        state.haltedDaily = false;
        state.haltUntilMs = 0;
        state.haltedSession = false;
        state.realizedTodayUsd = 0;
        state.realizedSessionUsd = 0;
        state.windowsCount = 0;
        state.winningWindows = 0;
        state.losingWindows = 0;
        state.placeOkCount = 0;
        state.placeFailCount = 0;
        state.startedAtMs = Date.now();
        logEvent({ kind: 'telegram_reset' });
        logger.info('bot reset via /resume — counters and halts cleared');
      },
    });
    logger.info('telegram bot online');
    void notifier.start(balance, cfg.live.sessionLossHaltUsd, cfg.live.dailyLossHaltUsd);
  }

  // Warm up the Binance price feed for ALL configured assets BEFORE quoting.
  // `getReturn(asset, 30)` needs ~24s of buffered ticks per asset. The momentum
  // strategy reads getReturn(asset, momentumLookbackSec) (~300s), so size the
  // rolling buffer to cover that lookback plus headroom.
  const priceFeed = new PriceFeed(Math.max(70_000, (cfg.maker.momentumLookbackSec + 60) * 1000));
  priceFeed.start(cfg.live.assets);
  const ready = await priceFeed.waitUntilReady(cfg.live.assets, 40_000);
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
  // Deferred PnL bucket (2B): windows that closed without a definitive Gamma
  // resolution. Their shares stay on-chain and will eventually settle to 0/$1,
  // but we don't know which until Gamma confirms. Marking them at 0.5 fallback
  // inflates the realized counters (67% of reported 2026-05-27 PnL came from
  // this fallback) AND can fire the daily/session halts on imaginary losses.
  // Tracked separately for visibility; NOT used by any halt or PnL display
  // unless/until a future reconciler converts them to realized.
  let unresolvedDeferredUsd = 0;
  let halted = false;
  let haltUntilMs = 0;
  // Latest liquid USDC reading, refreshed by the on-chain reconcile cycle.
  // Drives the cash-floor breaker (guardrail: stop BUYs before cash hits zero).
  // NaN until the first successful read — the gate is skipped while unknown.
  let lastCashUsd = Number.isFinite(balance) ? balance : NaN;
  // One-shot flag so the cash-floor breaker warns once per crossing, not every tick.
  let cashFloorWarned = false;

  // Per-asset deployed capital tracker. Each asset loop updates its entry after
  // querying listOpenOrders; the global sum enforces maxDeployedUsd across all
  // concurrently running asset loops.
  const assetDeployedUsd = new Map<string, number>();

  // Rolling counters for the periodic `summary` event. Reset only on process
  // restart — useful for overnight monitoring without grepping the full log.
  const sessionStartMs = Date.now();
  let lastSummaryMs = sessionStartMs;
  let placeOkCount = 0;
  let placeFailCount = 0;
  let hedgeBlockCount = 0;
  let spendBlockCount = 0;
  // Fix-validation counters (2026-05-29): how often each new guard actually bit.
  let driftDebouncedCount = 0; // reconcile corrections held back by the debounce
  let driftAppliedCount = 0;   // reconcile corrections actually applied (genuine misses)
  let avgZeroSnapCount = 0;    // missed-BUY drifts skipped because avgPrice was 0 (Fix 1)
  let clipClampedCount = 0;    // BUY clips shrunk by the unmatched-room clamp
  let unhedgeableBlockCount = 0; // opening BUYs suppressed because the pair can't be completed
  let pairCompleteCount = 0;   // opportunistic taker pair-completions that locked profit
  // Favorite Harvester shadow P&L: the hypothetical settle-based result of every
  // harvest entry, net of the taker fee. In DRY-RUN (no real fills) this is the
  // only meaningful P&L track; in live it cross-checks the real realized number.
  let harvestShadowUsd = 0;
  let harvestEntries = 0;
  let harvestWins = 0;
  let windowsCount = 0;
  let winningWindows = 0;
  let losingWindows = 0;
  let consecLosses = 0; // consecutive losing windows (reset to 0 on any win or break-even)
  const SUMMARY_INTERVAL_MS = 5 * 60_000;
  // Net-worth reality check — the PRIMARY real-money drawdown guard (the tracker-
  // based halts are blind to deferred/unconfirmed-resolution losses, 2026-06-01).
  // Runs every 30s so the wallet-based net_worth_halt reacts promptly and overshoots
  // by at most ~one entry; the Telegram PUSH stays throttled to the summary interval.
  const NET_WORTH_CHECK_MS = 30_000;
  const HOURLY_BALANCE_MS = 60 * 60_000;
  let lastNetWorthMs = 0;
  let lastHourlyBalanceMs = 0;
  let netWorthHaltTriggered = false;

  // Unified session-stop event. Every halt path also writes one of these with a
  // consistent {reason, pnl, context} shape so post-hoc analysis (and a restart)
  // has a single greppable record of WHY the bot stopped — the per-kind events
  // (take_profit_halt, halt, session_halt, …) stay for backward compatibility.
  const logSessionStop = (
    reason: 'take_profit' | 'max_windows' | 'max_consec_losses' | 'daily_loss' | 'session_loss',
    extra: Record<string, unknown> = {},
  ): void =>
    logEvent({
      kind: 'session_stop',
      reason,
      realizedSessionUsd,
      realizedTodayUsd,
      unresolvedDeferredUsd,
      windowsCount,
      consecLosses,
      harvestShadowUsd,
      harvestEntries,
      harvestWins,
      ...extra,
    });

  // Per-asset market loop. Each configured asset runs its own instance
  // concurrently; they share PnL counters, halt state, and the deployed-capital
  // cap via closure over the shared variables above.
  const runAsset = async (ASSET: Asset): Promise<void> => {
    // Effective maker config for THIS asset: apply any per-asset half_spread
    // override (a 6¢-book value sits behind a 3¢ book's touch → adverse). Only
    // half_spread varies by asset; everything else is shared.
    const assetHalfSpread = cfg.maker.halfSpreadByAsset?.[ASSET];
    const makerCfg =
      assetHalfSpread != null ? { ...cfg.maker, halfSpread: assetHalfSpread } : cfg.maker;
    // Per-asset isolation: each loop owns its book state and market feed so
    // that one asset's window cycle (setAssets / setAssets([])) never disrupts
    // the other asset's live subscription.
    const books: Map<string, BookSnapshot> = new Map();
    const lastMids: Map<string, number> = new Map();
    // Set by each inner-loop iteration so the WebSocket onBook callback can
    // resolve the Promise.race and wake the loop immediately on a book change,
    // instead of waiting for the full pollIntervalMs sleep.
    let signalBookUpdate: (() => void) | null = null;
    const marketFeed = new ClobMarketFeed({
      onBook: (snap) => {
        books.set(snap.assetId, snap);
        if (snap.bids.length > 0 && snap.asks.length > 0) {
          const mid = (snap.bids[0].price + snap.asks[0].price) / 2;
          if (mid > 0) lastMids.set(snap.assetId, mid);
        }
        if (signalBookUpdate) { signalBookUpdate(); signalBookUpdate = null; }
      },
    });
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
      { tokenId: market.yesTokenId, label: 'YES', account: emptyAccount(), sinceMs: windowSinceMs, flattened: false, sharesAtFlatten: 0, flattenAttempts: 0, buyNotionalFilled: 0, buyShares: 0, sellShares: 0, sellNotional: 0, driftWatch: newDriftWatch(), lastOnchainShares: NaN, lastPairCompleteMs: 0 },
      { tokenId: market.noTokenId, label: 'NO', account: emptyAccount(), sinceMs: windowSinceMs, flattened: false, sharesAtFlatten: 0, flattenAttempts: 0, buyNotionalFilled: 0, buyShares: 0, sellShares: 0, sellNotional: 0, driftWatch: newDriftWatch(), lastOnchainShares: NaN, lastPairCompleteMs: 0 },
    ];
    // Clear any SELL suppression from the previous window so both legs start clean.
    for (const leg of legs) clearSellBalanceRejected(leg.tokenId);

    // Favorite Harvester per-window state: at most ONE taker entry per window,
    // then hold to resolution. `harvestIntent` records what we bought so the
    // window-close can compute the settle-based (shadow) P&L.
    let harvested = false;
    // Set to true once the intra-window take-profit sell has fired. Prevents
    // re-entry and stops further martingale levels from adding to a sold position.
    let momentumExited = false;
    let harvestIntent:
      | { tokenId: string; leg: 'YES' | 'NO'; ask: number; shares: number; mid: number; ttrSec: number; ts: number; mode: 'favorite' | 'momentum'; priorReturn?: number }
      | null = null;

    // Martingale per-window state: tracks which averaging levels have fired and
    // total USDC deployed (initial + levels) so the spend cap is enforced.
    const martingaleState = {
      levelsExecuted: cfg.maker.martingaleLevels.map(() => false),
      spentUsd: 0,
    };

    // Price-snap logging: throttle to one log every 30s while a position is open.
    // Captures bid/ask/spread trajectory for post-session research (stop-loss
    // calibration, ask velocity, TP timing). No operational effect — read-only.
    let lastPriceSnapMs = 0;
    const PRICE_SNAP_INTERVAL_MS = 30_000;

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

    // Snapshot the on-chain wallet at window open so the window-result
    // notification can cross-check the mark-based windowPnl against reality.
    // Best-effort: if this call fails, the notification just omits the wallet
    // delta and we still get the mark-only message.
    let windowOpenNetWorthUsd: number | null = null;
    try {
      const snap = await getAccountValue();
      windowOpenNetWorthUsd = snap.netWorthUsd;
      // Exact wallet snapshot AT window open (the periodic reality_check runs on
      // its own ~90s cadence and won't line up with the boundary). Paired with the
      // window_close snap it gives an exact per-window walletDelta post-hoc.
      logEvent({
        kind: 'wallet_snap',
        phase: 'window_open',
        yesToken: market.yesTokenId,
        noToken: market.noTokenId,
        cashUsd: snap.cashUsd,
        positionValueUsd: snap.positionValueUsd,
        redeemableUsd: snap.redeemableUsd,
        netWorthUsd: snap.netWorthUsd,
        openCount: snap.openCount,
        redeemableCount: snap.redeemableCount,
      });
    } catch {
      // non-fatal — wallet cross-check will be skipped for this window
    }

    // Reset per-window book + last-mid state and subscribe to BOTH outcome tokens.
    for (const leg of legs) {
      books.delete(leg.tokenId);
      lastMids.delete(leg.tokenId);
    }
    marketFeed.setAssets(legs.map((l) => l.tokenId));

    // Throttle the REST fill poll independently of the main tick rate.
    // At 300 ms ticks the /activity endpoint would get 200+ calls/min —
    // 2 s is enough to track fills without hitting rate limits.
    let lastFillPollMs = 0;

    // ------------------------------------------------------------ inner loop
    while (Date.now() <= resolvesAtMs + 60_000) {
      if (shuttingDown) return;
      // Wake up as soon as the book changes (via signalBookUpdate set in onBook),
      // or after pollIntervalMs at the latest. This makes entry and martingale
      // checks react to price moves immediately rather than on a fixed cadence.
      await Promise.race([
        sleep(cfg.live.pollIntervalMs),
        new Promise<void>((r) => { signalBookUpdate = r; }),
      ]);

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
          driftDebouncedCount,
          driftAppliedCount,
          avgZeroSnapCount,
          clipClampedCount,
          unhedgeableBlockCount,
          pairCompleteCount,
          harvestShadowUsd,
          harvestEntries,
          harvestWins,
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

      // NET-WORTH REALITY CHECK + HARD DRAWDOWN HALT. Runs faster than the
      // summary so the on-chain drawdown guard reacts quickly. This is the only
      // halt anchored to the WALLET (cash + held token value), independent of
      // the internal mark tracker — it fires even if the share accounting
      // over-counts. Best-effort and serialized via `netWorthHaltTriggered` so a
      // single trip can't double-fire while the await is in flight.
      if (!netWorthHaltTriggered && Date.now() - lastNetWorthMs >= NET_WORTH_CHECK_MS) {
        lastNetWorthMs = Date.now();
        try {
          const av = await getAccountValue();
          const netDelta = Number.isFinite(state.startBalanceUsd)
            ? av.netWorthUsd - state.startBalanceUsd
            : NaN;
          logEvent({
            kind: 'reality_check',
            cashUsd: av.cashUsd,
            positionValueUsd: av.positionValueUsd,
            redeemableUsd: av.redeemableUsd,
            redeemableCount: av.redeemableCount,
            openCount: av.openCount,
            netWorthUsd: av.netWorthUsd,
            netDeltaUsd: netDelta,
            markSessionUsd: realizedSessionUsd,
            markGapUsd: Number.isFinite(netDelta) ? realizedSessionUsd - netDelta : null,
          });
          // Hourly balance push to Telegram.
          if (Date.now() - lastHourlyBalanceMs >= HOURLY_BALANCE_MS) {
            lastHourlyBalanceMs = Date.now();
            void notifier.hourlyBalance(av.cashUsd);
          }
          // HARD HALT on real net-worth drawdown. Reads the wallet, not the
          // internal counters — the backstop that would have caught the
          // overnight bleed regardless of mark inflation.
          if (
            cfg.live.netWorthHaltUsd > 0 &&
            Number.isFinite(netDelta) &&
            netDelta <= -cfg.live.netWorthHaltUsd
          ) {
            netWorthHaltTriggered = true;
            state.haltedSession = true;
            logEvent({
              kind: 'net_worth_halt',
              netWorthUsd: av.netWorthUsd,
              netDeltaUsd: netDelta,
              threshold: cfg.live.netWorthHaltUsd,
              cashUsd: av.cashUsd,
              markSessionUsd: realizedSessionUsd,
            });
            logger.error(
              { netDelta, threshold: cfg.live.netWorthHaltUsd, cashUsd: av.cashUsd },
              'NET-WORTH DRAWDOWN HALT — real on-chain drawdown exceeded; exiting',
            );
            await notifier.netWorthHalt(netDelta, cfg.live.netWorthHaltUsd, av.netWorthUsd);
            await shutdown('net_worth_halt', enabled, 1);
            return;
          }
        } catch (err: any) {
          logger.warn({ err: err?.message }, 'net-worth reality check failed');
        }
      }

      // 1. Pull fills for ALL legs in ONE HTTP round-trip (throttled to 2 s).
      //    The loop now wakes on every book update, so without throttling the
      //    /activity REST endpoint would get 5-20 calls/s during an active book.
      //    2 s is fast enough to track fills; the on-chain reconcile (every 5 s)
      //    is the backstop that catches anything this poll misses.
      if (Date.now() - lastFillPollMs >= 2000) {
        lastFillPollMs = Date.now();
        const sinceMs = Math.min(...legs.map((l) => l.sinceMs));
        const allTrades = await fetchAllOurTrades(legs.map((l) => l.tokenId), sinceMs);
        for (const leg of legs) {
          const trades = allTrades.get(leg.tokenId) ?? [];
          for (const t of trades) {
            if (leg.account.seen.has(t.id)) continue;
            leg.account = applyTrade(leg.account, t);
            // Track filled BUY notional against the per-leg spend cap (filled-only
            // semantics — cancel+replace cycles no longer eat budget).
            if (t.side === 'BUY') {
              leg.buyNotionalFilled += t.price * t.shares;
              leg.buyShares += t.shares;
            } else {
              leg.sellShares += t.shares;
              leg.sellNotional += t.price * t.shares;
            }
            logEvent({
              kind: 'fill',
              token: leg.tokenId,
              leg: leg.label,
              id: t.id,
              side: t.side,
              price: t.price,
              shares: t.shares,
              // Real fill time (from the trade), vs the event `ts` which is the
              // poll time. latencyMs = how late /activity surfaced this fill —
              // the input to tuning reconcile_min_persist_ms.
              fillTs: t.tsMs,
              latencyMs: Date.now() - t.tsMs,
            });
          }
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
              // Record the on-chain truth for the hedge cap regardless of whether
              // we snap the account — the cap must see real inventory even while
              // a correction is debounced.
              leg.lastOnchainShares = oc.shares;
              const before = leg.account.shares;
              const r = reconcileAccount(leg.account, oc.shares, oc.avgPrice);
              // DEBOUNCE: only act on a drift that has persisted longer than the
              // worst-case /activity fill lag. A freshly-appeared drift is almost
              // always a lagging fill; snapping now AND applying that fill when it
              // lands double-counts the shares (2026-05-29 NO leg: 43.3 tracked vs
              // 21.7 on-chain → inflated -$7.25 PnL + false halt).
              const persistedMs = driftPersistedMs(leg.driftWatch, r.drift, Date.now());
              const debounced = persistedMs < cfg.live.reconcileMinPersistMs;
              const willCorrect = r.corrected && !debounced && cfg.live.reconcileCorrect;
              // Diagnostic reason: collapse the reconcileAccount outcome and the
              // orchestrator gates (debounce, log-only mode) into one field so the
              // two "corrected:false" cases (tolerance vs. suppression) are
              // distinguishable without re-deriving them from the raw numbers.
              const reconcileReason =
                r.reason !== 'snap'
                  ? r.reason
                  : debounced
                    ? 'debounced'
                    : !cfg.live.reconcileCorrect
                      ? 'logged_only'
                      : 'applied';
              if (r.reason === 'snap' && debounced) driftDebouncedCount++;
              if (r.reason === 'avgprice_zero') avgZeroSnapCount++;
              if (willCorrect) driftAppliedCount++;
              logEvent({
                kind: 'reconcile_check',
                token: leg.tokenId,
                leg: leg.label,
                tracked: before,
                onchain: oc.shares,
                avgPrice: oc.avgPrice,
                drift: r.drift,
                persistedMs,
                reason: reconcileReason,
                debounced: r.reason === 'snap' && debounced,
                corrected: willCorrect,
              });
              if (willCorrect) {
                leg.account = r.account;
                logger.warn(
                  { leg: leg.label, before, onchain: oc.shares, avgPrice: oc.avgPrice, drift: r.drift, persistedMs },
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
        // Refresh liquid cash on the same cadence so the cash-floor breaker
        // acts on near-current data. Best-effort: a failed read leaves the
        // previous value (and the gate is skipped while NaN at startup).
        try {
          lastCashUsd = await getUsdcBalance();
        } catch (err: any) {
          logger.warn({ err: err?.message }, 'cash refresh failed in reconcile cycle');
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
        logSessionStop('daily_loss', { dailyLossHaltUsd: cfg.live.dailyLossHaltUsd, dayPnl });
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

      // 3a. MOMENTUM-TREND (2026-05-31). Just after the window opens, read the
      //     underlying's prior-Ns return and bet WITH the trend (up→YES, down→NO),
      //     taker, hold to resolution. 5-min windows autocorrelate and the fresh
      //     book hasn't priced the continuation yet → early entry is +EV. Bypasses
      //     the maker phases like the harvester; shares its intent + shadow plumbing.
      if (cfg.maker.momentumTrend) {
        const inWarmup = cfg.maker.momentumWarmupWindows > 0 && windowsCount < cfg.maker.momentumWarmupWindows;
        if (!harvested && !inWarmup && !halted && !isThrottled() && !state.paused) {
          const yesBook = books.get(legs.find((l) => l.label === 'YES')!.tokenId);
          const noBook = books.get(legs.find((l) => l.label === 'NO')!.tokenId);
          const decision = decideMomentum({
            ttrSec: timeToResolveSec,
            enterSec: cfg.maker.momentumEnterSec,
            exitSec: cfg.maker.momentumExitSec,
            priorReturn: priceFeed.getReturn(ASSET, cfg.maker.momentumLookbackSec),
            threshold: cfg.maker.momentumThreshold,
            strongThreshold: cfg.maker.momentumStrongThreshold,
            strongMult: cfg.maker.momentumStrongMult,
            longOnly: cfg.maker.momentumLongOnly,
            contrarian: cfg.maker.momentumContrarian,
            maxAsk: cfg.maker.momentumMaxAsk,
            clipShares: cfg.maker.momentumClipShares,
            minClipShares: cfg.maker.minQuoteShares,
            yes: { bestBid: yesBook?.bids[0]?.price ?? null, bestAsk: yesBook?.asks[0]?.price ?? null, askSize: yesBook?.asks[0]?.size ?? null },
            no: { bestBid: noBook?.bids[0]?.price ?? null, bestAsk: noBook?.asks[0]?.price ?? null, askSize: noBook?.asks[0]?.size ?? null },
          });
          if (decision.action === 'enter' && decision.side && decision.ask != null && decision.shares != null) {
            const sideLeg = legs.find((l) => l.label === decision.side)!;
            const sideBook = decision.side === 'YES' ? yesBook : noBook;
            const sideMid = sideBook && sideBook.bids[0] && sideBook.asks[0] ? (sideBook.bids[0].price + sideBook.asks[0].price) / 2 : decision.ask;
            // When martingale is enabled, use USDC-based sizing for the initial entry
            // instead of the shares-based clip.  shares = martingaleInitialUsdc / ask,
            // floored to the venue minimum.
            let entryShares = decision.shares;
            if (cfg.maker.martingaleEnabled && cfg.maker.martingaleInitialUsdc > 0) {
              const rawShares = cfg.maker.martingaleInitialUsdc / decision.ask;
              entryShares = Math.max(
                cfg.maker.minQuoteShares,
                Math.floor(rawShares * 100) / 100,
              );
              martingaleState.spentUsd = cfg.maker.martingaleInitialUsdc;
            }
            harvested = true;
            harvestIntent = {
              tokenId: sideLeg.tokenId,
              leg: decision.side,
              ask: decision.ask,
              shares: entryShares,
              mid: sideMid,
              ttrSec: timeToResolveSec,
              ts: Date.now(),
              mode: 'momentum',
              priorReturn: decision.priorReturn,
            };
            logEvent({
              kind: 'momentum_entry',
              token: sideLeg.tokenId,
              leg: decision.side,
              ask: decision.ask,
              shares: entryShares,
              usdcNotional: Number((entryShares * decision.ask).toFixed(2)),
              priorReturn: decision.priorReturn,
              reason: decision.reason,
              contrarian: cfg.maker.momentumContrarian,
              ttrSec: Math.round(timeToResolveSec),
              martingale: cfg.maker.martingaleEnabled,
              dryRun: !enabled,
            });
            logger.info(
              { side: decision.side, ask: decision.ask, shares: entryShares, priorReturnPct: decision.priorReturn != null ? Number((decision.priorReturn * 100).toFixed(3)) : null, ttr: Math.round(timeToResolveSec) },
              'MOMENTUM-TREND — taker buy with the trend (hold to resolution)',
            );
            if (enabled) await marketFlatten(sideLeg.tokenId, 'BUY', entryShares, decision.ask);
          }
        }

        // ── MARTINGALE AVERAGING LEVELS ────────────────────────────────────────
        // After initial entry: each tick check if the ask has dropped far enough
        // below the entry price to trigger the next averaging level. Only one
        // level fires per tick; subsequent levels fire on future ticks.
        if (cfg.maker.martingaleEnabled && harvested && harvestIntent && !momentumExited && !halted && !isThrottled() && !state.paused) {
          const sideLeg = legs.find((l) => l.label === harvestIntent!.leg)!;
          const sideBook = books.get(sideLeg.tokenId);
          const currentAsk = sideBook?.asks[0]?.price ?? null;
          if (currentAsk != null) {
            const avgDecision = decideMartingale({
              entryPrice: harvestIntent.ask,
              levelsExecuted: martingaleState.levelsExecuted,
              levels: cfg.maker.martingaleLevels,
              currentAsk,
              maxAsk: cfg.maker.momentumMaxAsk,
              minAsk: cfg.maker.martingaleMinAsk,
              minShares: cfg.maker.minQuoteShares,
              spentUsdThisWindow: martingaleState.spentUsd,
              maxSpendUsd: cfg.maker.martingaleMaxSpendUsd,
              ttrSec: timeToResolveSec,
              minTtrSec: cfg.maker.martingaleMinTtrSec,
            });
            if (avgDecision.fire) {
              const { levelIdx, shares, price, triggerDrop } = avgDecision;
              martingaleState.levelsExecuted[levelIdx] = true;
              martingaleState.spentUsd += cfg.maker.martingaleLevels[levelIdx].addUsdc;
              // Also add to harvestIntent shares so the window-close shadow PnL
              // calculation accounts for the full accumulated position.
              harvestIntent = { ...harvestIntent, shares: harvestIntent.shares + shares };
              logEvent({
                kind: 'martingale_avg',
                token: sideLeg.tokenId,
                leg: harvestIntent.leg,
                levelIdx,
                entryPrice: harvestIntent.ask,
                currentAsk: price,
                triggerDrop: Number(triggerDrop.toFixed(4)),
                shares,
                addUsdc: cfg.maker.martingaleLevels[levelIdx].addUsdc,
                totalSpentUsd: martingaleState.spentUsd,
                dryRun: !enabled,
              });
              logger.info(
                { leg: harvestIntent.leg, levelIdx, entryPrice: harvestIntent.ask, currentAsk: price, drop: Number(triggerDrop.toFixed(3)), shares, totalSpent: Number(martingaleState.spentUsd.toFixed(2)) },
                'MARTINGALE — averaging down, adding shares',
              );
              if (enabled) await marketFlatten(sideLeg.tokenId, 'BUY', shares, price);
            }
          }
        }

        // ── INTRA-WINDOW TAKE-PROFIT ───────────────────────────────────────────
        // If the entry token's bid has risen above the take-profit threshold,
        // sell to crystallize the gain instead of riding to resolution.
        // Only fires once (momentumExited gate); also blocks further martingale
        // levels from adding to a position we've already decided to exit.
        if (
          cfg.maker.momentumTakeProfitBid > 0 &&
          harvested && harvestIntent && !momentumExited &&
          !halted && !isThrottled() && !state.paused
        ) {
          const tpLeg = legs.find((l) => l.tokenId === harvestIntent!.tokenId)!;
          const tpBook = books.get(tpLeg.tokenId);
          const tpBid = tpBook?.bids[0]?.price ?? 0;
          // Use confirmed fill count; if fills haven't landed yet, wait for next tick.
          const sharesHeld = tpLeg.account.shares;
          if (tpBid >= cfg.maker.momentumTakeProfitBid && sharesHeld >= cfg.maker.minQuoteShares) {
            momentumExited = true;
            const gainPerShare = tpBid - harvestIntent.ask;
            logEvent({
              kind: 'momentum_take_profit',
              token: tpLeg.tokenId,
              leg: harvestIntent.leg,
              entryAsk: harvestIntent.ask,
              exitBid: tpBid,
              shares: sharesHeld,
              gainPerShare: Number(gainPerShare.toFixed(4)),
              ttrSec: Math.round(timeToResolveSec),
              dryRun: !enabled,
            });
            logger.info(
              { leg: harvestIntent.leg, entryAsk: harvestIntent.ask, exitBid: tpBid, shares: sharesHeld, gainPerShare: Number(gainPerShare.toFixed(3)), ttr: Math.round(timeToResolveSec) },
              'TAKE-PROFIT — selling into strength to crystallize gain',
            );
            if (enabled) await marketFlatten(tpLeg.tokenId, 'SELL', sharesHeld, tpBid);
          }
        }

        // ── INTRA-WINDOW PRICE SNAP (research logging) ────────────────────────
        // While a position is open, periodically snapshot bid/ask/spread so
        // post-session scripts can research stop-loss thresholds, ask velocity,
        // and TP timing without needing live data. Throttled to once per 30s.
        if (harvested && harvestIntent && !momentumExited) {
          const now = Date.now();
          if (now - lastPriceSnapMs >= PRICE_SNAP_INTERVAL_MS) {
            lastPriceSnapMs = now;
            const snapLeg = legs.find((l) => l.tokenId === harvestIntent!.tokenId);
            const snapBook = snapLeg ? books.get(snapLeg.tokenId) : undefined;
            const snapBid = snapBook?.bids[0]?.price ?? null;
            const snapAsk = snapBook?.asks[0]?.price ?? null;
            if (snapBid != null && snapAsk != null) {
              logEvent({
                kind: 'price_snap',
                token: harvestIntent.tokenId,
                leg: harvestIntent.leg,
                entryAsk: harvestIntent.ask,
                bid: snapBid,
                ask: snapAsk,
                spread: Number((snapAsk - snapBid).toFixed(4)),
                bidVsEntry: Number((snapBid - harvestIntent.ask).toFixed(4)),
                ttrSec: Math.round(timeToResolveSec),
                spentUsd: Number(martingaleState.spentUsd.toFixed(2)),
                dryRun: !enabled,
              });
            }
          }
        }

        continue; // momentum holds to resolution — skip the maker flatten + quote phases
      }

      // 3b. FAVORITE HARVESTER (2026-05-30 strategy redesign). When enabled this
      //     REPLACES the matched-pair maker entirely: late in the window, cross
      //     the spread to BUY the book's favorite (one clip) and HOLD to
      //     resolution — never quote both sides, never sell. The earlier phases
      //     (fills, reconcile, marks, daily-loss halt) still ran above; we skip
      //     the maker flatten + quote phases below.
      if (cfg.maker.favoriteHarvester) {
        if (!harvested && !halted && !isThrottled() && !state.paused) {
          const decision = decideHarvest({
            ttrSec: timeToResolveSec,
            enterSec: cfg.maker.harvestEnterSec,
            exitSec: cfg.maker.harvestExitSec,
            minMid: cfg.maker.harvestMinMid,
            maxAsk: cfg.maker.harvestMaxAsk,
            clipShares: cfg.maker.harvestClipShares,
            minClipShares: cfg.maker.minQuoteShares,
            legs: legs.map((l) => {
              const b = books.get(l.tokenId);
              return {
                label: l.label,
                bestBid: b?.bids[0]?.price ?? null,
                bestAsk: b?.asks[0]?.price ?? null,
                askSize: b?.asks[0]?.size ?? null,
              };
            }),
          });
          if (decision.action === 'enter' && decision.leg && decision.ask != null && decision.shares != null) {
            const favLeg = legs.find((l) => l.label === decision.leg)!;
            harvested = true;
            harvestIntent = {
              tokenId: favLeg.tokenId,
              leg: decision.leg,
              ask: decision.ask,
              shares: decision.shares,
              mid: decision.mid ?? 0,
              ttrSec: timeToResolveSec,
              ts: Date.now(),
              mode: 'favorite',
            };
            logEvent({
              kind: 'harvest_entry',
              token: favLeg.tokenId,
              leg: decision.leg,
              ask: decision.ask,
              shares: decision.shares,
              mid: decision.mid,
              ttrSec: Math.round(timeToResolveSec),
              dryRun: !enabled,
            });
            logger.info(
              { leg: decision.leg, ask: decision.ask, shares: decision.shares, mid: decision.mid, ttr: Math.round(timeToResolveSec) },
              'FAVORITE HARVEST — taker buy (hold to resolution)',
            );
            // TAKER buy crossing to the ask. In dry-run (enabled=false) we log the
            // intent only; the window-close shadow P&L still scores it.
            if (enabled) await marketFlatten(favLeg.tokenId, 'BUY', decision.shares, decision.ask);
          }
        }
        continue; // harvester holds to resolution — skip the maker flatten + quote phases
      }

      // 4. FLATTEN PHASE — applies to BOTH legs. We always cancel resting
      //    orders at the boundary (otherwise we'd get lifted on the converging
      //    touch). Whether to ALSO market-flatten residual inventory depends
      //    on the strategy mode: classic mode flattens; BUY-only / hold-to-
      //    resolution mode (disable_sell) lets the residual ride to settlement.
      if (timeToResolveSec <= cfg.maker.flattenBeforeSec) {
        // Fetch open orders for ALL legs in parallel before iterating.
        const flattenOpenOrders = await Promise.all(legs.map((l) => listOpenOrders(l.tokenId)));
        for (let li = 0; li < legs.length; li++) {
          const leg = legs[li];
          const mid = legMids[leg.tokenId];
          if (!(mid > 0)) continue;
          const open = flattenOpenOrders[li];
          if (open.length > 0) {
            logEvent({ kind: 'flatten_cancel', token: leg.tokenId, leg: leg.label, ids: open.map((o) => o.id) });
            if (enabled) await cancelByIds(open.map((o) => o.id));
          }
          if (cfg.maker.disableSell) continue; // hold residual to resolution
          // RE-ARM (2C): if late fills changed `account.shares` after the prior
          // flatten attempt, allow another attempt — but only up to
          // MAX_FLATTEN_ATTEMPTS so a trickle of late fills cannot spam the
          // venue with rejected FOKs (the historical 54-FOK incident).
          if (
            leg.flattened &&
            leg.account.shares !== leg.sharesAtFlatten &&
            leg.flattenAttempts < MAX_FLATTEN_ATTEMPTS
          ) {
            logEvent({
              kind: 'flatten_rearm',
              token: leg.tokenId,
              leg: leg.label,
              prevShares: leg.sharesAtFlatten,
              newShares: leg.account.shares,
              attempts: leg.flattenAttempts,
            });
            leg.flattened = false;
          }
          // DELTA-NEUTRAL CLOSE (2026-05-28): flatten ONLY the unmatched excess
          // over the matched pair, never the matched core. The matched portion
          // (min of the two legs) redeems for a guaranteed $1 — market-selling
          // it as a taker would break the hedge AND pay a fee to exit something
          // worth $1. Only the naked excess (this leg minus its partner) carries
          // directional risk worth capping at the boundary.
          const otherFlattenLeg = legs.find((l) => l.tokenId !== leg.tokenId);
          const otherFlattenShares = otherFlattenLeg?.account.shares ?? 0;
          const unmatchedShares = Math.max(0, leg.account.shares - otherFlattenShares);
          const invUsd = unmatchedShares * mid;
          if (invUsd > cfg.maker.flattenIfNetAboveUsd && !leg.flattened) {
            // `mid` may have come from lastMids while the CURRENT book is empty
            // on the side we'd cross. Skip the flatten this tick if so — we'll
            // retry next tick when the book recovers. SAFER than market-crossing
            // with no real reference price.
            const book = books.get(leg.tokenId);
            const side: 'BUY' | 'SELL' = 'SELL'; // long-only: excess is always sold
            const touchSide = book?.bids;
            if (!touchSide || touchSide.length === 0) {
              logEvent({
                kind: 'flatten_skip', token: leg.tokenId, leg: leg.label, side, invUsd,
                reason: 'no_touch_side',
              });
              continue;
            }
            const shares = unmatchedShares;
            const refPrice = touchSide[0].price;
            logEvent({
              kind: 'flatten', token: leg.tokenId, leg: leg.label, side, shares, refPrice, invUsd,
              attempt: leg.flattenAttempts + 1,
            });
            logger.warn({ leg: leg.label, side, shares, refPrice, invUsd, attempt: leg.flattenAttempts + 1 }, 'flattening unmatched excess inventory');
            // Mark as flattened BEFORE the call. If the FOK is rejected we do
            // NOT retry next tick (the 54-FOK incident) — the re-arm above is
            // the only path to a retry, gated by share-count change AND
            // MAX_FLATTEN_ATTEMPTS so the failure mode stays bounded.
            leg.flattened = true;
            leg.sharesAtFlatten = leg.account.shares;
            leg.flattenAttempts++;
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
      let thisAssetDeployed = 0;
      // Fetch open orders for BOTH legs in parallel — two independent CLOB
      // REST calls with no ordering dependency.
      {
        const openResults = await Promise.all(legs.map((l) => listOpenOrders(l.tokenId)));
        for (let li = 0; li < legs.length; li++) {
          const leg = legs[li];
          const open = openResults[li];
          openByToken[leg.tokenId] = open;
          const mid = legMids[leg.tokenId];
          thisAssetDeployed += openBuyNotional(open) + Math.abs(leg.account.shares) * mid;
        }
      }
      // Register this asset's contribution and derive the global deployed total
      // across all concurrent asset loops (cross-asset cap enforcement).
      assetDeployedUsd.set(ASSET, thisAssetDeployed);
      const deployedTotal = Array.from(assetDeployedUsd.values()).reduce((s, v) => s + v, 0);

      // Quotes/places per leg. The per-place cap check tracks deployedSoFar
      // across both legs and all assets (guardrail #3).
      let deployedSoFar = deployedTotal;
      const priceReturn30s = priceFeed.getReturn(ASSET, 30);

      for (const leg of legs) {
        const book = books.get(leg.tokenId);
        if (!book || book.bids.length === 0 || book.asks.length === 0) continue;
        const bestBid = book.bids[0].price;
        const bestAsk = book.asks[0].price;
        if (!(bestBid > 0) || !(bestAsk > 0)) continue;
        const mid = legMids[leg.tokenId];
        // ON-CHAIN-AWARE inventory (2026-05-30): /activity fills lag the chain by
        // 4-30s (measured), so leg.account.shares understates real holdings during
        // a fill burst — and the inventory cap, computed from it, fails to bite.
        // That let a leg run to 20 shares vs the ~$cap. Use the most recent on-chain
        // count when it is higher; the cap then bounds REAL per-leg dollar exposure.
        const legSharesEff = Number.isFinite(leg.lastOnchainShares)
          ? Math.max(leg.account.shares, leg.lastOnchainShares)
          : leg.account.shares;
        const inventoryUsd = legSharesEff * mid; // notional, for the quoter's skew

        // COST-BASED cap (2026-05-30): the cap must bound the MAX LOSS, which is the
        // cost paid for the held shares, NOT their current value. A falling underdog
        // bought at 0.30 and now at 0.22 has notional 0.22×N but cost 0.30×N and
        // loses the full cost if it settles to 0. Capping on notional let a leg run
        // to 15 sh / $5.5 cost while notional read < $3 (the falling-knife hole).
        // avgBuyPrice is the leg's entry cost (a stable ratio even while absolute
        // fill counts lag); × on-chain-aware shares = real cost at risk.
        const avgBuyPrice = leg.buyShares > 0 ? leg.buyNotionalFilled / leg.buyShares : mid;
        const heldCostUsd = legSharesEff * avgBuyPrice;

        // Effective exposure the BUY gate sees = held cost + resting BUY cost. The
        // resting notional is the cost those orders add if they fill, so the sum is
        // the worst-case loss if everything fills and settles to 0 — exactly what
        // maxInventoryUsd should bound. Including resting prevents stacking a new
        // order on top of one that hasn't filled (the 2026-05-26 over-fill).
        const pendingBuyUsd = openBuyNotional(openByToken[leg.tokenId]);
        const effectiveLongUsd = heldCostUsd + pendingBuyUsd;

        const gates = checkGates({
          realizedPnlTodayUsd: dayPnl,
          deployedUsd: deployedTotal,
          inventoryUsd: effectiveLongUsd,
          maxDeployedUsd: cfg.live.maxDeployedUsd,
          dailyLossHaltUsd: cfg.live.dailyLossHaltUsd,
          maxInventoryUsd: cfg.maker.maxInventoryUsd,
          cashUsd: lastCashUsd,
          cashFloorUsd: cfg.live.cashFloorUsd,
        });

        // Cash-floor breaker: warn once per crossing (reset when cash recovers)
        // so the operator knows BUYs are suppressed without per-tick spam.
        if (gates.reason === 'cash_floor') {
          if (!cashFloorWarned) {
            cashFloorWarned = true;
            logEvent({ kind: 'cash_floor', cashUsd: lastCashUsd, floorUsd: cfg.live.cashFloorUsd });
            logger.warn({ cashUsd: lastCashUsd, floorUsd: cfg.live.cashFloorUsd }, 'cash floor hit — BUYs suppressed, SELL/flatten only');
            void notifier.cashFloor(lastCashUsd, cfg.live.cashFloorUsd);
          }
        } else if (cashFloorWarned && lastCashUsd >= cfg.live.cashFloorUsd) {
          cashFloorWarned = false;
        }

        // Cross-leg context. Needed by both the quoter (3A hedge-BUY exception)
        // and the hedge cap (forces matched-pair accumulation).
        const otherLeg = legs.find((l) => l.tokenId !== leg.tokenId);
        const otherLegShares = otherLeg?.account.shares ?? 0;
        const sharesDiff = leg.account.shares - otherLegShares;

        // Volume-weighted average cost of the OTHER leg's current holdings.
        // Used by the quoter's dynamic hedge-BUY ceiling to guarantee that
        // every completed matched pair settles above its combined cost:
        //   hedgeCeiling = 1 - otherLegAvgCost - minPairProfitPerShare
        // This prevents the fixed-ceiling bug where pair cost could exceed $1
        // (locked-in loss) when the market moved after the first leg filled.
        const otherLegAvgCost =
          otherLeg && otherLeg.account.shares > 0.5
            ? -otherLeg.account.cashUsd / otherLeg.account.shares
            : undefined;

        const decision = computeQuotes(
          {
            bestBid,
            bestAsk,
            inventoryShares: leg.account.shares,
            inventoryUsd,
            btcReturn30s: priceReturn30s,
            timeToResolveSec,
            // Top-of-book depth for the min-depth gate (don't quote into a thin book).
            bidDepthShares: book.bids[0]?.size,
            askDepthShares: book.asks[0]?.size,
            // 3A: lets the quoter relax maxBuyPrice when the other leg is heavier
            // (each share we BUY here hedges one share of the other leg's
            // directional exposure, so per-share R/R no longer matters for the
            // matched portion).
            otherLegShares,
            // Even-money guarantee: the quoter uses this to cap the hedge-BUY
            // price so the completed pair always has positive locked profit.
            otherLegAvgCost,
          },
          makerCfg,
        );

        // Hedge cap: don't add to the over-represented leg. Once `legShares -
        // otherLegShares >= maxUnmatchedShares`, BUY is suppressed on this leg
        // until the other catches up — forces matched-pair accumulation, bounds
        // worst-case single-window directional exposure to ~maxUnmatchedShares × $1.
        //
        // ON-CHAIN-AWARE (2026-05-29): /activity fills lag ~20-60s, so the tracked
        // count understates real inventory exactly when the cap most needs to bind
        // (that run placed large NO clips while tracked NO still read ~0, ending
        // with 21.7 naked NO). `legSharesEff` (computed above) is the max of tracked
        // and the latest on-chain count for THIS leg; use the LOWER count for the
        // OTHER leg so the hedge room is the conservative (smallest) estimate.
        const otherSharesEff =
          otherLeg && Number.isFinite(otherLeg.lastOnchainShares)
            ? Math.min(otherLegShares, otherLeg.lastOnchainShares)
            : otherLegShares;
        const buyUnmatchedRoomShares = cfg.maker.maxUnmatchedShares - (legSharesEff - otherSharesEff);
        const hedgeBlock = buyUnmatchedRoomShares <= 0;

        // ── OPPORTUNISTIC TAKER PAIR-COMPLETION (Option 2, 2026-05-30) ───────────
        // When the OTHER leg holds an unmatched excess and THIS leg's ASK is cheap
        // enough that buying it (taker) still locks >= min_pair_profit AFTER taker
        // fees, cross the spread to complete the pair. That excess + these shares
        // become a matched pair redeeming to $1 → guaranteed locked profit. It is
        // the only reliable way to complete a pair when passive fills are one-sided
        // (the adverse-selection leak). Fires only when profitable, so it is a pure
        // upside floor — most ticks it does nothing. Uses conservative eff counts
        // (min for the other leg, max for this) so it never over-buys.
        if (
          cfg.maker.takerComplete &&
          !gates.halted &&
          otherLeg &&
          otherLegAvgCost != null &&
          lastCashUsd > cfg.live.cashFloorUsd &&
          Date.now() - leg.lastPairCompleteMs > PAIR_COMPLETE_COOLDOWN_MS
        ) {
          const excessOnOther = otherSharesEff - legSharesEff; // unmatched shares the other leg holds
          const askSize = book.asks[0]?.size ?? 0;
          const feePerShare = cfg.maker.takerFeeRate * bestAsk * (1 - bestAsk);
          const lockedProfit = 1 - otherLegAvgCost - bestAsk - feePerShare;
          const completeShares = Math.min(excessOnOther, askSize);
          if (
            excessOnOther >= cfg.maker.minQuoteShares &&
            completeShares >= cfg.maker.minQuoteShares &&
            lockedProfit >= (cfg.maker.minPairProfitPerShare ?? 0.02)
          ) {
            leg.lastPairCompleteMs = Date.now();
            const ok = await marketFlatten(leg.tokenId, 'BUY', completeShares, bestAsk);
            if (ok) pairCompleteCount++;
            logEvent({
              kind: 'pair_complete',
              token: leg.tokenId,
              leg: leg.label,
              excessShares: excessOnOther,
              completeShares,
              askPrice: bestAsk,
              otherLegAvgCost,
              feePerShare,
              lockedProfit,
              ok,
            });
            logger.info({ leg: leg.label, completeShares, askPrice: bestAsk, lockedProfit, ok }, 'taker pair-completion');
          }
        }

        // UN-HEDGEABLE OPENING GUARD (2026-05-30). The bot only buys the cheap side
        // (<= max_buy_price). In a directional move one leg is the cheap UNDERDOG and
        // the other the expensive FAVORITE; we can't buy the favorite to complete the
        // pair, so any add to the underdog is NAKED directional risk that historically
        // lost (3 straight negative sessions). Suppress a BUY that ADDS to the heavy/
        // equal side when the OTHER leg's touch is above max_buy_price (it's the
        // favorite → pair not completable). Hedge-completion buys (this leg BEHIND the
        // other) are exempt — they reduce existing risk. Result: the bot only OPENS
        // when both legs are buyable (near 50/50, where pairs actually complete).
        const otherLegBook = otherLeg ? books.get(otherLeg.tokenId) : undefined;
        const otherLegBestBid = otherLegBook?.bids[0]?.price ?? 0;
        const thisLegHeavyOrEqual = legSharesEff >= otherSharesEff - 0.5;
        const openingUnhedgeable = thisLegHeavyOrEqual && otherLegBestBid > cfg.maker.maxBuyPrice;
        // Spend cap is based on EFFECTIVE EXPOSURE: filled BUYs (from /activity
        // polls) + resting BUY notional (queried this tick). Cancel+replace
        // cycles no longer count against the cap because cancelled orders are
        // not in the resting set and never filled. This is the 2A fix.
        const restingBuyUsd = openBuyNotional(openByToken[leg.tokenId]);
        const buyExposureUsd = leg.buyNotionalFilled + restingBuyUsd;
        const spendBlock = computeSpendBlock(buyExposureUsd, cfg.maker.maxSpendPerLegUsd);

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
          otherLegShares,
          hedgeBlocksBuy: hedgeBlock,
          spendBlocksBuy: spendBlock,
          disableSell: cfg.maker.disableSell || isSellBalanceRejected(leg.tokenId),
          buyUnmatchedRoomShares,
          minClipShares: cfg.maker.minQuoteShares,
          openingUnhedgeable,
        });

        if (hedgeBlock) hedgeBlockCount++;
        if (spendBlock) spendBlockCount++;
        if (openingUnhedgeable && decision.action === 'quote' && decision.bid) unhedgeableBlockCount++;
        // Count when the unmatched-room clamp actually shrunk a BUY clip (Fix B
        // biting) — the quoter wanted a bigger size than the hedge room allowed.
        const buyDesired = desired.find((d) => d.side === 'BUY');
        if (decision.action === 'quote' && decision.bid && buyDesired && buyDesired.size < decision.bid.sizeShares - 1e-9) {
          clipClampedCount++;
        }
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
          spent: buyExposureUsd,
          filled: leg.buyNotionalFilled,
          resting: restingBuyUsd,
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
            // NOTE: per-leg spend cap is now tracked in the fill loop
            // (`leg.buyNotionalFilled`) combined with this tick's resting BUY
            // notional. Counting placements here is what caused the 73%
            // at-cap idle pathology — see the 2A note above.
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
    // legPnl. One batch call covers all legs in a single round-trip.
    {
      const sinceMs = Math.min(...legs.map((l) => l.sinceMs));
      const lateBatch = await fetchAllOurTrades(legs.map((l) => l.tokenId), sinceMs);
      for (const leg of legs) {
        const lateTrades = lateBatch.get(leg.tokenId) ?? [];
      let lateCount = 0;
      for (const t of lateTrades) {
        if (leg.account.seen.has(t.id)) continue;
        leg.account = applyTrade(leg.account, t);
        if (t.side === 'BUY') {
          leg.buyNotionalFilled += t.price * t.shares;
          leg.buyShares += t.shares;
        } else {
          leg.sellShares += t.shares;
          leg.sellNotional += t.price * t.shares;
        }
        lateCount++;
        logEvent({
          kind: 'fill',
          token: leg.tokenId,
          leg: leg.label,
          id: t.id,
          side: t.side,
          price: t.price,
          shares: t.shares,
          fillTs: t.tsMs,
          latencyMs: Date.now() - t.tsMs,
          late: true,
        });
      }
      if (lateCount > 0) {
        logEvent({ kind: 'final_sweep', token: leg.tokenId, leg: leg.label, lateCount, sharesAfter: leg.account.shares });
      }
      }
    }

    // Settle the window per leg. YES settles to 1 if yesWon, NO settles to the
    // complement; fall back to last mid if the resolution isn't decisive yet.
    //
    // Gamma sometimes lags 10-30s after market close. The inner loop already
    // runs 60s past resolvesAt, so we arrived here 60s+ after close. Give the
    // API up to 15 more seconds (5 polls × 3s) before accepting the mid fallback.
    // Without this retry, ~50% of windows showed "unresolved" and were marked at
    // the book mid (or 0.5 for an empty book) — producing inflated / deflated PnL
    // that fed permanently into realizedTodayUsd.
    let res: Awaited<ReturnType<typeof fetchResolution>> = null;
    {
      // 15 retries × 3 s = 45 s extra; combined with the 60 s inner-loop tail
      // we wait up to ~105 s after close before accepting the fallback.
      // Threshold 0.80 (down from 0.90) catches markets where Gamma settles
      // to e.g. [0.83, 0.17] before fully converging to [0.995, 0.005].
      const RESOLVE_RETRIES = 15;
      const RESOLVE_POLL_MS = 3_000;
      // Require two CONSECUTIVE decisive reads with the same yesWon direction
      // before accepting the resolution. This guards against the common case
      // where Gamma's outcomePrices transiently shows the wrong side winning
      // (e.g. [0.18, 0.82]) in the first second after close, only to correct
      // to [0, 1] one poll later. A single unconfirmed decisive read caused the
      // "+$4.35 (mark) | NO (Down)" false-win notification.
      let prevRes: Awaited<ReturnType<typeof fetchResolution>> = null;
      for (let attempt = 0; attempt <= RESOLVE_RETRIES; attempt++) {
        const r = await fetchResolution(market.yesTokenId, 0.80);
        if (r) {
          if (prevRes !== null && r.yesWon === prevRes.yesWon) {
            // Confirmed: same direction twice in a row → trust it.
            res = r;
            break;
          }
          // First decisive read (or direction flip) — store but keep polling.
          prevRes = r;
        } else {
          prevRes = null; // reset confirmation if market becomes indecisive again
        }
        if (attempt < RESOLVE_RETRIES) {
          logger.debug(
            { attempt: attempt + 1, prevYesWon: prevRes?.yesWon, yesTokenId: market.yesTokenId.slice(0, 10) },
            'fetchResolution not confirmed yet — retrying',
          );
          await sleep(RESOLVE_POLL_MS);
        }
      }
      // If we ran out of retries without two matching reads, use the last
      // single decisive result (if any) rather than falling back to 0.5.
      if (!res && prevRes) {
        logger.warn(
          { yesWon: prevRes.yesWon, yesTokenId: market.yesTokenId.slice(0, 10) },
          'fetchResolution not confirmed after retries — using unconfirmed result',
        );
        res = prevRes;
      }
      if (!res) {
        logger.warn({ yesTokenId: market.yesTokenId.slice(0, 10) }, 'fetchResolution still unresolved after retries — using 0.5 fallback');
      }
    }
    let windowPnl = 0;
    for (const leg of legs) {
      // When Gamma resolution is unavailable, fall back to 0.5 (neutral) rather
      // than the stale book mid. The book can show an arbitrary price at close
      // (e.g. 0.75) that produces a large false gain/loss in realizedTodayUsd.
      const settle: number = res ? legSettlePrice(leg.label, res.yesWon) : 0.5;
      const legPnl = pnl(leg.account, settle);
      windowPnl += legPnl;
      // CASH ATTRIBUTION (real fills, not the mark). From these the 8h analysis
      // can decompose each leg's PnL: spread captured on the round-tripped
      // min(buy,sell) shares, plus the held tail (heldShares × settle − its cost).
      // avgBuy vs avgSell reveals whether the SELL side actually captures spread
      // or fire-sells; heldShares × settle shows the directional tail.
      const avgBuy = leg.buyShares > 0 ? leg.buyNotionalFilled / leg.buyShares : 0;
      const avgSell = leg.sellShares > 0 ? leg.sellNotional / leg.sellShares : 0;
      logEvent({
        kind: 'window_leg_result',
        token: leg.tokenId,
        leg: leg.label,
        legPnl,
        shares: leg.account.shares,
        settle,
        resolved: !!res,
        // attribution
        buyShares: leg.buyShares,
        buyUsd: leg.buyNotionalFilled,
        avgBuy,
        sellShares: leg.sellShares,
        sellUsd: leg.sellNotional,
        avgSell,
        cashUsd: leg.account.cashUsd,
      });
    }
    // 2B: only RESOLVED windows feed the realized counters and the halts. An
    // unresolved windowPnl is a 0.5-fallback estimate — the positions are still
    // on-chain and will settle to 0/$1 later. Booking them as realized PnL
    // contaminated 67% of the reported 2026-05-27 number and could fire halts
    // on imaginary losses. We track unresolved separately for visibility only.
    if (res) {
      realizedTodayUsd += windowPnl;
      realizedSessionUsd += windowPnl;
      windowsCount++;
      if (windowPnl > 0) { winningWindows++; consecLosses = 0; }
      else if (windowPnl < 0) { losingWindows++; consecLosses++; }
      else { consecLosses = 0; } // break-even resets the streak
    } else {
      unresolvedDeferredUsd += windowPnl;
      logEvent({
        kind: 'window_deferred',
        yesToken: market.yesTokenId,
        noToken: market.noTokenId,
        windowPnl,
        unresolvedDeferredUsd,
      });
    }

    // SHADOW RESULT for the active taker strategy (harvester OR momentum). Score
    // the entry on the actual settle: hypoPnl = (won ? 1 : 0 - ask - takerFee) *
    // shares. In dry-run this is the ONLY P&L track; in live it cross-checks the
    // real number. Gated on `harvestIntent` (set by EITHER strategy) — the earlier
    // `&& favoriteHarvester` bug meant momentum entries logged no result (2026-05-31).
    if (harvestIntent) {
      const hi = harvestIntent;
      const wonSide = res ? (hi.leg === 'YES' ? res.yesWon : !res.yesWon) : null;
      const fee = cfg.maker.takerFeeRate * hi.ask * (1 - hi.ask);
      const hypoPnl = wonSide == null ? null : ((wonSide ? 1 : 0) - hi.ask - fee) * hi.shares;
      if (hypoPnl != null) {
        harvestShadowUsd += hypoPnl;
        harvestEntries++;
        if (wonSide) harvestWins++;
      }
      logEvent({
        kind: 'harvest_result',
        mode: hi.mode,
        token: hi.tokenId,
        leg: hi.leg,
        ask: hi.ask,
        shares: hi.shares,
        mid: hi.mid,
        priorReturn: hi.priorReturn ?? null,
        entryTtrSec: Math.round(hi.ttrSec),
        yesWon: res ? res.yesWon : null,
        wonSide,
        hypoPnl,
        harvestShadowUsd,
        harvestEntries,
        harvestWins,
        dryRun: !enabled,
      });
      logger.info(
        { leg: hi.leg, ask: hi.ask, wonSide, hypoPnl: hypoPnl != null ? Number(hypoPnl.toFixed(3)) : null, harvestShadowUsd: Number(harvestShadowUsd.toFixed(2)) },
        'harvest result (shadow P&L)',
      );
    }

    // Wallet cross-check AT window close (best-effort), captured BEFORE the
    // window_result event so the exact mark/wallet gap lands in the JSONL without
    // depending on Telegram. A wrong resolution (Gamma showing the wrong winner
    // transiently) or an accounting double-count shows up here as a gap between
    // the mark-based windowPnl and the real walletWindowDelta.
    let walletWindowDelta: number | null = null;
    let closingCashUsd: number | null = null;
    try {
      const snapClose = await getAccountValue();
      closingCashUsd = snapClose.cashUsd;
      logEvent({
        kind: 'wallet_snap',
        phase: 'window_close',
        yesToken: market.yesTokenId,
        noToken: market.noTokenId,
        cashUsd: snapClose.cashUsd,
        positionValueUsd: snapClose.positionValueUsd,
        redeemableUsd: snapClose.redeemableUsd,
        netWorthUsd: snapClose.netWorthUsd,
        openCount: snapClose.openCount,
        redeemableCount: snapClose.redeemableCount,
      });
      if (windowOpenNetWorthUsd !== null) {
        walletWindowDelta = snapClose.netWorthUsd - windowOpenNetWorthUsd;
      }
    } catch {
      // non-fatal — window_result just omits the wallet delta
    }

    logEvent({
      kind: 'window_result',
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
      question: market.question,
      windowPnl,
      realizedTodayUsd,
      realizedSessionUsd,
      unresolvedDeferredUsd,
      resolved: !!res,
      yesWon: res ? res.yesWon : null,
      // Real wallet move over the window and its gap vs the mark-based windowPnl —
      // the per-window mark/wallet discrepancy, analyzable without Telegram.
      walletWindowDelta,
      markVsWalletGapUsd: walletWindowDelta != null ? windowPnl - walletWindowDelta : null,
    });
    logger.info({ windowPnl, realizedTodayUsd, realizedSessionUsd, unresolvedDeferredUsd, walletWindowDelta, resolved: !!res }, 'window result');
    state.lastWindow = {
      ts: Date.now(),
      asset: ASSET,
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
      windowPnl,
      yesWon: res ? res.yesWon : null,
    };
    // Push notable windows to Telegram (skip the noise of zero-PnL windows).
    if (Math.abs(windowPnl) >= 0.01) {
      void notifier.windowResult(windowPnl, res ? res.yesWon : null, walletWindowDelta, closingCashUsd);
    }

    marketFeed.setAssets([]);

    // ── Session stop limits (checked after every resolved window) ──────────────
    // All three use the daily-halt mechanism (idle until 00:00 UTC, auto-resume)
    // rather than the hard session-halt (exit process).
    if (res) {
      if (cfg.live.sessionTakeProfitUsd > 0 && realizedSessionUsd >= cfg.live.sessionTakeProfitUsd) {
        logEvent({ kind: 'take_profit_halt', realizedSessionUsd, threshold: cfg.live.sessionTakeProfitUsd });
        logSessionStop('take_profit', { threshold: cfg.live.sessionTakeProfitUsd });
        logger.info({ realizedSessionUsd, threshold: cfg.live.sessionTakeProfitUsd }, 'TAKE-PROFIT STOP — pausing until UTC midnight');
        void notifier.takeProfitHalt(realizedSessionUsd, cfg.live.sessionTakeProfitUsd);
        halted = true;
        haltUntilMs = nextUtcMidnightMs();
      } else if (cfg.live.sessionMaxWindows > 0 && windowsCount >= cfg.live.sessionMaxWindows) {
        logEvent({ kind: 'max_windows_halt', windowsCount, limit: cfg.live.sessionMaxWindows, realizedSessionUsd });
        logSessionStop('max_windows', { limit: cfg.live.sessionMaxWindows });
        logger.info({ windowsCount, limit: cfg.live.sessionMaxWindows }, 'MAX-WINDOWS STOP — pausing until UTC midnight');
        void notifier.maxWindowsHalt(windowsCount, realizedSessionUsd);
        halted = true;
        haltUntilMs = nextUtcMidnightMs();
      } else if (cfg.live.sessionMaxConsecLosses > 0 && consecLosses >= cfg.live.sessionMaxConsecLosses) {
        logEvent({ kind: 'consec_losses_halt', consecLosses, limit: cfg.live.sessionMaxConsecLosses, realizedSessionUsd });
        logSessionStop('max_consec_losses', { limit: cfg.live.sessionMaxConsecLosses });
        logger.warn({ consecLosses, limit: cfg.live.sessionMaxConsecLosses }, 'CONSECUTIVE-LOSSES STOP — pausing until UTC midnight');
        void notifier.maxConsecLossesHalt(consecLosses, realizedSessionUsd);
        halted = true;
        haltUntilMs = nextUtcMidnightMs();
      }
    }

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
      logSessionStop('session_loss', { sessionLossHaltUsd: cfg.live.sessionLossHaltUsd });
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
  } // end outer while — each asset loop exits only when shuttingDown or session-halted

  }; // end runAsset

  // Run all configured assets concurrently. Each loop is independent (own market
  // feed, own books) but shares PnL state, halt flags, and the global deployed-
  // capital cap via closure over the shared variables declared above.
  await Promise.all(cfg.live.assets.map((a) => runAsset(a)));
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
