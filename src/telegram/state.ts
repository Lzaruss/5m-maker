/**
 * Shared mutable state surfaced between the orchestrator (writer) and the
 * Telegram commands (reader + writer for pause/resume/halt). Everything here
 * is process-local and lost on restart by design — Telegram state must not
 * outlive the running bot.
 */
export interface BotState {
  startedAtMs: number;
  enabled: boolean;
  /** When true, the orchestrator skips the QUOTE PHASE (no new BUYs/SELLs),
   *  but still runs flatten at close and respects all hard caps. Use to
   *  freeze activity without killing the process. */
  paused: boolean;
  /** Set by the orchestrator when daily/session halt is in effect; commands
   *  can also flip these on /halt and /resume. */
  haltedDaily: boolean;
  haltUntilMs: number;
  /** Set when session_loss_halt fires — the process is exiting, used to
   *  format an accurate `/status` in the few seconds before shutdown. */
  haltedSession: boolean;
  /** Latest snapshot of the running cumulative counters mirrored from the
   *  orchestrator so `/status` and `/pnl` can answer without scanning the log. */
  realizedTodayUsd: number;
  realizedSessionUsd: number;
  windowsCount: number;
  winningWindows: number;
  losingWindows: number;
  placeOkCount: number;
  placeFailCount: number;
  /** Last balance read at startup (informational). */
  startBalanceUsd: number;
  /** Last window summary (PnL, leg breakdown) for /last. */
  lastWindow?: {
    ts: number;
    asset: string;
    yesToken: string;
    noToken: string;
    windowPnl: number;
    yesWon: boolean | null;
  };
}

export function emptyState(): BotState {
  return {
    startedAtMs: Date.now(),
    enabled: false,
    paused: false,
    haltedDaily: false,
    haltUntilMs: 0,
    haltedSession: false,
    realizedTodayUsd: 0,
    realizedSessionUsd: 0,
    windowsCount: 0,
    winningWindows: 0,
    losingWindows: 0,
    placeOkCount: 0,
    placeFailCount: 0,
    startBalanceUsd: NaN,
  };
}
