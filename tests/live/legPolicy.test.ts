import { describe, it, expect } from 'vitest';
import {
  hedgeBlocksBuy,
  spendBlocksBuy,
  legSettlePrice,
  buildDesired,
  type BuildDesiredParams,
} from '../../src/live/legPolicy.js';
import type { QuoteDecision } from '../../src/engine/quoter.js';

const quote = (
  bid: { price: number; sizeShares: number } | null,
  ask: { price: number; sizeShares: number } | null,
): QuoteDecision => ({ action: 'quote', bid, ask, reason: 'normal' });

const base: BuildDesiredParams = {
  decision: quote({ price: 0.47, sizeShares: 6 }, { price: 0.54, sizeShares: 6 }),
  halted: false,
  allowBuy: true,
  allowSell: true,
  bestBid: 0.49,
  bestAsk: 0.53,
  legShares: 100, // plenty to back a SELL
  otherLegShares: 0, // fully unmatched -> all 100 are excess, eligible to sell
  hedgeBlocksBuy: false,
  spendBlocksBuy: false,
  disableSell: false,
};

describe('hedgeBlocksBuy', () => {
  it('blocks once this leg exceeds the other by the cap', () => {
    expect(hedgeBlocksBuy(5, 0, 5)).toBe(true);
    expect(hedgeBlocksBuy(4, 0, 5)).toBe(false);
    expect(hedgeBlocksBuy(10, 6, 5)).toBe(false); // diff 4 < 5
    expect(hedgeBlocksBuy(11, 6, 5)).toBe(true); // diff 5 >= 5
  });
});

describe('spendBlocksBuy', () => {
  it('blocks at/above the per-leg spend cap', () => {
    expect(spendBlocksBuy(5, 5)).toBe(true);
    expect(spendBlocksBuy(4.99, 5)).toBe(false);
  });
});

describe('legSettlePrice', () => {
  it('YES pays 1 when Up won, 0 otherwise', () => {
    expect(legSettlePrice('YES', true)).toBe(1);
    expect(legSettlePrice('YES', false)).toBe(0);
  });
  it('NO is the complement', () => {
    expect(legSettlePrice('NO', true)).toBe(0);
    expect(legSettlePrice('NO', false)).toBe(1);
  });
});

describe('buildDesired', () => {
  it('posts both sides in the happy path', () => {
    const d = buildDesired(base);
    expect(d).toEqual([
      { side: 'BUY', price: 0.47, size: 6 },
      { side: 'SELL', price: 0.54, size: 6 },
    ]);
  });

  it('posts nothing when halted', () => {
    expect(buildDesired({ ...base, halted: true })).toEqual([]);
  });

  it('posts nothing on a no_quote decision', () => {
    expect(buildDesired({ ...base, decision: { action: 'no_quote', reason: 'x' } })).toEqual([]);
  });

  it('suppresses BUY when the hedge cap is hit (ask still posts)', () => {
    const d = buildDesired({ ...base, hedgeBlocksBuy: true });
    expect(d).toEqual([{ side: 'SELL', price: 0.54, size: 6 }]);
  });

  it('suppresses BUY when the spend cap is hit', () => {
    const d = buildDesired({ ...base, spendBlocksBuy: true });
    expect(d.find((q) => q.side === 'BUY')).toBeUndefined();
  });

  it('suppresses BUY when gate disallows buying', () => {
    const d = buildDesired({ ...base, allowBuy: false });
    expect(d.find((q) => q.side === 'BUY')).toBeUndefined();
  });

  it('suppresses BUY that would cross the touch (bid >= bestAsk)', () => {
    const d = buildDesired({
      ...base,
      decision: quote({ price: 0.53, sizeShares: 6 }, { price: 0.56, sizeShares: 6 }),
      bestAsk: 0.53,
    });
    expect(d.find((q) => q.side === 'BUY')).toBeUndefined();
  });

  it('suppresses SELL when we do not own enough shares (no naked short)', () => {
    const d = buildDesired({ ...base, legShares: 3 }); // ask wants 6
    expect(d).toEqual([{ side: 'BUY', price: 0.47, size: 6 }]);
  });

  it('holds the matched-pair core: no SELL when legs are fully matched', () => {
    // 100 vs 100 -> unmatched excess 0 -> nothing eligible to sell; rides to redeem
    const d = buildDesired({ ...base, legShares: 100, otherLegShares: 100 });
    expect(d.find((q) => q.side === 'SELL')).toBeUndefined();
  });

  it('suppresses SELL when unmatched excess is below a full clip', () => {
    // excess 4 < ask size 6 -> no SELL (would nibble into the matched core)
    const d = buildDesired({ ...base, legShares: 100, otherLegShares: 96 });
    expect(d.find((q) => q.side === 'SELL')).toBeUndefined();
  });

  it('sells only the unmatched excess when it covers a full clip', () => {
    // excess 10 >= ask size 6 -> SELL the excess, never the matched core
    const d = buildDesired({ ...base, legShares: 100, otherLegShares: 90 });
    expect(d).toContainEqual({ side: 'SELL', price: 0.54, size: 6 });
  });

  it('suppresses SELL that would cross the touch (ask <= bestBid)', () => {
    const d = buildDesired({
      ...base,
      decision: quote({ price: 0.44, sizeShares: 6 }, { price: 0.49, sizeShares: 6 }),
      bestBid: 0.49,
    });
    expect(d.find((q) => q.side === 'SELL')).toBeUndefined();
  });

  it('never posts SELL when disableSell is set', () => {
    const d = buildDesired({ ...base, disableSell: true });
    expect(d.every((q) => q.side === 'BUY')).toBe(true);
  });
});
