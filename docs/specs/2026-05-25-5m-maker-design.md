# 5m Maker — Design

**Status:** Approved 2026-05-25
**Scope:** Standalone TypeScript project in `crypto/5m-maker/` that **market-makes** the Polymarket crypto "Up or Down" 5-minute markets — quoting both sides to earn the spread, the structural opposite of the existing taker `btc-5m-sniper`.

---

## 1. Motivation

`btc-5m-sniper` is a selective **taker**: it crosses the book ~5 times/day in the final seconds of a window when BTC momentum and book consensus align. Its own data shows that loosening its filters to trade more is −EV (the 0.06–0.10 edge bucket lost −$11.71; NO/5m lost −$8.29). So "trade all day" cannot come from relaxing the sniper.

A market maker earns a **different** edge — the bid/ask spread — and is naturally active all day without predicting direction. The user wants a second bot running in parallel that captures this edge.

## 2. Validate-before-build

Market-making P&L depends on **whether resting limit orders get crossed**, which cannot be read from book snapshots alone — it depends on the trade tape (actual executions). Therefore this project is built in two phases, and **no live trading bot is written until validation shows a positive, robust edge**:

- **Phase A — Recorder:** record the real market tape (book snapshots + executed trades) plus synchronized Binance BTC prices to JSONL.
- **Phase B — Simulator:** replay the tape through the pure quoting engine, model fills conservatively, and report P&L and risk metrics across parameter settings.

The live bot (Phase C) is out of scope for this spec and only proceeds if Phase B validates.

## 3. Goals & non-goals

**Goals (this spec):**
- Record a faithful market tape for 5-minute crypto markets via the Polymarket CLOB market WebSocket.
- A pure, tested quoting engine (`quoter`) and inventory model reusable by both simulator and future live bot.
- An offline simulator that replays the tape and reports P&L, fill count, inventory profile, adverse-selection count, and sensitivity to `half_spread`.

**Non-goals:**
- Live order placement / the production bot (Phase C, separate spec).
- Multi-strategy framework, dashboard, Telegram control.
- Perfect microstructure simulation (queue position, partial-fill priority). We use a conservative fill model and document its assumptions.

## 4. Strategy

A market maker quotes a resting **bid** (price to buy YES) below and an **ask** (price to sell YES) above a reference price. It profits when both sides get crossed by impatient flow (a complete "round" earns the spread) regardless of BTC direction. Its risk is **adverse selection**: informed flow near resolution crosses one side only, leaving the maker holding inventory that resolves against it on a binary 0/1 market.

The engine has three components, all combined in the pure `computeQuotes`:

1. **Mid anchor + spread** — quote `mid ± halfSpread`. Wider = more profit per round, fewer fills; the key tuning knob.
2. **Inventory skew** (simplified Avellaneda–Stoikov) — shift both quotes against current inventory so the maker auto-reverts toward neutral. Long YES → shift down (easier to sell, harder to buy more).
3. **Adverse-selection guard** (uses Binance feed) — when `|btcReturn30s|` is large (informed-flow regime), **widen** the spread; beyond a stronger threshold, **pull** the vulnerable side entirely (BTC up hard → pull the YES ask).

**Hybrid window close** — in the last `flatten_before_sec` seconds, stop quoting; if `|net inventory|` exceeds `flatten_if_net_above_usd`, cross the book to flatten (pay spread, avoid binary risk); otherwise let the small residual resolve.

## 5. Architecture

```
crypto/5m-maker/
  src/
    util/
      logger.ts          # copied from sniper (pino + ring buffer)
      assets.ts          # copied from sniper (asset <-> binance symbol)
      config.ts          # NEW maker config loader (.env + bot.yml)
    signals/
      priceFeed.ts       # copied from sniper (Binance combined WS, getReturn)
    markets/
      gammaPoller.ts     # adapted from sniper: discover active 5m markets
    marketFeed/
      clobMarketFeed.ts  # NEW: CLOB market WS (book + last_trade_price)
    engine/
      quoter.ts          # NEW pure: computeQuotes(input, cfg) -> QuoteDecision
      inventory.ts       # NEW pure: applyFill / mark / closeGate helpers
  scripts/
    recorder.ts          # Phase A: write data/tape-<date>.jsonl
    simulate.ts          # Phase B: replay tape -> P&L report
  tests/
    engine/quoter.test.ts
    engine/inventory.test.ts
  data/                  # gitignored tapes + outputs
  bot.yml
  .env / .env.example
  package.json / tsconfig.json / vitest.config.ts
```

### CLOB market WebSocket

`wss://ws-subscriptions-clob.polymarket.com/ws/market`. Subscribe with `{ type: "market", assets_ids: [...tokenIds] }`. Emits per-asset events: `book` (full bids/asks), `price_change` (deltas), `last_trade_price` (executed price/size/side). The recorder persists `book` and `last_trade_price` events; `last_trade_price` is the trade tape the simulator needs.

**Trade-tape note:** the venue's public market channel is the only market-wide trade source (the data-api `/trades` endpoint is per-wallet). If `last_trade_price` coalesces same-price prints, the tape can *undercount* fills — a conservative bias (fewer simulated fills than reality), acceptable for a go/no-go decision.

**Resolution capture:** after a window's resolve time, the recorder reads the outcome via Gamma `?clob_token_ids=<yesToken>` — `outcomePrices` converge to ~0/1 even while the market still reports `closed:false` (e.g. `["0.005","0.995"]` = Down won). It writes a `resolution` event (`yesWon`) so the simulator can settle leftover inventory at the real 0/1 rather than approximating. This cannot be reconstructed after the fact, so it must be recorded live.

**Enriched tape (2026-05-25 review):** to enable studying the real picture, each tape line now also carries:
- `market`: `rewardsMaxSpread`, `rewardsMinSize`, `gammaSpread` — the liquidity-rewards config and reference spread (from Gamma).
- `book`: full depth `bids`/`asks` (top 10 levels each side as `[price, size]`) alongside the top-of-book scalars — for measuring competing liquidity within the reward band and queue position.

These are additive (the scalar `bid`/`ask` fields are unchanged), so the current simulator keeps working without modification.

## 6. Pure engine contracts

```typescript
// quoter.ts
interface QuoteInput {
  bestBid: number; bestAsk: number;          // top of book for the YES token
  inventoryShares: number;                   // + long YES, - short
  inventoryUsd: number;                      // signed notional at mid
  btcReturn30s: number | null;               // from Binance feed; null if stale
  timeToResolveSec: number;
}
type QuoteSide = { price: number; sizeShares: number } | null;
type QuoteDecision =
  | { action: 'quote'; bid: QuoteSide; ask: QuoteSide; reason: string }
  | { action: 'no_quote'; reason: string };
```

Decision flow: (1) `timeToResolveSec <= flattenBeforeSec` → `no_quote('flatten_window')`. (2) reservation = `mid - skew`, where `skew = inventorySkewK * halfSpread * clamp(inventoryUsd/maxInventoryUsd,-1,1)`. (3) `effHalf = halfSpread * (|r30|>=widen ? widenFactor : 1)`. (4) `bid = reservation - effHalf`, `ask = reservation + effHalf`. (5) adverse pull: `r30 >= pull` → drop ask; `r30 <= -pull` → drop bid. (6) inventory cap: `inventoryUsd >= maxInventoryUsd` → drop bid; `<= -maxInventoryUsd` → drop ask. (7) round to tick, clamp `[0.01,0.99]`; if `bid >= ask` → `no_quote('crossed')`. Sizes: `sizeShares = quoteSizeUsd / price`.

```typescript
// inventory.ts — pure helpers used by simulator and live bot
applyFill(state, fill): InventoryState          // updates shares + avg cost + realized PnL
closeGate(state, book, timeLeftSec, cfg): { action: 'flatten' | 'hold'; reason: string }
```

## 7. Simulator fill model (conservative)

Replay events in timestamp order. On each `book` update, recompute desired quotes. On each `last_trade_price` (price `p`, size `s`):
- if our live **bid** exists and `p <= bidPrice` → we buy `min(s, bidShares)` at `bidPrice`;
- if our live **ask** exists and `p >= askPrice` → we sell `min(s, askShares)` at `askPrice`;
- trades strictly inside our spread → no fill.

We never fill more than the real traded volume, so simulated activity cannot exceed what actually happened. At `flatten_before_sec` the close logic flattens large inventory at the touch (best bid/ask). Residual inventory is settled at the **real 0/1 outcome** when the recorder captured a `resolution` event; otherwise it falls back to the last observed mid. At equal timestamps, trades are processed before book updates so a fill is matched against the quote that was actually resting (no look-ahead).

**Phantom-liquidity caveat:** our simulated resting orders do not alter the recorded book or consume real depth ahead of us (queue position is assumed front-of-line). This is the standard optimistic bias of replay-based MM backtests; the conservative `last_trade_price` fill cap partially offsets it. Treat simulated P&L as an upper-ish bound and require a clear margin before going live.

**Reported metrics:** total P&L, completed rounds, fills, mean/max |inventory|, times pulled by adverse guard, times left holding at flatten, P&L per window, and a sweep of P&L vs `half_spread`.

## 8. Config (`bot.yml`, conservative defaults)

```yaml
assets: [BTC, ETH, SOL, XRP, BNB, DOGE]
maker:
  half_spread: 0.03
  quote_size_usd: 3.0
  inventory_skew_k: 0.5
  widen_factor: 2.0
  max_inventory_usd: 15.0
  tick_size: 0.01
  adverse_guard:
    btc_return_30s_widen: 0.0005
    btc_return_30s_pull: 0.0010
  flatten_before_sec: 20
  flatten_if_net_above_usd: 6.0
risk:
  daily_loss_limit_usd: 10.0
  max_committed_usd: 12.0
```

## 9. Testing

Engine functions are pure and tested exhaustively (quote placement, skew direction, widen, pull, inventory caps, crossed-skip, fill accounting, closeGate flatten threshold). Adapters (`clobMarketFeed`, `gammaPoller`) are exercised live by the recorder. The simulator is validated on a small hand-built synthetic tape with a known expected P&L before being trusted on real tapes.

## 10. Open questions

- Exact `half_spread` / guard thresholds: to be calibrated from the first recorded tapes via `simulate.ts`.
- Tick size per market: assumed 0.01; recorder will confirm from `tick_size_change` events.

**Resolved during review (2026-05-25):** residual-inventory settlement now uses the real 0/1 outcome captured by the recorder (`resolution` events), with mark-to-mid only as a fallback when an outcome was not recorded.

## 11. Research findings (2026-05-25) — to study before committing to a plan

External research (Polymarket docs, the official `Polymarket/poly-market-maker` keeper, community write-ups) surfaced facts that may reframe the edge. **Recorded here for study; no paradigm change made yet.**

- **5m crypto markets are in the Liquidity Rewards program.** Live sample: `rewardsMaxSpread = 4.5¢`, `rewardsMinSize = 50` shares; daily USDC payout with quadratic tightness scoring. Orders within 4.5¢ of mid and ≥50 shares earn rewards.
- **The book is already ~1¢ tight** (`spread = 0.01`). Spread capture is therefore marginal; for these markets the dominant MM income is likely the **rewards**, not the spread.
- **Sizing tension:** earning rewards needs ≥50-share orders (~$25 at price 0.5) — far above the current conservative `quote_size_usd: 3`, with a correspondingly larger inventory/capital profile.
- **Fees:** makers pay $0 (and may earn rebates); takers on crypto pay up to 1.8% (modeled on flatten orders). The simulator does **not** yet model rewards income.
- **5m is the hard case:** the official keeper syncs every 30s (built for long-lived markets); community notes that 5m favors aggressive taker entries due to adverse selection.

**Implication for the study phase:** the current simulator measures spread P&L (marginal here) and ignores rewards (likely the real edge). Interpret current backtest numbers as a spread-only lower bound. Candidate next analyses (not yet built): model reward accrual from recorded depth + reward params; reassess order sizing and inventory limits.
