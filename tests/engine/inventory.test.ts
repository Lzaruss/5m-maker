import { describe, it, expect } from 'vitest';
import {
  emptyInventory,
  applyFill,
  closeGate,
  markToMarket,
  inventoryUsd,
} from '../../src/engine/inventory.js';
import type { MakerConfig } from '../../src/util/config.js';

const cfg: MakerConfig = {
  halfSpread: 0.03,
  quoteSizeUsd: 3.0,
  inventorySkewK: 0.5,
  widenFactor: 2.0,
  maxInventoryUsd: 15.0,
  tickSize: 0.01,
  adverseGuard: { btcReturn30sWiden: 0.0005, btcReturn30sPull: 0.001 },
  flattenBeforeSec: 20,
  flattenIfNetAboveUsd: 6.0,
  fillParticipation: 1.0,
  takerFeeMax: 0.018,
};

describe('applyFill', () => {
  it('a buy adds shares and spends cash', () => {
    const s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 10 });
    expect(s.shares).toBe(10);
    expect(s.cashUsd).toBeCloseTo(-5, 6);
    expect(s.avgCost).toBeCloseTo(0.5, 6);
    expect(s.fills).toBe(1);
  });

  it('a completed round (buy then sell higher) realizes the spread', () => {
    let s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 10 });
    s = applyFill(s, { side: 'SELL', price: 0.53, shares: 10 });
    expect(s.shares).toBe(0);
    // cash = -5 + 5.3 = +0.30
    expect(s.cashUsd).toBeCloseTo(0.3, 6);
    expect(markToMarket(s, 0.51)).toBeCloseTo(0.3, 6);
  });

  it('mark-to-market values residual shares at the mark', () => {
    const s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 10 });
    expect(markToMarket(s, 0.5)).toBeCloseTo(0, 6); // bought at mark -> zero PnL
    expect(markToMarket(s, 0.6)).toBeCloseTo(1.0, 6); // mark up 0.1 * 10 shares
    expect(inventoryUsd(s, 0.6)).toBeCloseTo(6, 6);
  });
});

describe('closeGate', () => {
  it('holds while the window is still open', () => {
    const s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 20 });
    expect(closeGate(s, 0.5, 100, cfg).action).toBe('hold');
  });

  it('flattens large inventory inside the flatten window', () => {
    const s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 20 }); // $10 > $6
    const d = closeGate(s, 0.5, 10, cfg);
    expect(d.action).toBe('flatten');
  });

  it('holds a small residual inside the flatten window', () => {
    const s = applyFill(emptyInventory(), { side: 'BUY', price: 0.5, shares: 4 }); // $2 < $6
    expect(closeGate(s, 0.5, 10, cfg).action).toBe('hold');
  });

  it('holds when flat', () => {
    expect(closeGate(emptyInventory(), 0.5, 5, cfg).action).toBe('hold');
  });
});
