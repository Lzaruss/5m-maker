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
    // With mid 0.70, both bid (0.67) and ask (0.73) yield naive size = 3/p <
    // 5 shares. Both within the [0.05, 0.95] quote clip so they're not
    // suppressed; size is clamped to minQuoteShares.
    const d = computeQuotes({ ...base, bestBid: 0.69, bestAsk: 0.71 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask!.sizeShares).toBeGreaterThanOrEqual(cfg.minQuoteShares);
    expect(d.bid!.sizeShares).toBeGreaterThanOrEqual(cfg.minQuoteShares);
  });

  it('refuses to quote outside the [quotePriceMin, quotePriceMax] band', () => {
    // mid 0.97 -> ask ~1.00 (clipped to 0.99 by venue, then clipped by
    // quotePriceMax 0.95 -> null). The bid (0.94) is allowed.
    const d = computeQuotes({ ...base, bestBid: 0.96, bestAsk: 0.98 }, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(d.ask).toBeNull();
    expect(d.bid).not.toBeNull();
  });

  it('rounds bid down and ask up to the tick grid', () => {
    const d = computeQuotes(base, cfg);
    if (d.action !== 'quote') throw new Error('expected quote');
    expect(Math.round(d.bid!.price * 100)).toBeCloseTo(d.bid!.price * 100, 6);
    expect(Math.round(d.ask!.price * 100)).toBeCloseTo(d.ask!.price * 100, 6);
  });
});
