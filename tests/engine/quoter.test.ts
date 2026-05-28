import { describe, it, expect } from 'vitest';
import { computeQuotes, type QuoteInput } from '../../src/engine/quoter.js';
import type { MakerConfig } from '../../src/util/config.js';

const cfg: MakerConfig = {
  halfSpread: 0.03,
  quoteSizeUsd: 3.0,
  minQuoteShares: 5.0,
  inventorySkewK: 0.5,
  widenFactor: 2.0,
  maxInventoryUsd: 15.0,
  tickSize: 0.01,
  adverseGuard: { btcReturn30sWiden: 0.0005, btcReturn30sPull: 0.001 },
  flattenBeforeSec: 20,
  flattenIfNetAboveUsd: 6.0,
  disableSell: false,
  quotePriceMin: 0.05,
  quotePriceMax: 0.95,
  maxBuyPrice: 0.50,
  maxUnmatchedShares: 5,
  maxSpendPerLegUsd: 5,
  replaceDeadbandTicks: 3,
  fillParticipation: 1.0,
  takerFeeRate: 0.07,
};

const base: QuoteInput = {
  bestBid: 0.49,
  bestAsk: 0.53,
  inventoryShares: 0,
  inventoryUsd: 0,
  btcReturn30s: 0,
  timeToResolveSec: 120,
};

describe('computeQuotes', () => {
  it('quotes both sides around mid when flat and calm', () => {
    const d = computeQuotes(base, cfg);
    expect(d.action).toBe('quote');
    if (d.action !== 'quote') return;
    // mid = 0.51, halfSpread 0.03 -> bid ~0.48 (rounded down), ask ~0.54 (up)
    expect(d.bid!.price).toBeLessThan(0.51);
    expect(d.ask!.price).toBeGreaterThan(0.51);
    expect(d.bid!.price).toBeLessThan(d.ask!.price);
    expect(d.reason).toBe('normal');
  });

  it('sizes each side as quoteSizeUsd / price', () => {
    const d = computeQuotes(base, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid!.sizeShares).toBeCloseTo(cfg.quoteSizeUsd / d.bid!.price, 6);
  });

  it('does not quote inside the flatten window', () => {
    const d = computeQuotes({ ...base, timeToResolveSec: 10 }, cfg);
    expect(d).toEqual({ action: 'no_quote', reason: 'flatten_window' });
  });

  it('skips when book is one-sided / crossed', () => {
    const d = computeQuotes({ ...base, bestBid: 0.6, bestAsk: 0.5 }, cfg);
    expect(d).toEqual({ action: 'no_quote', reason: 'no_two_sided_book' });
  });

  it('skews quotes DOWN when long YES (to sell inventory)', () => {
    const flat = computeQuotes(base, cfg);
    const long = computeQuotes({ ...base, inventoryShares: 20, inventoryUsd: 10 }, cfg);
    if (flat.action !== 'quote' || long.action !== 'quote') throw new Error('expected quotes');
    // Reservation shifts down -> ask becomes more reachable (lower) than when flat.
    expect(long.ask!.price).toBeLessThanOrEqual(flat.ask!.price);
    expect(long.bid!.price).toBeLessThanOrEqual(flat.bid!.price);
  });

  it('widens the spread when BTC is moving past the widen threshold', () => {
    const calm = computeQuotes(base, cfg);
    const moving = computeQuotes({ ...base, btcReturn30s: 0.0007 }, cfg);
    if (calm.action !== 'quote' || moving.action !== 'quote') throw new Error('expected quotes');
    const calmW = calm.ask!.price - calm.bid!.price;
    const movingW = moving.ask!.price - moving.bid!.price;
    expect(movingW).toBeGreaterThan(calmW);
    expect(moving.reason).toBe('widened');
  });

  it('pulls the ask when BTC rips up (avoid selling YES cheap to informed flow)', () => {
    const d = computeQuotes({ ...base, btcReturn30s: 0.002 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask).toBeNull();
    expect(d.bid).not.toBeNull();
    expect(d.reason).toBe('pulled_one_side');
  });

  it('pulls the bid when BTC dumps (avoid buying YES into worthlessness)', () => {
    const d = computeQuotes({ ...base, btcReturn30s: -0.002 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).toBeNull();
    expect(d.ask).not.toBeNull();
  });

  it('drops the bid when inventory is at the long cap', () => {
    const d = computeQuotes({ ...base, inventoryShares: 40, inventoryUsd: 15 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).toBeNull();
    expect(d.ask).not.toBeNull();
  });

  it('drops the ask when inventory is at the short cap', () => {
    const d = computeQuotes({ ...base, inventoryShares: -40, inventoryUsd: -15 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask).toBeNull();
    expect(d.bid).not.toBeNull();
  });

  it('clamps quote size UP to minQuoteShares at extreme prices', () => {
    // Override maxBuyPrice for this test — the default 0.50 would suppress
    // the bid at mid 0.70. We're testing the min-size clamp specifically.
    const cfgNoMaxBuy = { ...cfg, maxBuyPrice: 1.0 };
    const d = computeQuotes({ ...base, bestBid: 0.69, bestAsk: 0.71 }, cfgNoMaxBuy);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask!.sizeShares).toBeGreaterThanOrEqual(cfg.minQuoteShares);
    expect(d.bid!.sizeShares).toBeGreaterThanOrEqual(cfg.minQuoteShares);
  });

  it('refuses to quote outside the [quotePriceMin, quotePriceMax] band', () => {
    // Same: disable maxBuyPrice to isolate the [min, max] band behavior.
    const cfgNoMaxBuy = { ...cfg, maxBuyPrice: 1.0 };
    const d = computeQuotes({ ...base, bestBid: 0.96, bestAsk: 0.98 }, cfgNoMaxBuy);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask).toBeNull();
    expect(d.bid).not.toBeNull();
  });

  it('suppresses BUY when computed bid > maxBuyPrice (asymmetric underdog filter)', () => {
    // mid 0.70 → bid would be 0.67 (R/R 0.49:1 — terrible). Filter kills it.
    // The ASK side stays unaffected — selling at 0.73 is still fine.
    const d = computeQuotes({ ...base, bestBid: 0.69, bestAsk: 0.71 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).toBeNull();
    expect(d.ask).not.toBeNull();
    expect(d.reason).toBe('buy_above_max_price');
  });

  it('permits BUY above maxBuyPrice when the other leg has more shares (hedge-BUY)', () => {
    // Same setup as the underdog-filter test (mid 0.70 → bid would be 0.67),
    // but now the OTHER leg holds 8 shares while this leg holds 0. Buying THIS
    // leg up to 8 shares converts directional risk into a matched pair, so the
    // filter relaxes up to HEDGE_BUY_PRICE_CEILING (0.85).
    const d = computeQuotes(
      { ...base, bestBid: 0.69, bestAsk: 0.71, otherLegShares: 8 },
      cfg,
    );
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).not.toBeNull();
    expect(d.bid!.price).toBeGreaterThan(cfg.maxBuyPrice);
    expect(d.bid!.price).toBeLessThanOrEqual(0.85);
  });

  it('still suppresses BUY above the hedge ceiling (0.85) even when hedging', () => {
    // mid 0.90 → bid 0.87 > 0.85 hedge ceiling. Hedge room exists but the
    // ceiling protects against quoting at extreme prices.
    const d = computeQuotes(
      { ...base, bestBid: 0.89, bestAsk: 0.91, otherLegShares: 10 },
      cfg,
    );
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).toBeNull();
    expect(d.reason).toBe('buy_above_max_price');
  });

  it('hedge-BUY does NOT trigger when this leg already matches the other', () => {
    // Both legs hold the same number of shares → hedgeRoom = 0 → base filter
    // still applies, BUY at 0.67 is rejected.
    const d = computeQuotes(
      {
        ...base,
        bestBid: 0.69,
        bestAsk: 0.71,
        inventoryShares: 8,
        inventoryUsd: 8 * 0.7,
        otherLegShares: 8,
      },
      cfg,
    );
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.bid).toBeNull();
    expect(d.reason).toBe('buy_above_max_price');
  });

  it('rounds bid down and ask up to the tick grid', () => {
    const d = computeQuotes(base, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(Math.round(d.bid!.price * 100)).toBeCloseTo(d.bid!.price * 100, 6);
    expect(Math.round(d.ask!.price * 100)).toBeCloseTo(d.ask!.price * 100, 6);
  });
});
