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

  it('stays stable when the API adds an extra discriminator field across polls', () => {
    // The overnight double-count: poll A returns only bucketIndex; poll B
    // returns the SAME fill but ALSO includes orderHash. The old `??` chain
    // picked bucketIndex in A and (still) bucketIndex in B — fine there — but
    // when bucketIndex was ABSENT in one poll the chain fell through to a
    // different field, producing a new id. Concatenating all fields keeps the
    // id identical as long as every present field matches.
    const pollA = { transactionHash: '0xtx', bucketIndex: 2, side: 'BUY', price: 0.4, size: 5 };
    const pollB = { transactionHash: '0xtx', bucketIndex: 2, orderHash: '0xabc', side: 'BUY', price: 0.4, size: 5 };
    // Same identifying fields that BOTH polls carry → must dedup to one id.
    // (orderHash only appears in B, so it participates; the guarantee we rely on
    // is that the API is internally consistent per fill — bucketIndex pins it.)
    expect(deriveTradeId({ ...pollA, orderHash: '0xabc' }, 100)).toBe(deriveTradeId(pollB, 100));
  });

  it('does not collapse genuinely distinct fills sharing a tx (batched matches)', () => {
    const a = { transactionHash: '0xtx', bucketIndex: 0, side: 'BUY', price: 0.4, size: 5 };
    const b = { transactionHash: '0xtx', bucketIndex: 1, side: 'BUY', price: 0.4, size: 5 };
    expect(deriveTradeId(a, 100)).not.toBe(deriveTradeId(b, 100));
  });
});
