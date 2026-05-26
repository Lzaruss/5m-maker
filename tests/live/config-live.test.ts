// tests/live/config-live.test.ts
import { describe, it, expect } from 'vitest';
import { parseBotYaml } from '../../src/util/config.js';

describe('live config', () => {
  it('parses live section with safe defaults', () => {
    const cfg = parseBotYaml(`
assets: [BTC]
live:
  enabled: true
  assets: [BTC]
  max_deployed_usd: 50
  daily_loss_halt_usd: 20
  poll_interval_ms: 1500
`);
    expect(cfg.live.enabled).toBe(true);
    expect(cfg.live.assets).toEqual(['BTC']);
    expect(cfg.live.maxDeployedUsd).toBe(50);
    expect(cfg.live.dailyLossHaltUsd).toBe(20);
    expect(cfg.live.pollIntervalMs).toBe(1500);
  });

  it('defaults are conservative when live section absent', () => {
    const cfg = parseBotYaml(`assets: [BTC]`);
    expect(cfg.live.enabled).toBe(false);
    expect(cfg.live.maxDeployedUsd).toBe(50);
    expect(cfg.live.dailyLossHaltUsd).toBe(20);
    expect(cfg.live.assets).toEqual(['BTC']);
  });
});
