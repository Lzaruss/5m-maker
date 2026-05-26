# Live Maker Pilot (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live market-making bot that quotes BOTH sides of the current BTC 5-minute "Up or Down" market with real `postOnly` maker limit orders, capped to ~$50 deployed / −$20 daily loss, whose purpose is to measure REAL fills vs the simulator.

**Architecture:** Reuse the already-built and tested pure engine (`quoter`, `inventory`, `closeGate`) and the read-only `ClobMarketFeed`/`PriceFeed`/`gammaPoller`. Add a thin live layer: a signed CLOB client, a `postOnly` limit-order placer + canceller, a PURE order-reconciler (desired quotes → cancel/place actions), a PURE risk gate, a fill/inventory reconciler that polls the data-api, a close-window flattener, and an orchestrator wiring it together for the single active BTC window. Every action is appended to a JSONL event log for sim-vs-real comparison.

**Tech Stack:** TypeScript (ESM, strict), `@polymarket/clob-client-v2` (`createAndPostOrder` GTC + `postOnly`, `cancelOrders`, `cancelAll`, `getOpenOrders`), `@ethersproject/wallet`, `axios` (Gamma + data-api), `ws` (already used), `vitest`.

**Hard safety rails (non-negotiable, enforced in code):**
- `postOnly: true` on every quote → we are ALWAYS a maker, never accidentally a taker.
- `max_deployed_usd: 50` → never place an order if (live-order notional + |inventory| value) would exceed it.
- `daily_loss_halt_usd: 20` → at −$20 realized (UTC day): cancel everything, stop quoting until 00:00 UTC.
- Single asset (BTC), single window at a time.
- On shutdown (SIGINT/SIGTERM) and on every error path that exits: `cancelAll()`.
- `flatten_before_sec` (20s): stop quoting, cancel resting orders, flatten oversized inventory.

---

## File Structure

```
5m-maker/
  .env                         # COPY from ../btc-5m-sniper/.env (same funded wallet)
  bot.yml                      # ADD a `live:` section
  src/
    clob/
      client.ts                # COPY from sniper: signed ClobClient v2 singleton + getUsdcBalance
      orders.ts                # NEW: placeLimitMaker (GTC postOnly), cancelByIds, cancelAll, listOpenOrders, marketFlatten (FOK)
      positions.ts             # COPY from sniper: read on-chain position (shares held) for a tokenId
      trades.ts                # NEW: poll data-api /trades?user= for our fills since a cursor
    live/
      riskGate.ts              # NEW PURE: checkGates(state) -> which sides allowed / halt
      reconciler.ts            # NEW PURE: reconcile(open, desired, tickSize) -> { toCancel, toPlace }
      accounting.ts            # NEW PURE: applyTrade(state, trade) -> realized PnL + inventory
    index.ts                   # NEW: orchestrator (the only file that does live I/O wiring)
    persistence/
      eventLog.ts              # NEW: append JSONL to data/live-events-<date>.jsonl
  tests/
    live/riskGate.test.ts
    live/reconciler.test.ts
    live/accounting.test.ts
  scripts/
    cancel-all.ts              # NEW: emergency "cancel every open order" one-shot
```

Already exist and are reused unchanged: `src/engine/quoter.ts`, `src/engine/inventory.ts`, `src/signals/priceFeed.ts`, `src/marketFeed/clobMarketFeed.ts`, `src/markets/gammaPoller.ts`, `src/util/{config,logger,assets}.ts`.

---

## Task 1: Config — add the `live:` section

**Files:**
- Modify: `src/util/config.ts`
- Modify: `bot.yml`
- Test: `tests/live/config-live.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/live/config-live.test.ts`
Expected: FAIL (`cfg.live` undefined).

- [ ] **Step 3: Implement**

Add to `src/util/config.ts` the interface and parsing:

```typescript
export interface LiveConfig {
  enabled: boolean;
  assets: Asset[];
  maxDeployedUsd: number;
  dailyLossHaltUsd: number;
  pollIntervalMs: number;
}
```

Add `live: LiveConfig;` to `BotConfig`. In `parseBotYaml`, after `risk`:

```typescript
  const lv = obj.live ?? {};
  const liveAssets: Asset[] = (Array.isArray(lv.assets) && lv.assets.length ? lv.assets : ['BTC'])
    .map((a: any) => {
      const up = String(a).toUpperCase();
      if (!isAsset(up)) throw new Error(`Unknown live asset: ${a}`);
      return up;
    });
  const live: LiveConfig = {
    enabled: lv.enabled === true,
    assets: liveAssets,
    maxDeployedUsd: lv.max_deployed_usd ?? 50,
    dailyLossHaltUsd: lv.daily_loss_halt_usd ?? 20,
    pollIntervalMs: lv.poll_interval_ms ?? 1500,
  };
  return { assets, maker, risk, live };
```

Add to `bot.yml`:

```yaml
live:
  enabled: false          # set true ONLY when you intend to trade real money
  assets: [BTC]
  max_deployed_usd: 50
  daily_loss_halt_usd: 20
  poll_interval_ms: 1500
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run tests/live/config-live.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/config.ts bot.yml tests/live/config-live.test.ts
git commit -m "feat(live): add live config section with conservative defaults"
```

---

## Task 2: Pure risk gate

**Files:**
- Create: `src/live/riskGate.ts`
- Test: `tests/live/riskGate.test.ts`

Decides, given current state, whether we may quote and on which sides. Pure, no I/O.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/live/riskGate.test.ts
import { describe, it, expect } from 'vitest';
import { checkGates, type RiskState } from '../../src/live/riskGate.js';

const base: RiskState = {
  realizedPnlTodayUsd: 0,
  deployedUsd: 0,
  inventoryUsd: 0,
  maxDeployedUsd: 50,
  dailyLossHaltUsd: 20,
  maxInventoryUsd: 15,
};

describe('checkGates', () => {
  it('allows both sides when flat and within limits', () => {
    const g = checkGates(base);
    expect(g.halted).toBe(false);
    expect(g.allowBuy).toBe(true);
    expect(g.allowSell).toBe(true);
  });

  it('halts at the daily loss cap', () => {
    const g = checkGates({ ...base, realizedPnlTodayUsd: -20 });
    expect(g.halted).toBe(true);
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(false);
  });

  it('blocks adding when deployed capital is at the cap', () => {
    const g = checkGates({ ...base, deployedUsd: 50 });
    expect(g.halted).toBe(false);
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(false);
  });

  it('blocks buys when long inventory at cap, still allows sells', () => {
    const g = checkGates({ ...base, inventoryUsd: 15 });
    expect(g.allowBuy).toBe(false);
    expect(g.allowSell).toBe(true);
  });

  it('blocks sells when short inventory at cap, still allows buys', () => {
    const g = checkGates({ ...base, inventoryUsd: -15 });
    expect(g.allowSell).toBe(false);
    expect(g.allowBuy).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/live/riskGate.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/live/riskGate.ts
export interface RiskState {
  realizedPnlTodayUsd: number; // negative = loss
  deployedUsd: number;         // live-order notional + |inventory| value
  inventoryUsd: number;        // signed: + long YES, - short
  maxDeployedUsd: number;
  dailyLossHaltUsd: number;    // positive number; halt when realized <= -this
  maxInventoryUsd: number;
}

export interface GateResult {
  halted: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  reason: string;
}

export function checkGates(s: RiskState): GateResult {
  if (s.realizedPnlTodayUsd <= -s.dailyLossHaltUsd) {
    return { halted: true, allowBuy: false, allowSell: false, reason: 'daily_loss_halt' };
  }
  if (s.deployedUsd >= s.maxDeployedUsd) {
    return { halted: false, allowBuy: false, allowSell: false, reason: 'max_deployed' };
  }
  const allowBuy = s.inventoryUsd < s.maxInventoryUsd;
  const allowSell = s.inventoryUsd > -s.maxInventoryUsd;
  return { halted: false, allowBuy, allowSell, reason: 'ok' };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/live/riskGate.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/live/riskGate.ts tests/live/riskGate.test.ts
git commit -m "feat(live): pure risk gate (daily halt, deployed cap, inventory cap)"
```

---

## Task 3: Pure order reconciler

**Files:**
- Create: `src/live/reconciler.ts`
- Test: `tests/live/reconciler.test.ts`

Given our current open orders and the desired quotes, decide which orders to cancel and which to place. Pure. Avoids cancel/replace churn when the desired price already rests.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/live/reconciler.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/live/reconciler.ts
export type Side = 'BUY' | 'SELL';
export interface LiveOrder { id: string; side: Side; price: number; size: number; }
export interface DesiredQuote { side: Side; price: number; size: number; }
export interface ReconcilePlan { toCancel: string[]; toPlace: DesiredQuote[]; }

const samePrice = (a: number, b: number, tick: number) => Math.abs(a - b) < tick / 2;

export function reconcile(open: LiveOrder[], desired: DesiredQuote[], tick: number): ReconcilePlan {
  const toCancel: string[] = [];
  const toPlace: DesiredQuote[] = [];

  for (const side of ['BUY', 'SELL'] as Side[]) {
    const want = desired.find((d) => d.side === side);
    const have = open.filter((o) => o.side === side);

    if (!want) {
      // side no longer desired -> cancel all on this side
      for (const o of have) toCancel.push(o.id);
      continue;
    }
    const match = have.find((o) => samePrice(o.price, want.price, tick));
    if (match) {
      // keep the matching order; cancel any other (stale/duplicate) orders this side
      for (const o of have) if (o.id !== match.id) toCancel.push(o.id);
    } else {
      // no order at the desired price -> cancel all this side and place fresh
      for (const o of have) toCancel.push(o.id);
      toPlace.push({ side, price: want.price, size: want.size });
    }
  }
  return { toCancel, toPlace };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/live/reconciler.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/live/reconciler.ts tests/live/reconciler.test.ts
git commit -m "feat(live): pure order reconciler (cancel/place, no churn)"
```

---

## Task 4: Pure fill accounting

**Files:**
- Create: `src/live/accounting.ts`
- Test: `tests/live/accounting.test.ts`

Folds our executed trades (from the data-api) into realized cash + share inventory. Realized PnL for the UTC day is derived from cash flow + settled positions.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/live/accounting.test.ts
import { describe, it, expect } from 'vitest';
import { emptyAccount, applyTrade, type Trade } from '../../src/live/accounting.js';

describe('accounting', () => {
  it('a buy then a sell at a higher price books positive cash', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    a = applyTrade(a, { id: 't2', side: 'SELL', price: 0.53, shares: 6, tsMs: 2 });
    expect(a.shares).toBeCloseTo(0, 6);
    expect(a.cashUsd).toBeCloseTo(6 * 0.53 - 6 * 0.49, 6);
  });

  it('ignores a trade id already seen (idempotent polling)', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    expect(a.shares).toBeCloseTo(6, 6);
  });

  it('realizedPnl marks residual shares at a settle price', () => {
    let a = emptyAccount();
    a = applyTrade(a, { id: 't1', side: 'BUY', price: 0.49, shares: 6, tsMs: 1 });
    expect(realized(a, 1)).toBeCloseTo(6 * 1 - 6 * 0.49, 6); // YES won
    expect(realized(a, 0)).toBeCloseTo(-6 * 0.49, 6);        // YES lost
  });
});

function realized(a: { cashUsd: number; shares: number }, settle: number): number {
  return a.cashUsd + a.shares * settle;
}
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/live/accounting.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/live/accounting.ts
export interface Trade { id: string; side: 'BUY' | 'SELL'; price: number; shares: number; tsMs: number; }
export interface Account { shares: number; cashUsd: number; seen: Set<string>; }

export function emptyAccount(): Account {
  return { shares: 0, cashUsd: 0, seen: new Set() };
}

export function applyTrade(a: Account, t: Trade): Account {
  if (a.seen.has(t.id)) return a;
  const seen = new Set(a.seen);
  seen.add(t.id);
  const signedShares = t.side === 'BUY' ? t.shares : -t.shares;
  const cashDelta = t.side === 'BUY' ? -t.price * t.shares : t.price * t.shares;
  return { shares: a.shares + signedShares, cashUsd: a.cashUsd + cashDelta, seen };
}

/** Realized+unrealized PnL marking residual shares at `settle` (0/1 or mid). */
export function pnl(a: Account, settle: number): number {
  return a.cashUsd + a.shares * settle;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/live/accounting.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/live/accounting.ts tests/live/accounting.test.ts
git commit -m "feat(live): pure fill accounting (idempotent trades, pnl)"
```

---

## Task 5: CLOB client + balance (copy from sniper)

**Files:**
- Create: `src/clob/client.ts` (copy of `../btc-5m-sniper/src/clob/client.ts`)
- Create: `.env` (copy of `../btc-5m-sniper/.env`)
- Modify: `package.json` (add deps `@polymarket/clob-client-v2`, `@ethersproject/wallet`, `ethers`)

- [ ] **Step 1: Copy the client and env**

```bash
cp ../btc-5m-sniper/src/clob/client.ts src/clob/client.ts
cp ../btc-5m-sniper/.env .env
```

(The client reads `loadEnv()` from `src/util/config.ts`. The 5m-maker config does not yet export `loadEnv`; copy the `EnvConfig`/`loadEnv`/`required` block from `../btc-5m-sniper/src/util/config.ts` into `src/util/config.ts`.)

- [ ] **Step 2: Add deps and install**

In `package.json` dependencies add:
```json
"@ethersproject/wallet": "^5.8.0",
"@polymarket/clob-client-v2": "^1.0.6",
"ethers": "^6.9.0"
```
Run: `npm install`

- [ ] **Step 3: Verify the client connects and reads balance**

Create throwaway `scripts/_balcheck.ts`:
```typescript
import { getUsdcBalance } from '../src/clob/client.js';
getUsdcBalance().then((b) => { console.log('USDC balance:', b); process.exit(0); });
```
Run: `npm run tsnode -- scripts/_balcheck.ts`
Expected: prints the wallet's USDC balance (should be ~100). Then `rm scripts/_balcheck.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/clob/client.ts src/util/config.ts package.json package-lock.json
git commit -m "feat(live): signed CLOB v2 client + USDC balance (from sniper)"
```
(Do NOT commit `.env` — it is gitignored.)

---

## Task 6: Live order adapter (postOnly maker + cancel + list + flatten)

**Files:**
- Create: `src/clob/orders.ts`
- Create: `src/clob/positions.ts` (copy from sniper)

No unit test (pure I/O wrapper); verified live in Task 9. Each function is a thin, logged wrapper.

- [ ] **Step 1: Copy positions reader**

```bash
cp ../btc-5m-sniper/src/clob/positions.ts src/clob/positions.ts
```

- [ ] **Step 2: Implement `src/clob/orders.ts`**

```typescript
import { Side, OrderType } from '@polymarket/clob-client-v2';
import { getClobClient } from './client.js';
import { logger } from '../util/logger.js';

export interface PlacedOrder { orderId: string; side: 'BUY' | 'SELL'; price: number; size: number; }

/** Place a resting maker limit order. postOnly=true => rejected if it would cross
 *  the book, so we can NEVER accidentally pay a taker fee. */
export async function placeLimitMaker(
  tokenId: string,
  side: 'BUY' | 'SELL',
  price: number,
  sizeShares: number,
): Promise<PlacedOrder | null> {
  try {
    const c = getClobClient();
    const result: any = await (c as any).createAndPostOrder(
      { tokenID: tokenId, price, size: Number(sizeShares.toFixed(2)), side: side === 'BUY' ? Side.BUY : Side.SELL },
      { tickSize: '0.01' },
      OrderType.GTC,
      true, // postOnly
    );
    const orderId = String(result?.orderID ?? result?.order_id ?? '');
    if (!orderId || result?.success === false) {
      logger.warn({ tokenId: tokenId.slice(0, 10), side, price, err: result?.errorMsg }, 'placeLimitMaker rejected');
      return null;
    }
    return { orderId, side, price, size: sizeShares };
  } catch (err: any) {
    logger.error({ side, price, err: err.message }, 'placeLimitMaker failed');
    return null;
  }
}

export async function cancelByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await (getClobClient() as any).cancelOrders(ids);
  } catch (err: any) {
    logger.error({ ids, err: err.message }, 'cancelByIds failed');
  }
}

export async function cancelAll(): Promise<void> {
  try {
    await (getClobClient() as any).cancelAll();
    logger.info('cancelAll done');
  } catch (err: any) {
    logger.error({ err: err.message }, 'cancelAll failed');
  }
}

export interface OpenOrderLite { id: string; side: 'BUY' | 'SELL'; price: number; size: number; }

export async function listOpenOrders(tokenId: string): Promise<OpenOrderLite[]> {
  try {
    const resp: any = await (getClobClient() as any).getOpenOrders({ asset_id: tokenId });
    const arr: any[] = Array.isArray(resp) ? resp : (resp?.data ?? resp?.orders ?? []);
    return arr.map((o) => ({
      id: String(o.id ?? o.orderID ?? ''),
      side: String(o.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(o.price),
      // remaining size = original - matched
      size: Number(o.original_size ?? o.size ?? 0) - Number(o.size_matched ?? 0),
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, 'listOpenOrders failed');
    return [];
  }
}

/** Aggressive FOK flatten of residual inventory at window close (taker — fee applies). */
export async function marketFlatten(tokenId: string, side: 'BUY' | 'SELL', amount: number): Promise<boolean> {
  try {
    const c = getClobClient();
    const result: any = await (c as any).createAndPostMarketOrder(
      { tokenID: tokenId, amount: Number(amount.toFixed(2)), side: side === 'BUY' ? Side.BUY : Side.SELL, orderType: OrderType.FOK },
      { tickSize: '0.01' },
      OrderType.FOK,
    );
    return !(result?.error || result?.success === false);
  } catch (err: any) {
    logger.error({ side, amount, err: err.message }, 'marketFlatten failed');
    return false;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` → Expected: clean (EXIT 0).

- [ ] **Step 4: Commit**

```bash
git add src/clob/orders.ts src/clob/positions.ts
git commit -m "feat(live): postOnly maker orders, cancel, list, FOK flatten"
```

---

## Task 7: Fills poller (data-api) + event log

**Files:**
- Create: `src/clob/trades.ts`
- Create: `src/persistence/eventLog.ts`

- [ ] **Step 1: Implement `src/persistence/eventLog.ts`**

```typescript
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';

let stream: WriteStream | null = null;
function out(): WriteStream {
  if (!stream) {
    mkdirSync(resolve('data'), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    stream = createWriteStream(resolve('data', `live-events-${date}.jsonl`), { flags: 'a' });
  }
  return stream;
}
export function logEvent(ev: Record<string, unknown>): void {
  out().write(JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
}
export async function closeLog(): Promise<void> {
  await new Promise<void>((r) => (stream ? stream.end(() => r()) : r()));
}
```

- [ ] **Step 2: Implement `src/clob/trades.ts`**

```typescript
import axios from 'axios';
import { logger } from '../util/logger.js';
import { loadEnv } from '../util/config.js';
import type { Trade } from '../live/accounting.js';

const DATA_API = 'https://data-api.polymarket.com';

/** Fetch our executed trades for a token since `sinceMs`. Maps to accounting.Trade. */
export async function fetchOurTrades(tokenId: string, sinceMs: number): Promise<Trade[]> {
  const user = loadEnv().clobFunderAddress;
  try {
    const { data } = await axios.get(`${DATA_API}/trades`, { params: { user, limit: 200 }, timeout: 15000 });
    const arr: any[] = Array.isArray(data) ? data : (data?.trades ?? data?.data ?? []);
    const out: Trade[] = [];
    for (const r of arr) {
      const asset = String(r.asset ?? r.asset_id ?? r.tokenId ?? '');
      if (asset !== tokenId) continue;
      const tsMs = Number(r.timestamp ?? 0) > 1e12 ? Number(r.timestamp) : Number(r.timestamp ?? 0) * 1000;
      if (tsMs <= sinceMs) continue;
      out.push({
        id: String(r.transactionHash ?? r.id ?? `${asset}-${tsMs}-${r.price}-${r.size}`),
        side: String(r.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        price: Number(r.price),
        shares: Number(r.size),
        tsMs,
      });
    }
    return out;
  } catch (err: any) {
    logger.error({ err: err.message }, 'fetchOurTrades failed');
    return [];
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/clob/trades.ts src/persistence/eventLog.ts
git commit -m "feat(live): data-api fills poller + JSONL event log"
```

---

## Task 8: Emergency cancel-all script

**Files:**
- Create: `scripts/cancel-all.ts`
- Modify: `package.json` scripts (`"cancel-all": "npm run tsnode -- scripts/cancel-all.ts"`)

- [ ] **Step 1: Implement**

```typescript
// scripts/cancel-all.ts — panic button: cancel every open order on the account.
import { cancelAll } from '../src/clob/orders.js';
cancelAll().then(() => { console.log('All open orders cancelled.'); process.exit(0); });
```

- [ ] **Step 2: Add npm script**, then commit.

```bash
git add scripts/cancel-all.ts package.json
git commit -m "feat(live): emergency cancel-all script"
```

---

## Task 9: Orchestrator (wires everything for one BTC window)

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` scripts (`"start": "npm run tsnode -- src/index.ts"`)

No unit test — this is the I/O wiring. It is verified live in Task 10 with real $. Logic it depends on (`computeQuotes`, `reconcile`, `checkGates`, `applyTrade`, `closeGate`) is already unit-tested.

- [ ] **Step 1: Implement the orchestrator**

Behavior (single BTC window at a time):
1. Guard: refuse to run unless `cfg.live.enabled === true`; log the wallet balance at start.
2. Start `PriceFeed` for BTC (Binance) for the adverse guard.
3. Loop forever:
   a. `fetchMarkets(['BTC'], 5)` → take the soonest-resolving active market = current window. If none, wait 2s.
   b. Reset per-window `Account` (`emptyAccount()`), `sinceMs = Date.now()`.
   c. Subscribe `ClobMarketFeed` to the window's `yesTokenId`.
   d. On each book update (and every `pollIntervalMs` tick):
      - `fetchOurTrades(token, sinceMs)` → `applyTrade` for each; advance `sinceMs`; log fills.
      - compute `timeToResolveSec`.
      - if `timeToResolveSec <= flattenBeforeSec`: cancel resting orders; if `|inventoryUsd| > flattenIfNetAboveUsd` call `marketFlatten`; stop quoting for this window.
      - else: build `RiskState` (realized day PnL across windows, deployedUsd = open-order notional + |inventory| value, inventoryUsd), `checkGates`. If halted → `cancelAll`, sleep until next UTC day.
      - `computeQuotes(...)` with current book + inventory + btcR30. Drop the buy side if `!allowBuy`, sell side if `!allowSell`.
      - `listOpenOrders(token)` → `reconcile(open, desired, 0.01)` → `cancelByIds(toCancel)`, then `placeLimitMaker(...)` for each `toPlace` (re-check deployed cap before each place).
   e. After `resolveAt + 60s`: read resolution (reuse `fetchResolution` from gammaPoller); realize window PnL into the day's running total; log `window_result`. Unsubscribe; go to next window.
4. `SIGINT`/`SIGTERM`/`uncaughtException`: `await cancelAll()`, `await closeLog()`, exit.

Use `logEvent` for: `start`, `quote` (desired), `place`, `cancel`, `fill`, `flatten`, `halt`, `window_result`, `shutdown`. These mirror the simulator's vocabulary so the two can be compared.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts package.json
git commit -m "feat(live): orchestrator for single BTC 5m maker window"
```

---

## Task 10: Live smoke + guarded go-live

**Files:** none (operational).

- [ ] **Step 1: Pre-flight with `enabled:false`**

With `live.enabled: false` in `bot.yml`, run `npm start`. Expected: it logs balance, discovers the BTC window, computes quotes, and logs intended `place`/`cancel` actions but **refuses to place** (enabled guard). Confirm the quote prices/sizes look sane in `data/live-events-<date>.jsonl`.

- [ ] **Step 2: One-order live test**

Temporarily set `max_deployed_usd: 6` and `live.enabled: true`. Run `npm start` for ONE window. Expected: exactly one small pair of resting orders appears; verify on polymarket.com that they are live maker orders at the logged prices. `Ctrl+C` → confirm `cancelAll` fires and the orders vanish. Run `npm run cancel-all` as belt-and-suspenders.

- [ ] **Step 3: Full pilot**

Set `max_deployed_usd: 50`, `daily_loss_halt_usd: 20`, `quote_size_usd: 3`, `assets: [BTC]`, `live.enabled: true`. Run `npm start`. Monitor `data/live-events-*.jsonl` and the wallet. Stop anytime with `Ctrl+C` (auto-cancel) or `npm run cancel-all`.

- [ ] **Step 4: Compare real vs sim**

After a few hours, compare realized fills/PnL in `live-events` against the simulator's prediction for the same window timestamps. This is the whole point of the pilot: calibrate the queue/fill assumption.

---

## Self-Review notes

- **Spec coverage:** quoting both sides (Task 9 via `computeQuotes`), postOnly maker (Task 6), inventory skew/adverse guard (reused `quoter`), hybrid flatten (Task 9 + `closeGate` + `marketFlatten`), risk caps (Task 2 + Task 9), rebate/fees are venue-side (not our code), asset filter = BTC only (config), event log for comparison (Task 7/9). Covered.
- **Type consistency:** `Side='BUY'|'SELL'`, `DesiredQuote{side,price,size}`, `LiveOrder{id,side,price,size}`, `Trade{id,side,price,shares,tsMs}`, `Account{shares,cashUsd,seen}` used consistently across tasks.
- **Safety:** `postOnly` + `cancelAll` on every exit + `max_deployed`/`daily_loss_halt` gates + `enabled:false` default + tiny-order smoke before full pilot.
- **Known limitation:** fills are polled from the data-api (~1.5s latency), so inventory/PnL lag real-time slightly; acceptable for a 5-minute-window pilot and flagged in the event log.
