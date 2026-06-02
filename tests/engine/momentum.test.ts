import { describe, it, expect } from 'vitest';
import { decideMomentum, type MomentumInput } from '../../src/engine/momentum.js';

const base: Omit<MomentumInput, 'ttrSec' | 'priorReturn'> = {
  enterSec: 270,
  exitSec: 120,
  threshold: 0.0005,
  strongThreshold: 0.0020,
  strongMult: 2,
  longOnly: false,
  contrarian: false,
  maxAsk: 0.80,
  clipShares: 5,
  minClipShares: 5,
  yes: { bestBid: 0.51, bestAsk: 0.53, askSize: 50 },
  no: { bestBid: 0.47, bestAsk: 0.49, askSize: 50 },
};

describe('decideMomentum — timing & signal gates', () => {
  it('waits before the entry window (ttr > enterSec)', () => {
    const d = decideMomentum({ ...base, ttrSec: 290, priorReturn: 0.002 });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('too_early');
  });

  it('skips after the entry floor (ttr < exitSec)', () => {
    const d = decideMomentum({ ...base, ttrSec: 90, priorReturn: 0.002 });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('too_late');
  });

  it('waits when the feed has no signal yet (null)', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: null });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('no_signal');
  });

  it('waits when the trend is flat (|return| < threshold)', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0002 });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('flat_trend');
  });
});

describe('decideMomentum — direction', () => {
  it('buys YES on an uptrend', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0015 });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('YES');
    expect(d.ask).toBeCloseTo(0.53, 6);
    expect(d.shares).toBe(5);
  });

  it('buys NO on a downtrend', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: -0.0015 });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('NO');
    expect(d.ask).toBeCloseTo(0.49, 6);
  });

  it('long-only: still buys YES on an uptrend', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0015, longOnly: true });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('YES');
  });

  it('long-only: SKIPS a downtrend (never buys NO)', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: -0.0015, longOnly: true });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('long_only_skip_down');
  });
});

describe('decideMomentum — contrarian (fade the trend)', () => {
  it('fades an uptrend → buys NO', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0015, contrarian: true });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('NO');
    expect(d.reason).toBe('fade');
  });

  it('fades a downtrend → buys YES', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: -0.0015, contrarian: true });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('YES');
    expect(d.reason).toBe('fade');
  });

  it('contrarian still sizes up on strong moves', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0030, contrarian: true });
    expect(d.action).toBe('enter');
    expect(d.side).toBe('NO');
    expect(d.shares).toBe(10);
    expect(d.reason).toBe('fade_strong');
  });
});

describe('decideMomentum — buyability guards', () => {
  it('does not chase a side whose ask is already above maxAsk', () => {
    const d = decideMomentum({
      ...base,
      ttrSec: 260,
      priorReturn: 0.0015,
      yes: { bestBid: 0.82, bestAsk: 0.84, askSize: 50 }, // book already priced the move
    });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('side_unbuyable');
  });

  it('does not enter when the side is too thin (size < minClip)', () => {
    const d = decideMomentum({
      ...base,
      ttrSec: 260,
      priorReturn: -0.0015,
      no: { bestBid: 0.47, bestAsk: 0.49, askSize: 3 },
    });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('side_unbuyable');
  });

  it('clamps the clip to available ask size', () => {
    const d = decideMomentum({
      ...base,
      ttrSec: 260,
      priorReturn: 0.0015,
      yes: { bestBid: 0.51, bestAsk: 0.53, askSize: 5 },
    });
    expect(d.action).toBe('enter');
    expect(d.shares).toBe(5);
  });
});

describe('decideMomentum — conviction sizing', () => {
  it('uses the base clip on a normal-strength trend', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0015 }); // < strongThreshold
    expect(d.action).toBe('enter');
    expect(d.shares).toBe(5);
    expect(d.reason).toBe('trend');
  });

  it('sizes up (×mult) on a strong trend', () => {
    const d = decideMomentum({ ...base, ttrSec: 260, priorReturn: 0.0030 }); // >= strongThreshold
    expect(d.action).toBe('enter');
    expect(d.shares).toBe(10); // 5 × 2
    expect(d.reason).toBe('trend_strong');
  });

  it('still clamps the sized-up clip to available ask size', () => {
    const d = decideMomentum({
      ...base,
      ttrSec: 260,
      priorReturn: 0.0030,
      yes: { bestBid: 0.51, bestAsk: 0.53, askSize: 7 }, // wants 10, only 7 available
    });
    expect(d.action).toBe('enter');
    expect(d.shares).toBe(7);
  });
});
