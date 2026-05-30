import { describe, it, expect } from 'vitest';
import { decideHarvest, type HarvestInput } from '../../src/engine/harvester.js';

const base: Omit<HarvestInput, 'legs' | 'ttrSec'> = {
  enterSec: 90,
  exitSec: 30,
  minMid: 0.6,
  maxAsk: 0.9,
  clipShares: 5,
  minClipShares: 5,
};

const favBook = (yesMid: number, askSize = 50) => {
  // build a YES/NO pair with the given YES mid and a 2¢ spread on each leg
  const yesBid = yesMid - 0.01, yesAsk = yesMid + 0.01;
  const noMid = 1 - yesMid, noBid = noMid - 0.01, noAsk = noMid + 0.01;
  return [
    { label: 'YES' as const, bestBid: yesBid, bestAsk: yesAsk, askSize },
    { label: 'NO' as const, bestBid: noBid, bestAsk: noAsk, askSize },
  ];
};

describe('decideHarvest — timing gates', () => {
  it('waits when the window is still too early (ttr > enterSec)', () => {
    const d = decideHarvest({ ...base, ttrSec: 120, legs: favBook(0.75) });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('too_early');
  });

  it('skips once it is too late (ttr < exitSec)', () => {
    const d = decideHarvest({ ...base, ttrSec: 20, legs: favBook(0.75) });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('too_late');
  });
});

describe('decideHarvest — favorite selection', () => {
  it('enters the favorite (YES) inside the entry window', () => {
    const d = decideHarvest({ ...base, ttrSec: 75, legs: favBook(0.78) });
    expect(d.action).toBe('enter');
    expect(d.leg).toBe('YES');
    expect(d.ask).toBeCloseTo(0.79, 6);
    expect(d.shares).toBe(5);
  });

  it('enters the NO leg when NO is the favorite', () => {
    const d = decideHarvest({ ...base, ttrSec: 75, legs: favBook(0.30) }); // YES mid 0.30 => NO mid 0.70
    expect(d.action).toBe('enter');
    expect(d.leg).toBe('NO');
  });

  it('waits when the market is near 50/50 (no favorite)', () => {
    const d = decideHarvest({ ...base, ttrSec: 75, legs: favBook(0.53) });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('no_favorite');
  });

  it('does not buy a favorite priced above maxAsk (no room after fee)', () => {
    const d = decideHarvest({ ...base, ttrSec: 75, legs: favBook(0.95) }); // YES ask 0.96 > 0.90
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('favorite_unbuyable');
  });

  it('does not enter when the ask side is too thin (size < minClip)', () => {
    const d = decideHarvest({ ...base, ttrSec: 75, legs: favBook(0.78, 3) }); // only 3 sh at the ask
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('favorite_unbuyable');
  });

  it('clamps the clip to available ask size when it is between min and clip', () => {
    const legs = favBook(0.78, 5);
    const d = decideHarvest({ ...base, ttrSec: 75, legs });
    expect(d.action).toBe('enter');
    expect(d.shares).toBe(5);
  });

  it('picks the clearer (higher-mid) favorite if both legs somehow qualify', () => {
    // pathological: both asks <= maxAsk and both mids >= minMid (wide crossed-ish book)
    const legs = [
      { label: 'YES' as const, bestBid: 0.60, bestAsk: 0.62, askSize: 50 }, // mid 0.61
      { label: 'NO' as const, bestBid: 0.64, bestAsk: 0.66, askSize: 50 }, // mid 0.65
    ];
    const d = decideHarvest({ ...base, ttrSec: 75, legs });
    expect(d.action).toBe('enter');
    expect(d.leg).toBe('NO'); // higher mid
  });
});
