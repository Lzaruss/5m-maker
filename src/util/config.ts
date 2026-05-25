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
}

export interface RiskConfig {
  dailyLossLimitUsd: number;
  maxCommittedUsd: number;
}

export interface BotConfig {
  assets: Asset[];
  maker: MakerConfig;
  risk: RiskConfig;
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
  };

  const r = obj.risk ?? {};
  const risk: RiskConfig = {
    dailyLossLimitUsd: r.daily_loss_limit_usd ?? 10.0,
    maxCommittedUsd: r.max_committed_usd ?? 12.0,
  };

  return { assets, maker, risk };
}

export function loadBotYaml(path = 'bot.yml'): BotConfig {
  return parseBotYaml(readFileSync(resolve(path), 'utf8'));
}
