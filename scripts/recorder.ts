/**
 * Phase A — Recorder.
 *
 * Records a faithful market tape for the Polymarket crypto 5-minute markets so
 * the offline simulator (scripts/simulate.ts) can backtest the maker strategy.
 *
 * For each active 5m market it captures, to data/tape-<date>.jsonl:
 *   - `market` : metadata (tokenId, asset, resolvesAt) when first seen
 *   - `book`   : top-of-book snapshot, stamped with synchronized Binance R30/price
 *   - `trade`  : every executed trade (the trade tape the fill model needs)
 *
 * No credentials required (market WS, Gamma, and Binance are all public).
 * Leave it running for hours/days, then run `npm run simulate`.
 *
 *   npm run record
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { loadBotYaml } from '../src/util/config.js';
import { logger } from '../src/util/logger.js';
import { PriceFeed } from '../src/signals/priceFeed.js';
import {
  fetchMarkets,
  fetchResolution,
  fetchClobRewards,
  type ShortMarket,
} from '../src/markets/gammaPoller.js';
import { ClobMarketFeed } from '../src/marketFeed/clobMarketFeed.js';
import type { Asset } from '../src/util/assets.js';

const WINDOW_MINUTES = 5;
const POLL_MS = 20_000;
// How many book levels per side to persist. The reward band is ~4.5c (≈5 ticks
// at 1c), so 10 levels covers it with a buffer while bounding file growth.
const BOOK_DEPTH_LEVELS = 10;
// Subscribe to markets resolving within this horizon; keeps the active set
// small and stable (avoids reconnecting the WS on every poll).
const SUBSCRIBE_HORIZON_MS = 6 * 60_000;
// Keep a resolved market in the registry this long after close so late trades
// remain attributable, then forget it.
const RETAIN_AFTER_RESOLVE_MS = 60_000;
// Wait at least this long after resolvesAt before trusting an outcome read, and
// give up trying to capture a resolution after this long.
const RESOLUTION_GRACE_MS = 5_000;
const RESOLUTION_MAX_WAIT_MS = 6 * 60_000;

interface TrackedMarket {
  market: ShortMarket;
  announced: boolean;
  resolved: boolean;
}

/** Optional run duration in ms from `--hours N` (or RECORD_HOURS env). */
function parseDurationMs(): number | null {
  const idx = process.argv.indexOf('--hours');
  const raw = idx !== -1 ? process.argv[idx + 1] : process.env.RECORD_HOURS;
  if (!raw) return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours * 3600_000;
}

async function main(): Promise<void> {
  const cfg = loadBotYaml();
  const assets = cfg.assets;
  const durationMs = parseDurationMs();
  logger.info(
    { assets, stopAfterHours: durationMs ? durationMs / 3600_000 : 'until Ctrl+C' },
    'Recorder starting',
  );

  mkdirSync(resolve('data'), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve('data', `tape-${date}.jsonl`);
  const out: WriteStream = createWriteStream(outPath, { flags: 'a' });
  logger.info({ outPath }, 'Recording to tape');

  let lines = 0;
  const write = (obj: unknown) => {
    out.write(JSON.stringify(obj) + '\n');
    lines++;
  };

  // Binance feed for synchronized BTC returns.
  const priceFeed = new PriceFeed();
  priceFeed.start(assets);

  // tokenId -> asset, for stamping BTC context on each event.
  const tokenAsset = new Map<string, Asset>();
  // tokenId -> outcome side. We record BOTH legs (YES + NO) of each market so
  // the favorite's REAL book is captured whichever side it is on — required by
  // the favorite-bias harvester (a maker/taker on the favorite needs that side's
  // touch, not a complement approximation).
  const tokenSide = new Map<string, 'YES' | 'NO'>();
  // tracked market keyed by yesTokenId, for retention bookkeeping.
  const tracked = new Map<string, TrackedMarket>();

  const feed = new ClobMarketFeed({
    onBook: (snap) => {
      const asset = tokenAsset.get(snap.assetId);
      const bestBid = snap.bids[0];
      const bestAsk = snap.asks[0];
      write({
        t: 'book',
        ts: snap.ts,
        tokenId: snap.assetId,
        side: tokenSide.get(snap.assetId) ?? null,
        // Top-of-book scalars (consumed by the current simulator).
        bid: bestBid?.price ?? null,
        bidSz: bestBid?.size ?? null,
        ask: bestAsk?.price ?? null,
        askSz: bestAsk?.size ?? null,
        // Real book depth (top N levels each side) as [price, size] pairs, so we
        // can later study competing liquidity within the reward band and queue
        // position. Capped to bound file size.
        bids: snap.bids.slice(0, BOOK_DEPTH_LEVELS).map((l) => [l.price, l.size]),
        asks: snap.asks.slice(0, BOOK_DEPTH_LEVELS).map((l) => [l.price, l.size]),
        btcR30: asset ? priceFeed.getReturn(asset, 30) : null,
        btcPx: asset ? priceFeed.getLatestPrice(asset) : null,
      });
    },
    onTrade: (trade) => {
      const asset = tokenAsset.get(trade.assetId);
      write({
        t: 'trade',
        ts: trade.ts,
        tokenId: trade.assetId,
        outcomeSide: tokenSide.get(trade.assetId) ?? null,
        price: trade.price,
        size: trade.size,
        side: trade.side,
        btcR30: asset ? priceFeed.getReturn(asset, 30) : null,
      });
    },
  });

  async function refresh(): Promise<void> {
    try {
      const markets = await fetchMarkets(assets, WINDOW_MINUTES);
      const now = Date.now();

      for (const m of markets) {
        const dt = m.resolvesAt.getTime() - now;
        if (dt <= 0 || dt > SUBSCRIBE_HORIZON_MS) continue;
        if (!tracked.has(m.yesTokenId)) {
          tracked.set(m.yesTokenId, { market: m, announced: false, resolved: false });
          tokenAsset.set(m.yesTokenId, m.asset);
          tokenAsset.set(m.noTokenId, m.asset);
          tokenSide.set(m.yesTokenId, 'YES');
          tokenSide.set(m.noTokenId, 'NO');
        }
      }

      // Capture resolution for markets past their resolve time. Reading
      // outcomePrices works even while the market still reports closed:false.
      for (const tm of tracked.values()) {
        if (tm.resolved) continue;
        const resolveTime = tm.market.resolvesAt.getTime();
        if (now < resolveTime + RESOLUTION_GRACE_MS) continue;
        const res = await fetchResolution(tm.market.yesTokenId);
        if (res) {
          tm.resolved = true;
          // Write a resolution line for BOTH legs with a per-token `won` flag
          // (did THIS token settle to $1) so calibration/backtests can use the
          // recorded token's own price→outcome directly, whichever side it is.
          for (const [tokenId, side] of [
            [tm.market.yesTokenId, 'YES'] as const,
            [tm.market.noTokenId, 'NO'] as const,
          ]) {
            write({
              t: 'resolution',
              ts: Date.now(),
              tokenId,
              side,
              asset: tm.market.asset,
              won: side === 'YES' ? res.yesWon : !res.yesWon,
              yesWon: res.yesWon,
              upPrice: res.upPrice,
            });
          }
        }
      }

      // Drop a market once we've captured its resolution and retained it long
      // enough for late trades — or after a hard timeout if resolution never
      // became decisive.
      for (const [tokenId, tm] of [...tracked.entries()]) {
        const resolveTime = tm.market.resolvesAt.getTime();
        const retainedEnough = resolveTime + RETAIN_AFTER_RESOLVE_MS < now;
        const timedOut = resolveTime + RESOLUTION_MAX_WAIT_MS < now;
        if ((tm.resolved && retainedEnough) || timedOut) {
          tracked.delete(tokenId);
          tokenAsset.delete(tm.market.yesTokenId);
          tokenAsset.delete(tm.market.noTokenId);
          tokenSide.delete(tm.market.yesTokenId);
          tokenSide.delete(tm.market.noTokenId);
        }
      }

      // Announce metadata for newly tracked markets. One CLOB call per new
      // market fetches the authoritative reward rate (rates=null => no rewards).
      for (const tm of tracked.values()) {
        if (tm.announced) continue;
        tm.announced = true;
        const clobRewards = await fetchClobRewards(tm.market.conditionId);
        // Announce BOTH legs (YES + NO), paired by conditionId, each tagged with
        // its outcome side so downstream tools know which token's price is which.
        for (const [tokenId, side] of [
          [tm.market.yesTokenId, 'YES'] as const,
          [tm.market.noTokenId, 'NO'] as const,
        ]) {
          write({
            t: 'market',
            ts: Date.now(),
            tokenId,
            side,
            conditionId: tm.market.conditionId,
            asset: tm.market.asset,
            resolvesAt: tm.market.resolvesAt.getTime(),
            windowMinutes: tm.market.windowMinutes,
            question: tm.market.question,
            // Liquidity-rewards config. `rewardsRates` is the ground truth: null
            // => the market pays NO liquidity rewards (current 5m crypto case).
            rewardsMaxSpread: tm.market.rewardsMaxSpread,
            rewardsMinSize: tm.market.rewardsMinSize,
            rewardsRates: clobRewards ? clobRewards.rates : undefined,
            rewardsActive: clobRewards ? (clobRewards.rates?.length ?? 0) > 0 : null,
            gammaSpread: tm.market.gammaSpread,
            // Fee schedule + maker rebate — the real maker economics here.
            feeRate: tm.market.feeRate,
            feeExponent: tm.market.feeExponent,
            feeTakerOnly: tm.market.feeTakerOnly,
            rebateRate: tm.market.rebateRate,
          });
        }
      }

      // Subscribe BOTH legs of every tracked market.
      const subTokens: string[] = [];
      for (const tm of tracked.values()) subTokens.push(tm.market.yesTokenId, tm.market.noTokenId);
      feed.setAssets(subTokens);
      logger.info({ tracked: tracked.size, tokens: subTokens.length, lines }, 'Recorder tick');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Recorder refresh failed');
    }
  }

  await refresh();
  const interval = setInterval(refresh, POLL_MS);

  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ lines, outPath, why }, 'Recorder shutting down');
    clearInterval(interval);
    feed.stop();
    priceFeed.stop();
    out.end(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Crash diagnosability (the recorder had NONE — a throw on any async path
  // killed it with no log line, which looked like "it just stops"). Now every
  // exit reason is logged and the tape is flushed.
  //   - uncaughtException: state may be inconsistent -> log + flush + exit (restart).
  //   - unhandledRejection: usually a transient async reject (a dropped fetch/WS
  //     promise) -> LOG and KEEP RECORDING; losing a multi-hour session over a
  //     blip is worse than continuing.
  //   - tape stream error: log; do not crash.
  process.on('uncaughtException', (err: any) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'Recorder uncaughtException — flushing and exiting');
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason: any) => {
    logger.error({ reason: reason?.message ?? String(reason) }, 'Recorder unhandledRejection — continuing');
  });
  out.on('error', (err: any) => {
    logger.error({ err: err?.message }, 'Recorder tape stream error — continuing');
  });

  // Auto-stop after the requested duration, flushing the tape cleanly.
  if (durationMs) setTimeout(() => shutdown('duration_reached'), durationMs);
}

main().catch((err) => {
  logger.error({ err: err?.message ?? String(err) }, 'Recorder fatal');
  process.exit(1);
});
