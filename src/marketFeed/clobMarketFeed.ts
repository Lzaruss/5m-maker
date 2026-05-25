import WebSocket from 'ws';
import { logger } from '../util/logger.js';

const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookSnapshot {
  assetId: string;
  bids: BookLevel[]; // sorted best (highest price) first
  asks: BookLevel[]; // sorted best (lowest price) first
  ts: number;
}

export interface TradePrint {
  assetId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL'; // taker side as reported by the venue
  ts: number;
}

export interface MarketFeedHandlers {
  onBook?: (snap: BookSnapshot) => void;
  onTrade?: (trade: TradePrint) => void;
}

interface SideBook {
  bids: Map<number, number>; // price -> size
  asks: Map<number, number>;
}

/**
 * Polymarket CLOB "market" channel WebSocket. Subscribes to a set of token ids
 * and maintains an in-memory order book per token by applying the initial full
 * `book` snapshot and subsequent `price_change` deltas. Emits a normalized
 * BookSnapshot on every change and a TradePrint for every `last_trade_price`.
 *
 * No authentication required — the market channel is public.
 */
export class ClobMarketFeed {
  private ws: WebSocket | null = null;
  private assetIds: string[] = [];
  private books = new Map<string, SideBook>();
  private reconnectDelay = 1000;
  private stopped = false;
  private handlers: MarketFeedHandlers;

  constructor(handlers: MarketFeedHandlers) {
    this.handlers = handlers;
  }

  /** Replace the subscribed token set. Reconnects if the set actually changed. */
  setAssets(assetIds: string[]): void {
    const next = [...new Set(assetIds)].sort();
    const cur = [...this.assetIds].sort();
    if (next.length === cur.length && next.every((v, i) => v === cur[i])) return;
    this.assetIds = next;
    logger.info({ count: next.length }, 'ClobMarketFeed: subscription set changed, reconnecting');
    this.reconnect();
  }

  stop(): void {
    this.stopped = true;
    this.closeSocket();
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private reconnect(): void {
    this.closeSocket();
    if (this.stopped || this.assetIds.length === 0) return;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.assetIds.length === 0) return;
    const ws = new WebSocket(MARKET_WS);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'market', assets_ids: this.assetIds }));
      logger.info({ count: this.assetIds.length }, 'ClobMarketFeed: connected & subscribed');
    });

    ws.on('message', (raw) => this.onMessage(raw.toString()));

    ws.on('close', () => {
      if (this.stopped) return;
      logger.warn(`ClobMarketFeed: closed, reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => {
        if (this.ws === ws || this.ws === null) this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    });

    ws.on('error', (err: any) => logger.error({ err: err.message }, 'ClobMarketFeed: WS error'));
  }

  private onMessage(text: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // ping/pong or non-JSON keepalive
    }
    const events: any[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) this.handleEvent(ev);
  }

  private handleEvent(ev: any): void {
    const type = ev?.event_type;
    const assetId: string | undefined = ev?.asset_id;
    if (!type || !assetId) return;
    const ts = parseTs(ev?.timestamp);

    switch (type) {
      case 'book': {
        const book: SideBook = { bids: new Map(), asks: new Map() };
        for (const lvl of ev.bids ?? []) {
          const p = Number(lvl.price);
          const s = Number(lvl.size);
          if (p > 0 && s > 0) book.bids.set(round4(p), s);
        }
        for (const lvl of ev.asks ?? []) {
          const p = Number(lvl.price);
          const s = Number(lvl.size);
          if (p > 0 && s > 0) book.asks.set(round4(p), s);
        }
        this.books.set(assetId, book);
        this.emitBook(assetId, ts);
        break;
      }
      case 'price_change': {
        const book = this.books.get(assetId);
        if (!book) break; // wait for a full snapshot first
        for (const ch of ev.changes ?? []) {
          const p = round4(Number(ch.price));
          const s = Number(ch.size);
          const side = String(ch.side).toUpperCase();
          const map = side === 'BUY' ? book.bids : book.asks;
          if (!(p > 0)) continue;
          if (s > 0) map.set(p, s);
          else map.delete(p);
        }
        this.emitBook(assetId, ts);
        break;
      }
      case 'last_trade_price': {
        const price = Number(ev.price);
        const size = Number(ev.size);
        const side = String(ev.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        if (price > 0 && size > 0 && this.handlers.onTrade) {
          this.handlers.onTrade({ assetId, price, size, side, ts });
        }
        break;
      }
      default:
        break; // tick_size_change and others ignored for now
    }
  }

  private emitBook(assetId: string, ts: number): void {
    if (!this.handlers.onBook) return;
    const book = this.books.get(assetId);
    if (!book) return;
    const bids = [...book.bids.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
    const asks = [...book.asks.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    this.handlers.onBook({ assetId, bids, asks, ts });
  }
}

function parseTs(raw: any): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // sec -> ms if needed
  return Date.now();
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
