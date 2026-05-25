import WebSocket from 'ws';
import { logger } from '../util/logger.js';
import { ASSET_SYMBOLS, SYMBOL_TO_ASSET, type Asset } from '../util/assets.js';

interface PricePoint {
  ts: number;
  price: number;
}

/**
 * Binance combined-ticker WebSocket. Maintains a per-asset rolling buffer of
 * the last ~70s of prices and exposes `getReturn(asset, secondsBack)`.
 * Copied from btc-5m-sniper (proven module); the recorder reuses it to stamp
 * each tape entry with a synchronized BTC return.
 */
export class PriceFeed {
  private ws: WebSocket | null = null;
  private buffers = new Map<Asset, PricePoint[]>();
  private readonly maxAgeMs = 70_000;
  private reconnectDelay = 1000;
  private assets: Asset[] = [];
  private tickCounts = new Map<Asset, number>();
  private stopped = false;

  start(assets: Asset[]): void {
    this.assets = assets;
    this.stopped = false;
    for (const a of assets) if (!this.buffers.has(a)) this.buffers.set(a, []);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  /** Test seam + internal ingestion of a single tick. */
  ingest(symbol: string, price: number, tsMs: number): void {
    const asset = SYMBOL_TO_ASSET[symbol];
    if (!asset || price <= 0) return;
    let buf = this.buffers.get(asset);
    if (!buf) {
      buf = [];
      this.buffers.set(asset, buf);
    }
    buf.push({ ts: tsMs, price });
    while (buf.length && buf[0].ts < tsMs - this.maxAgeMs) buf.shift();
    this.tickCounts.set(asset, (this.tickCounts.get(asset) ?? 0) + 1);
  }

  /** Fractional return over the last `secondsBack` seconds; null if stale/empty
   *  or if real data covers < 80% of the requested window. */
  getReturn(asset: Asset, secondsBack: number): number | null {
    const buf = this.buffers.get(asset);
    if (!buf || buf.length < 2) return null;
    const now = Date.now();
    const latest = buf[buf.length - 1];
    if (latest.ts < now - 5000) return null;
    const cutoff = latest.ts - secondsBack * 1000;
    const past = buf.find((p) => p.ts >= cutoff);
    if (!past || past.price <= 0) return null;
    if (latest.ts - past.ts < secondsBack * 800) return null;
    return (latest.price - past.price) / past.price;
  }

  getLatestPrice(asset: Asset): number | null {
    const buf = this.buffers.get(asset);
    return buf && buf.length ? buf[buf.length - 1].price : null;
  }

  async waitUntilReady(assets: Asset[], timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (assets.every((a) => this.getReturn(a, 30) !== null)) return true;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    return false;
  }

  private connect(): void {
    if (this.stopped) return;
    const streams = this.assets.map((a) => `${ASSET_SYMBOLS[a]}@ticker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info({ assets: this.assets }, 'Binance combined WS connected');
      this.reconnectDelay = 1000;
    });
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const stream: string = msg.stream ?? '';
        const symbol = stream.split('@')[0];
        const price = Number(msg.data?.c);
        if (symbol && price > 0) this.ingest(symbol, price, Date.now());
      } catch (e: any) {
        logger.debug({ err: e.message }, 'price tick parse error');
      }
    });
    this.ws.on('close', () => {
      if (this.stopped) return;
      logger.warn(`Binance WS closed, reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    });
    this.ws.on('error', (err: any) => {
      logger.error({ err: err.message }, 'Binance WS error');
    });
  }
}
