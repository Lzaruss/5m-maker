// tests/live/reconciler.test.ts
import { describe, it, expect } from 'vitest';
import { reconcile, type LiveOrder, type DesiredQuote } from '../../src/live/reconciler.js';

const open: LiveOrder[] = [
  { id: 'b1', side: 'BUY', price: 0.49, size: 6 },
  { id: 'a1', side: 'SELL', price: 0.53, size: 6 },
];

describe('reconcile', () => {
  it('keeps an order whose price already matches desired (no churn)', () => {
    const desired: DesiredQuote[] = [
      { side: 'BUY', price: 0.49, size: 6 },
      { side: 'SELL', price: 0.53, size: 6 },
    ];
    const r = reconcile(open, desired, 0.01);
    expect(r.toCancel).toEqual([]);
    expect(r.toPlace).toEqual([]);
  });

  it('cancels and replaces a side whose desired price moved', () => {
    const desired: DesiredQuote[] = [
      { side: 'BUY', price: 0.48, size: 6 },
      { side: 'SELL', price: 0.53, size: 6 },
    ];
    const r = reconcile(open, desired, 0.01);
    expect(r.toCancel).toEqual(['b1']);
    expect(r.toPlace).toEqual([{ side: 'BUY', price: 0.48, size: 6 }]);
  });

  it('cancels a side that is no longer desired (pulled)', () => {
    const desired: DesiredQuote[] = [{ side: 'SELL', price: 0.53, size: 6 }];
    const r = reconcile(open, desired, 0.01);
    expect(r.toCancel).toEqual(['b1']);
    expect(r.toPlace).toEqual([]);
  });

  it('places a missing side', () => {
    const desired: DesiredQuote[] = [
      { side: 'BUY', price: 0.49, size: 6 },
      { side: 'SELL', price: 0.53, size: 6 },
    ];
    const r = reconcile([open[0]], desired, 0.01);
    expect(r.toCancel).toEqual([]);
    expect(r.toPlace).toEqual([{ side: 'SELL', price: 0.53, size: 6 }]);
  });

  it('cancels duplicate orders on the same side, keeping the matching one', () => {
    const dup: LiveOrder[] = [...open, { id: 'b2', side: 'BUY', price: 0.40, size: 6 }];
    const desired: DesiredQuote[] = [
      { side: 'BUY', price: 0.49, size: 6 },
      { side: 'SELL', price: 0.53, size: 6 },
    ];
    const r = reconcile(dup, desired, 0.01);
    expect(r.toCancel).toEqual(['b2']);
    expect(r.toPlace).toEqual([]);
  });
});
