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
  inventorySkewK: number;
  widenFactor: number;
  maxInventoryUsd: number;
  tickSize: number;
  adverseGuard: AdverseGuardConfig;
  flattenBeforeSec: number;
  flattenIfNetAboveUsd: number;
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
  dailyLossHaltUsd: number;
  pollIntervalMs: number;
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
    pollIntervalMs: lv.poll_interval_ms ?? 1500,
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

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadEnv(): EnvConfig {
  return {
    clobHost: required('CLOB_HOST'),
    clobChainId: parseInt(required('CLOB_CHAIN_ID'), 10),
    clobPrivateKey: required('CLOB_PRIVATE_KEY'),
    clobFunderAddress: required('CLOB_FUNDER_ADDRESS'),
    clobApiKey: required('CLOB_API_KEY'),
    clobApiSecret: required('CLOB_API_SECRET'),
    clobApiPassphrase: required('CLOB_API_PASSPHRASE'),
    clobSignatureType: parseInt(process.env.CLOB_SIGNATURE_TYPE ?? '3', 10),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    dryRun: (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true',
  };
}
