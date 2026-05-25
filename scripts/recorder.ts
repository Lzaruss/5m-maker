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
import { fetchMarkets, fetchResolution, type ShortMarket } from '../src/markets/gammaPoller.js';
import { ClobMarketFeed } from '../src/marketFeed/clobMarketFeed.js';
import type { Asset } from '../src/util/assets.js';

const WINDOW_MINUTES = 5;
const POLL_MS = 20_000;
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

async function main(): Promise<void> {
  const cfg = loadBotYaml();
  const assets = cfg.assets;
  logger.info({ assets }, 'Recorder starting');

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
  // tokenId -> tracked market, for retention bookkeeping.
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
        bid: bestBid?.price ?? null,
        bidSz: bestBid?.size ?? null,
        ask: bestAsk?.price ?? null,
        askSz: bestAsk?.size ?? null,
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
          write({
            t: 'resolution',
            ts: Date.now(),
            tokenId: tm.market.yesTokenId,
            asset: tm.market.asset,
            yesWon: res.yesWon,
            upPrice: res.upPrice,
          });
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
          tokenAsset.delete(tokenId);
        }
      }

      // Announce metadata for newly tracked markets.
      for (const tm of tracked.values()) {
        if (tm.announced) continue;
        tm.announced = true;
        write({
          t: 'market',
          ts: Date.now(),
          tokenId: tm.market.yesTokenId,
          asset: tm.market.asset,
          resolvesAt: tm.market.resolvesAt.getTime(),
          windowMinutes: tm.market.windowMinutes,
          question: tm.market.question,
        });
      }

      feed.setAssets([...tracked.keys()]);
      logger.info({ tracked: tracked.size, lines }, 'Recorder tick');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Recorder refresh failed');
    }
  }

  await refresh();
  const interval = setInterval(refresh, POLL_MS);

  const shutdown = () => {
    logger.info({ lines, outPath }, 'Recorder shutting down');
    clearInterval(interval);
    feed.stop();
    priceFeed.stop();
    out.end(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err: err?.message ?? String(err) }, 'Recorder fatal');
  process.exit(1);
});
