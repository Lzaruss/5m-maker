# scripts/archive — superseded analysis tools

One-off studies from earlier strategy iterations, kept for reference (re-runnable
against `data/tape-*.jsonl`) but moved out of the active `scripts/` dir. Not used
by the live bot. Archived 2026-05-31 during the momentum-trend cleanup.

- `edge-study.ts` — early calibration / favorite-longshot + R30 signal study.
- `backtest-pairs.ts` — backtest of the matched-pair MAKER (the original strategy).
- `backtest-harvester.ts` — backtest of the favorite-harvester.
- `lag-study.ts` — directional/lag taker study (killed it: market is efficient).
- `favorite-maker-sim.ts` — maker-fill sim that killed the maker-harvester variant.
- `all-yes-cut-sim.ts` — all-YES + loss-cut test (showed all-YES is a pure UP-rate bet).

The study that produced the LIVE strategy lives in active `scripts/`:
- `momentum-yes-sim.ts` — the cross-window momentum edge (current strategy).

Run any with: `npx tsx scripts/archive/<name>.ts [--asset BNB]`
