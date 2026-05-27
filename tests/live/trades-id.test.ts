// tests/live/trades-id.test.ts
import { describe, it, expect } from 'vitest';
import { deriveTradeId } from '../../src/clob/trades.js';

describe('deriveTradeId', () => {
  it('prefers the per-trade id when present', () => {
    expect(deriveTradeId({ id: 'abc', transactionHash: '0xtx' }, 1)).toBe('abc');
  });

  it('distinguishes two fills that share a transactionHash (the bug fix)', () => {
    const a = { transactionHash: '0xtx', bucketIndex: 0, side: 'BUY', price: 0.5, size: 6 };
    const b = { transactionHash: '0xtx', bucketIndex: 1, side: 'BUY', price: 0.5, size: 6 };
    expect(deriveTradeId(a, 100)).not.toBe(deriveTradeId(b, 100));
  });

  it('uses orderHash to distinguish when no bucketIndex is present', () => {
    const a = { transactionHash: '0xtx', orderHash: '0xa', side: 'BUY', price: 0.5, size: 6 };
    const b = { transactionHash: '0xtx', orderHash: '0xb', side: 'BUY', price: 0.5, size: 6 };
    expect(deriveTradeId(a, 100)).not.toBe(deriveTradeId(b, 100));
  });

  it('is stable across calls with the same input (idempotent dedup)', () => {
    const r = { transactionHash: '0xtx', bucketIndex: 3, side: 'SELL', price: 0.47, size: 10 };
    expect(deriveTradeId(r, 200)).toBe(deriveTradeId(r, 200));
  });
});
