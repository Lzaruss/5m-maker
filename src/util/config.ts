import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import 'dotenv/config';
import { ALL_ASSETS, isAsset, type Asset } from './assets.js';

/** One averaging-down level for the martingale entry strategy. */
export interface MartingaleLevel {
  /** Absolute price drop below the initial entry ask that triggers this level.
   *  e.g. 0.08 means: buy when currentAsk <= entryPrice - 0.08 */
  priceDrop: number;
  /** USDC to spend at this level. Shares = addUsdc / currentAsk. */
  addUsdc: number;
}

export interface AdverseGuardConfig {
  /** |btcReturn30s| at/above which we widen the spread. */
  btcReturn30sWiden: number;
  /** |btcReturn30s| at/above which we pull the vulnerable side entirely. */
  btcReturn30sPull: number;
}

export interface MakerConfig {
  halfSpread: number;
  /** Per-asset half_spread override. The rule (microstructure study + two-leg
   *  backtest 2026-05-29): half_spread must be ≈0.5× the asset's BOOK spread or
   *  the bid sits behind the touch and only fills adversely. Tape medians differ
   *  by asset (BNB/DOGE ~6¢ → 0.03; XRP ~3¢ → 0.015; SOL ~2¢ → 0.01), so a single
   *  global half_spread can't be competitive on more than one. Assets not listed
   *  fall back to `halfSpread`. Enables multi-asset breadth (variance ∝1/√N at
   *  globally-bounded capital) for the rebate farm. */
  halfSpreadByAsset?: Record<string, number>;
  quoteSizeUsd: number;
  /** Polymarket binary markets enforce a per-market `min_order_size` (typically
   *  5 shares for crypto 5m markets). At extreme prices `quoteSizeUsd / price`
   *  falls below that floor and the venue rejects the order; we clamp UP to
   *  this number of shares to keep both sides quotable. */
  minQuoteShares: number;
  inventorySkewK: number;
  widenFactor: number;
  maxInventoryUsd: number;
  tickSize: number;
  adverseGuard: AdverseGuardConfig;
  flattenBeforeSec: number;
  flattenIfNetAboveUsd: number;
  /** When true the bot ONLY posts BUY (no SELL on either leg). */
  disableSell: boolean;
  /** Refuse to quote outside [quotePriceMin, quotePriceMax]. Eliminates
   *  "lottery ticket" BUYs at extreme prices (e.g. 200 sh @ 0.01) and
   *  symmetric SELLs near 0.99 where the market is essentially resolved. */
  quotePriceMin: number;
  quotePriceMax: number;
  /** Refuse to post a BUY at a price > this. Buying the high-priced side of
   *  a binary outcome is a TERRIBLE risk/reward unless you have directional
   *  edge — a maker doesn't. At p=0.65, a winning trade gains $0.35/share
   *  while a losing trade loses $0.65/share (R/R 0.54:1, needs 65% win rate
   *  to break even). Restricting BUYs to the "underdog" side of the book
   *  (typically <0.5) keeps every entry's R/R >= 1:1. Set to 1.0 to disable. */
  maxBuyPrice: number;
  /** Maximum |sharesYES - sharesNO| before we stop posting BUY on the
   *  over-represented leg. Forces matched-pair accumulation — the matched
   *  portion settles to cost at resolution, the unmatched portion is the
   *  bounded directional bet. Worst-case window variance ≈ this * 1.0. */
  maxUnmatchedShares: number;
  /** Hard cap on cumulative BUY notional placed per leg per window. Once
   *  exceeded, no more BUYs on that leg until the next window opens. Counts
   *  placed orders regardless of fill/cancel — conservative but immune to
   *  the /activity polling lag that lets the inventory cap leak. */
  maxSpendPerLegUsd: number;
  /** Reconciler tolerance in number of ticks. A resting order is "close
   *  enough" to the desired price (no cancel/replace) if within this many
   *  ticks. Larger value = less churn = fewer cancel-fill races. */
  replaceDeadbandTicks: number;
  // ── Tier-2 entry/regime gates (2026-05-28) ───────────────────────────────
  // All suppress OPENING new directional risk in low-edge/toxic conditions but
  // never block risk-reducing actions (hedge-completion BUYs keep their price
  // exception; the unwind SELL/ask is untouched). 0 disables each gate.
  /** No-trade dead zone around 0.50: when |mid-0.5| < this, suppress the
   *  opening BUY (a coinflip window has ~0 maker edge — pair cost ≈ 1). Hedge-
   *  completion BUYs are exempt. The 50¢ zone is also where implicit fee/
   *  structure cost is highest. */
  noTradeBand50: number;
  /** Stop OPENING new positions once timeToResolve <= this (seconds). Late
   *  entries are adversely selected (price discovery near resolution; late buys
   *  won 0-17% vs ~40% baseline). Hedge-completion BUYs and unwind SELLs still
   *  allowed; > flattenBeforeSec so there's a window where we only de-risk. */
  noNewEntryBeforeSec: number;
  /** Hard volatility pause: when |assetReturn30s| >= this, emit no_quote on BOTH
   *  sides so the reconciler cancels resting orders and the bot stands aside in
   *  a violent move (can't make markets while the underlying repences). Set
   *  ABOVE adverse_guard.pull (which only pulls one side). */
  volHaltReturn30s: number;
  /** Minimum top-of-book depth (shares) required on BOTH sides to quote. Thin/
   *  one-sided books gap on a single market order and pick off resting quotes.
   *  Only enforced when the caller supplies bid/ask depth. */
  minBookDepthShares: number;
  /** Peg quotes to the touch so they actually FILL. Without this, a bid at
   *  mid-half_spread sits BEHIND the best bid whenever half_spread exceeds the
   *  book's own half-spread (the BTC 1¢-book case) → it only fills on adverse
   *  moves, and matched pairs almost never complete (live: 6% both-leg fill).
   *  When true we never quote worse than the touch: bid = max(computed, bestBid),
   *  ask = min(computed, bestAsk). Captures the book's spread, not a wider
   *  synthetic one, but actually gets hit. NOTE: more fills realize the existing
   *  (~0 on BTC) edge with MORE adverse-selection exposure — validate in the
   *  simulator before trusting it live. */
  pegToTouch: boolean;
  /** Minimum guaranteed profit (in USD) per matched YES+NO pair before the
   *  hedge-BUY ceiling allows completing the pair. Ensures every filled matched
   *  pair settles above its combined cost ("even money or better"):
   *    hedgeCeiling = 1.0 - otherLegAvgCost - minPairProfitPerShare
   *  At 0.02 the bot requires at least 2 cents of locked-in profit per pair;
   *  the matched pair must cost <= $0.98 to be accepted. Set to 0 to revert to
   *  the old fixed HEDGE_BUY_PRICE_CEILING behaviour. */
  minPairProfitPerShare: number;
  /** Opportunistic TAKER pair-completion (2026-05-30). When one leg is filled and
   *  the other leg's ASK is cheap enough that completing the pair via a taker BUY
   *  still locks >= minPairProfitPerShare AFTER taker fees, cross the spread to
   *  complete it — turning a naked excess into a guaranteed-profit matched pair.
   *  The only reliable way to complete a pair when passive fills are one-sided
   *  (the 2026-05-30 adverse-selection problem). Fires only when profitable. */
  takerComplete: boolean;
  // ── Favorite Harvester (2026-05-30 strategy redesign) ─────────────────────
  /** Enable the Favorite Harvester: a TAKER that, late in each window, crosses
   *  the spread to BUY the book's FAVORITE (mid >= harvestMinMid) and HOLDS to
   *  resolution. Validated +EV after fees on the less-efficient books (DOGE/XRP)
   *  via the favorite-longshot bias. When true the matched-pair maker quote +
   *  flatten phases are bypassed entirely (the harvester holds, never sells). */
  favoriteHarvester: boolean;
  /** Begin hunting for a favorite once timeToResolve <= this (seconds). */
  harvestEnterSec: number;
  /** Stop entering once timeToResolve < this (too little edge room near close). */
  harvestExitSec: number;
  /** A leg is the "favorite" when its mid >= this (0.60 ≈ conviction 10%). */
  harvestMinMid: number;
  /** Never pay an ask above this for the favorite (no room to $1 after fee). */
  harvestMaxAsk: number;
  /** Taker clip size (shares) for the harvest entry. */
  harvestClipShares: number;
  // ── Momentum-trend strategy (2026-05-31, validated on 2-day tape) ─────────
  /** Enable the momentum-trend taker: at ~momentumEnterSec into each window read
   *  the underlying's prior-`momentumLookbackSec` return; if it rose buy YES, if it
   *  fell buy NO (trade WITH the trend), hold to resolution. 5-min crypto windows
   *  autocorrelate (prior-300s up → window finishes UP ~64%), and the new window's
   *  book opens ~50/50 before pricing it → entering early is +EV. Validated +9-10%
   *  ROI both days, all 6 assets. Bypasses the maker quote/flatten phases like the
   *  harvester. Mutually exclusive with favoriteHarvester. */
  momentumTrend: boolean;
  /** Look for the entry once timeToResolve <= this (just after the window opens). */
  momentumEnterSec: number;
  /** Floor: stop entering once timeToResolve < this (signal stales late-window). */
  momentumExitSec: number;
  /** Lookback (seconds) for the underlying momentum signal (priceFeed.getReturn). */
  momentumLookbackSec: number;
  /** |prior return| must exceed this to take a side. 0.0010 (0.10%): the 0.05-0.10%
   *  bucket was NOISE (53% win, −EV) on both tape days; ≥0.10% won 68-77%. */
  momentumThreshold: number;
  /** |prior return| at/above which we size up (win% rises with move size). */
  momentumStrongThreshold: number;
  /** Clip multiplier when |prior return| >= momentumStrongThreshold (conviction). */
  momentumStrongMult: number;
  /** Long-only: bet YES on uptrends, SKIP downtrends (never buy NO). */
  momentumLongOnly: boolean;
  /** Contrarian: fade the trend (up→NO, down→YES) — a mean-reversion bet, the
   *  inverse of the momentum edge. Experimental. */
  momentumContrarian: boolean;
  /** Never pay an ask above this (past here the book already priced the move). */
  momentumMaxAsk: number;
  /** Intra-window take-profit: if the bid of the entry token rises above this
   *  after the momentum entry, sell immediately to crystallize the gain.
   *  0 = disabled (always hold to resolution). */
  momentumTakeProfitBid: number;
  /** Skip momentum entries for the first N resolved windows of each session.
   *  Lets the signal fill its lookback buffer and avoids cold-start losses.
   *  0 = disabled (enter from window 0). */
  momentumWarmupWindows: number;
  /** Taker clip size (shares) for the momentum entry. */
  momentumClipShares: number;
  // ── Martingale averaging-down (2026-06-01, @savvvv pattern) ──────────────
  /** Enable averaging-down on top of the momentum-trend entry. When true, after
   *  the initial momentum buy the bot watches the ask each tick; if it drops
   *  below the entry price by `martingaleLevels[i].priceDrop`, it buys another
   *  `martingaleLevels[i].addUsdc` USDC worth of the same side. Each level fires
   *  at most once per window. Total spend capped at `martingaleMaxSpendUsd`.
   *  Requires `momentumTrend: true`. Tail risk: the occasional window that goes
   *  to zero loses the full deployed amount — set `martingaleMaxSpendUsd` and
   *  the orchestrator's `cash_floor_usd` / `net_worth_halt_usd` accordingly. */
  martingaleEnabled: boolean;
  /** Initial entry size in USDC (overrides momentum_clip_shares when enabled).
   *  Shares = martingaleInitialUsdc / currentAsk at entry time. */
  martingaleInitialUsdc: number;
  /** Averaging levels. Each fires once per window when ask drops by `priceDrop`
   *  below the initial entry ask. Levels are scanned in order (first unfired level
   *  that qualifies fires); priceDrop should be ascending. */
  martingaleLevels: MartingaleLevel[];
  /** Hard cap on TOTAL USDC deployed per token per window (initial + all levels).
   *  Protects against runaway averaging. Must be >= martingaleInitialUsdc. */
  martingaleMaxSpendUsd: number;
  /** Do not fire any averaging level when timeToResolve < this (seconds).
   *  A sustained drop this close to resolution is real price discovery, not noise. */
  martingaleMinTtrSec: number;
  /** Never average below this ask price. Below this the market is pricing a
   *  near-certain loss; adding capital is throwing good money after bad. */
  martingaleMinAsk: number;
  /** Simulator only: fraction of a crossing trade's size we assume to capture
   *  (queue-position proxy). 1.0 = front-of-line on the whole print. */
  fillParticipation: number;
  /** Simulator only: crypto taker fee rate. Real Polymarket formula (confirmed
   *  from `feeSchedule`): taker fee USDC = shares * feeRate * p*(1-p). At
   *  feeRate=0.07 this is ~1.8% per share at p=0.50. Makers pay 0; this applies
   *  to flatten orders that cross the book. */
  takerFeeRate: number;
}

export interface RiskConfig {
  dailyLossLimitUsd: number;
  maxCommittedUsd: number;
}

export interface LiveConfig {
  enabled: boolean;
  assets: Asset[];
  maxDeployedUsd: number;
  /** Halt for the rest of the UTC day when realized PnL for THIS day reaches
   *  this loss. Resets at 00:00 UTC and the bot resumes automatically. */
  dailyLossHaltUsd: number;
  /** HARD session loss limit: when cumulative realized PnL since process
   *  startup reaches this loss, the bot cancels + flattens + EXITS the
   *  process. A manual restart is required. Use for overnight "set-and-
   *  forget" safety so the bot can't lose more than this across the run
   *  even if a new UTC day starts with a fresh daily-halt budget. */
  sessionLossHaltUsd: number;
  pollIntervalMs: number;
  /** Seconds between on-chain position reconciliation checks (drift detection
   *  against the venue's true holdings). 0 disables the periodic check. */
  reconcileEverySec: number;
  /** Stop opening NEW BUYs when liquid USDC falls below this floor. SELLs and
   *  flatten stay enabled so the bot can still raise cash and reduce position.
   *  Protects against the failure mode where the bot drains all cash into
   *  tokens (winning ones unredeemed, losing ones worthless) and is left unable
   *  to operate. 0 disables the gate. */
  cashFloorUsd: number;
  /** HARD halt on REAL on-chain net-worth drawdown from the start balance:
   *  (cash + market value of held tokens) - startBalance <= -this => cancel +
   *  exit. Unlike the mark-based daily/session halts (which trust the internal
   *  share tracker), this reads the wallet directly via getAccountValue, so it
   *  fires even if the internal accounting over-counts. Catastrophe backstop —
   *  set WIDER than session_loss_halt. 0 disables. */
  netWorthHaltUsd: number;
  /** When true, a detected drift snaps tracked shares to the on-chain truth
   *  (and adjusts cash at cost basis). When false, drift is only LOGGED — useful
   *  for observe-only validation before trusting the correction. */
  reconcileCorrect: boolean;
  /** A detected drift is only CORRECTED after it has persisted continuously for
   *  at least this long (ms). Shorter-lived drift is treated as a lagging
   *  /activity fill that will self-close when it lands, NOT a genuinely missed
   *  trade — this debounce prevents the snap-then-fill double-count that inflated
   *  the 2026-05-29 NO leg to 2x its real size. Should exceed the worst-case fill
   *  lag (~60 s). */
  reconcileMinPersistMs: number;
  // ── Session stop limits ─────────────────────────────────────────────────
  /** Pause for the rest of the UTC day after this many resolved windows.
   *  "Trade the morning, then rest." 0 = disabled. */
  sessionMaxWindows: number;
  /** Pause for the rest of the UTC day once cumulative session profit reaches
   *  this amount. Locks in gains before variance erases them. 0 = disabled. */
  sessionTakeProfitUsd: number;
  /** Pause for the rest of the UTC day after this many CONSECUTIVE losing
   *  windows. Signals a regime where the strategy is no longer working.
   *  0 = disabled. */
  sessionMaxConsecLosses: number;
}

export interface BotConfig {
  assets: Asset[];
  maker: MakerConfig;
  risk: RiskConfig;
  live: LiveConfig;
}

export function parseBotYaml(raw: string): BotConfig {
  const obj = (yaml.load(raw) ?? {}) as any;

  const rawAssets: string[] = Array.isArray(obj.assets) ? obj.assets.map(String) : [];
  const assets: Asset[] = (rawAssets.length ? rawAssets : ALL_ASSETS).map((a) => {
    const up = String(a).toUpperCase();
    if (!isAsset(up)) throw new Error(`Unknown asset in bot.yml: ${a}`);
    return up;
  });

  const m = obj.maker ?? {};
  // Per-asset half_spread overrides: { XRP: 0.015, SOL: 0.01 }. Keys uppercased;
  // values must be finite positive numbers (a bad entry is ignored, not fatal).
  let halfSpreadByAsset: Record<string, number> | undefined;
  if (m.half_spread_by_asset && typeof m.half_spread_by_asset === 'object') {
    halfSpreadByAsset = {};
    for (const [k, v] of Object.entries(m.half_spread_by_asset)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) halfSpreadByAsset[String(k).toUpperCase()] = n;
    }
    if (Object.keys(halfSpreadByAsset).length === 0) halfSpreadByAsset = undefined;
  }

  const maker: MakerConfig = {
    halfSpread: m.half_spread ?? 0.03,
    halfSpreadByAsset,
    quoteSizeUsd: m.quote_size_usd ?? 3.0,
    minQuoteShares: m.min_quote_shares ?? 5.0,
    inventorySkewK: m.inventory_skew_k ?? 0.5,
    widenFactor: m.widen_factor ?? 2.0,
    maxInventoryUsd: m.max_inventory_usd ?? 15.0,
    tickSize: m.tick_size ?? 0.01,
    adverseGuard: {
      btcReturn30sWiden: m.adverse_guard?.btc_return_30s_widen ?? 0.0005,
      btcReturn30sPull: m.adverse_guard?.btc_return_30s_pull ?? 0.0010,
    },
    flattenBeforeSec: m.flatten_before_sec ?? 20,
    flattenIfNetAboveUsd: m.flatten_if_net_above_usd ?? 6.0,
    disableSell: m.disable_sell === true,
    quotePriceMin: m.quote_price_min ?? 0.05,
    quotePriceMax: m.quote_price_max ?? 0.95,
    maxBuyPrice: m.max_buy_price ?? 0.50,
    maxUnmatchedShares: m.max_unmatched_shares ?? 5,
    maxSpendPerLegUsd: m.max_spend_per_leg_usd ?? 5,
    replaceDeadbandTicks: m.replace_deadband_ticks ?? 3,
    noTradeBand50: m.no_trade_band_50 ?? 0.04,
    noNewEntryBeforeSec: m.no_new_entry_before_sec ?? 90,
    volHaltReturn30s: m.vol_halt_return_30s ?? 0.0025,
    minBookDepthShares: m.min_book_depth_shares ?? 20,
    pegToTouch: m.peg_to_touch === true,
    minPairProfitPerShare: m.min_pair_profit_per_share ?? 0.02,
    takerComplete: m.taker_complete ?? false,
    favoriteHarvester: m.favorite_harvester ?? false,
    harvestEnterSec: m.harvest_enter_sec ?? 90,
    harvestExitSec: m.harvest_exit_sec ?? 30,
    harvestMinMid: m.harvest_min_mid ?? 0.60,
    harvestMaxAsk: m.harvest_max_ask ?? 0.90,
    harvestClipShares: m.harvest_clip_shares ?? 5,
    momentumTrend: m.momentum_trend ?? false,
    momentumEnterSec: m.momentum_enter_sec ?? 270,
    momentumExitSec: m.momentum_exit_sec ?? 120,
    momentumLookbackSec: m.momentum_lookback_sec ?? 300,
    momentumThreshold: m.momentum_threshold ?? 0.0010,
    momentumStrongThreshold: m.momentum_strong_threshold ?? 0.0020,
    momentumStrongMult: m.momentum_strong_mult ?? 2,
    momentumLongOnly: m.momentum_long_only ?? false,
    momentumContrarian: m.momentum_contrarian ?? false,
    momentumMaxAsk: m.momentum_max_ask ?? 0.80,
    momentumTakeProfitBid: m.momentum_take_profit_bid ?? 0,
    momentumWarmupWindows: m.momentum_warmup_windows ?? 0,
    momentumClipShares: m.momentum_clip_shares ?? 5,
    // ── Martingale averaging-down ──────────────────────────────────────────
    martingaleEnabled: m.martingale_enabled === true,
    martingaleInitialUsdc: m.martingale_initial_usdc ?? 20,
    martingaleLevels: (() => {
      if (!Array.isArray(m.martingale_levels)) return [];
      return (m.martingale_levels as any[]).flatMap((lvl: any): MartingaleLevel[] => {
        const drop = Number(lvl?.price_drop);
        const usdc = Number(lvl?.add_usdc);
        if (!Number.isFinite(drop) || drop <= 0) return [];
        if (!Number.isFinite(usdc) || usdc <= 0) return [];
        return [{ priceDrop: drop, addUsdc: usdc }];
      });
    })(),
    martingaleMaxSpendUsd: m.martingale_max_spend_usd ?? 100,
    martingaleMinTtrSec: m.martingale_min_ttr_sec ?? 60,
    martingaleMinAsk: m.martingale_min_ask ?? 0.23,
    fillParticipation: m.fill_participation ?? 1.0,
    // Accept new key `taker_fee_rate` (0.07) or fall back to the legacy
    // `taker_fee_max` if an old bot.yml is still in use.
    takerFeeRate: m.taker_fee_rate ?? m.taker_fee_max ?? 0.07,
  };

  const r = obj.risk ?? {};
  const risk: RiskConfig = {
    dailyLossLimitUsd: r.daily_loss_limit_usd ?? 10.0,
    maxCommittedUsd: r.max_committed_usd ?? 12.0,
  };

  const lv = obj.live ?? {};
  const liveAssets: Asset[] = (Array.isArray(lv.assets) && lv.assets.length ? lv.assets : ['BTC'])
    .map((a: any) => {
      const up = String(a).toUpperCase();
      if (!isAsset(up)) throw new Error(`Unknown live asset: ${a}`);
      return up;
    });
  const live: LiveConfig = {
    enabled: lv.enabled === true,
    assets: liveAssets,
    maxDeployedUsd: lv.max_deployed_usd ?? 50,
    dailyLossHaltUsd: lv.daily_loss_halt_usd ?? 20,
    // Default: 2x the daily halt so the session halt is meaningful but rarely
    // hits in normal use. Set explicitly in bot.yml for tight overnight safety.
    sessionLossHaltUsd: lv.session_loss_halt_usd ?? (lv.daily_loss_halt_usd ?? 20) * 2,
    pollIntervalMs: lv.poll_interval_ms ?? 1500,
    reconcileEverySec: lv.reconcile_every_sec ?? 30,
    reconcileCorrect: lv.reconcile_correct ?? true,
    reconcileMinPersistMs: lv.reconcile_min_persist_ms ?? 60000,
    cashFloorUsd: lv.cash_floor_usd ?? 0,
    netWorthHaltUsd: lv.net_worth_halt_usd ?? 0,
    sessionMaxWindows: lv.session_max_windows ?? 0,
    sessionTakeProfitUsd: lv.session_take_profit_usd ?? 0,
    sessionMaxConsecLosses: lv.session_max_consec_losses ?? 0,
  };
  return { assets, maker, risk, live };
}

export function loadBotYaml(path = 'bot.yml'): BotConfig {
  return parseBotYaml(readFileSync(resolve(path), 'utf8'));
}

// ---------------------------------------------------------------------------
// Environment / CLOB credentials (same wallet as btc-5m-sniper)
// ---------------------------------------------------------------------------

export interface EnvConfig {
  clobHost: string;
  clobChainId: number;
  clobPrivateKey: string;
  clobFunderAddress: string;
  clobApiKey: string;
  clobApiSecret: string;
  clobApiPassphrase: string;
  clobSignatureType: number;
  telegramBotToken: string;
  telegramChatId: string;
  logLevel: string;
  dryRun: boolean;
}

/**
 * Lenient env loader: missing required values become empty strings rather than
 * throwing. This lets DRY mode (`live.enabled=false`) run end-to-end on a
 * machine without real credentials — useful for staging, replay, or running
 * the recorder. Strict validation lives in `assertLiveEnv`, which the live
 * orchestrator calls only when `live.enabled === true`.
 */
export function loadEnv(): EnvConfig {
  const chainIdRaw = process.env.CLOB_CHAIN_ID;
  const sigTypeRaw = process.env.CLOB_SIGNATURE_TYPE;
  return {
    clobHost: process.env.CLOB_HOST ?? '',
    clobChainId: chainIdRaw ? parseInt(chainIdRaw, 10) : 137,
    clobPrivateKey: process.env.CLOB_PRIVATE_KEY ?? '',
    clobFunderAddress: process.env.CLOB_FUNDER_ADDRESS ?? '',
    clobApiKey: process.env.CLOB_API_KEY ?? '',
    clobApiSecret: process.env.CLOB_API_SECRET ?? '',
    clobApiPassphrase: process.env.CLOB_API_PASSPHRASE ?? '',
    clobSignatureType: sigTypeRaw ? parseInt(sigTypeRaw, 10) : 3,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    dryRun: (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true',
  };
}

/** Throws if any credential needed to PLACE orders is missing. Call from the
 *  live orchestrator ONLY when `live.enabled === true`. */
export function assertLiveEnv(env: EnvConfig): void {
  const missing: string[] = [];
  if (!env.clobHost) missing.push('CLOB_HOST');
  if (!env.clobPrivateKey) missing.push('CLOB_PRIVATE_KEY');
  if (!env.clobFunderAddress) missing.push('CLOB_FUNDER_ADDRESS');
  if (!env.clobApiKey) missing.push('CLOB_API_KEY');
  if (!env.clobApiSecret) missing.push('CLOB_API_SECRET');
  if (!env.clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE');
  if (missing.length) throw new Error(`Missing required env vars for live trading: ${missing.join(', ')}`);
}
