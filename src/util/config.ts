import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import 'dotenv/config';
import { ALL_ASSETS, isAsset, type Asset } from './assets.js';

export interface AdverseGuardConfig {
  /** |btcReturn30s| at/above which we widen the spread. */
  btcReturn30sWiden: number;
  /** |btcReturn30s| at/above which we pull the vulnerable side entirely. */
  btcReturn30sPull: number;
}

export interface MakerConfig {
  halfSpread: number;
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
  /** When true, a detected drift snaps tracked shares to the on-chain truth
   *  (and adjusts cash at cost basis). When false, drift is only LOGGED — useful
   *  for observe-only validation before trusting the correction. */
  reconcileCorrect: boolean;
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
  const maker: MakerConfig = {
    halfSpread: m.half_spread ?? 0.03,
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
