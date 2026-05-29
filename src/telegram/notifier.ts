import type TelegramBot from 'node-telegram-bot-api';
import { logger } from '../util/logger.js';

/** Telegram-side outbound messages. All sends are try/catch so a Telegram
 *  outage NEVER kills the trading loop. */
export class Notifier {
  constructor(private readonly bot: TelegramBot | null, private readonly chatId: string) {}

  private async send(text: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'telegram send failed');
    }
  }

  async start(balanceUsd: number, sessionLossHaltUsd: number, dailyLossHaltUsd: number): Promise<void> {
    const lines = [
      '🟢 *5m-maker started*',
      `Balance: $${balanceUsd.toFixed(2)}`,
      `Daily halt: -$${dailyLossHaltUsd.toFixed(2)} (resumes at 00:00 UTC)`,
      `Session halt: -$${sessionLossHaltUsd.toFixed(2)} (exits process)`,
      '',
      'Send /help for commands.',
    ];
    await this.send(lines.join('\n'));
  }

  async dailyHalt(realizedTodayUsd: number, threshold: number): Promise<void> {
    await this.send(
      [
        '⏸️ *DAILY LOSS HALT*',
        `Realized today: $${realizedTodayUsd.toFixed(2)}`,
        `Threshold: -$${threshold.toFixed(2)}`,
        '',
        'Bot will resume at 00:00 UTC. Use /resume to lift manually.',
      ].join('\n'),
    );
  }

  async netWorthHalt(netDeltaUsd: number, threshold: number, netWorthUsd: number): Promise<void> {
    await this.send(
      [
        '🛑 *NET-WORTH HALT — process exiting*',
        `Real drawdown: ${netDeltaUsd >= 0 ? '+' : ''}$${netDeltaUsd.toFixed(2)} (net worth $${netWorthUsd.toFixed(2)})`,
        `Threshold: -$${threshold.toFixed(2)}`,
        '',
        'This reads the WALLET (cash + held tokens), not internal marks — a real',
        'loss, not an accounting artifact. Orders cancelled. Manual restart needed',
        'after reviewing /positions.',
      ].join('\n'),
    );
  }

  async sessionHalt(realizedSessionUsd: number, threshold: number): Promise<void> {
    await this.send(
      [
        '🛑 *SESSION LOSS HALT — process exiting*',
        `Realized since start: $${realizedSessionUsd.toFixed(2)}`,
        `Threshold: -$${threshold.toFixed(2)}`,
        '',
        'Manual restart required (`npm start`).',
      ].join('\n'),
    );
  }

  async cashFloor(cashUsd: number, floorUsd: number): Promise<void> {
    await this.send(
      [
        '🟡 *CASH FLOOR — BUYs suppressed*',
        `Liquid cash: $${cashUsd.toFixed(2)} < floor $${floorUsd.toFixed(2)}`,
        '',
        'Winners auto-redeem, so low cash means a real losing streak — not',
        'locked capital. SELL + flatten stay active; buying auto-resumes once',
        'cash recovers above the floor. Review /pnl and /positions first.',
      ].join('\n'),
    );
  }

  async fatal(err: string): Promise<void> {
    await this.send(
      ['❌ *FATAL — bot crashed*', '```', err.slice(0, 800), '```'].join('\n'),
    );
  }

  async shutdown(reason: string): Promise<void> {
    await this.send(`👋 *Shutdown* — reason: \`${reason}\``);
  }

  async takeProfitHalt(realizedSessionUsd: number, threshold: number): Promise<void> {
    await this.send(
      [
        '🟢 *TAKE-PROFIT STOP*',
        `Session profit: +$${realizedSessionUsd.toFixed(2)} ≥ target $${threshold.toFixed(2)}`,
        '',
        'Locking in gains — bot paused until 00:00 UTC. Use /resume to lift early.',
      ].join('\n'),
    );
  }

  async maxWindowsHalt(windowsCount: number, realizedSessionUsd: number): Promise<void> {
    const sign = realizedSessionUsd >= 0 ? '+' : '';
    await this.send(
      [
        '⏹️ *MAX-WINDOWS STOP*',
        `Completed ${windowsCount} window${windowsCount !== 1 ? 's' : ''} | session: ${sign}$${realizedSessionUsd.toFixed(2)}`,
        '',
        'Daily window limit reached — paused until 00:00 UTC. Use /resume to lift early.',
      ].join('\n'),
    );
  }

  async maxConsecLossesHalt(consecLosses: number, realizedSessionUsd: number): Promise<void> {
    const sign = realizedSessionUsd >= 0 ? '+' : '';
    await this.send(
      [
        '🔴 *CONSECUTIVE-LOSSES STOP*',
        `${consecLosses} losses in a row | session: ${sign}$${realizedSessionUsd.toFixed(2)}`,
        '',
        'Strategy may be out of regime — paused until 00:00 UTC. Use /resume to lift early.',
      ].join('\n'),
    );
  }

  async windowResult(
    windowPnl: number,
    realizedTodayUsd: number,
    yesWon: boolean | null,
    /** On-chain wallet change over the window (netWorth at close − netWorth at open).
     *  Null when the balance snapshot was unavailable. Used to cross-check the
     *  mark-based windowPnl so that a wrong resolution (e.g. Gamma showing the
     *  wrong winner briefly) is surfaced immediately rather than buried in the
     *  next periodic reality-check. */
    walletDeltaUsd?: number | null,
  ): Promise<void> {
    // UNRESOLVED windows: windowPnl is only a 0.5-fallback estimate AND is NOT
    // booked into `today` (deferred). Showing a confident "+$12.75" next to
    // "today $0.00" reads as a contradiction — and with positions now riding to
    // resolution the provisional figure can be large and meaningless. So we do
    // NOT print a dollar PnL for unresolved windows; the real outcome lands in
    // net worth via auto-redeem and the periodic reality check.
    if (yesWon === null) {
      await this.send(
        `⏳ Window pending resolution — not booked yet | today: $${realizedTodayUsd.toFixed(2)} (mark)`,
      );
      return;
    }
    // RESOLVED: settle is the true 0/1 outcome, so windowPnl is real PnL (given
    // accurate share tracking). `realizedTodayUsd` is the running mark total.
    // When a wallet snapshot is available, use the REAL wallet movement for the
    // lead emoji and flag any mark/wallet mismatch immediately.
    const outcome = yesWon ? 'YES (Up)' : 'NO (Down)';
    const pnlSign = (n: number) => (n >= 0 ? '+' : '');
    let walletLine = '';
    let mismatchWarning = '';
    if (walletDeltaUsd != null) {
      walletLine = ` | wallet: ${pnlSign(walletDeltaUsd)}$${walletDeltaUsd.toFixed(2)}`;
      // Flag when mark and wallet disagree by more than $0.50 AND point in
      // opposite directions. This is the "false-win" scenario.
      const signDiffers =
        Math.sign(windowPnl) !== 0 &&
        Math.sign(walletDeltaUsd) !== 0 &&
        Math.sign(windowPnl) !== Math.sign(walletDeltaUsd);
      const largeDiff = Math.abs(windowPnl - walletDeltaUsd) >= 0.5;
      if (signDiffers || largeDiff) {
        mismatchWarning = ` ⚠️ mark/wallet gap $${Math.abs(windowPnl - walletDeltaUsd).toFixed(2)}`;
      }
    }
    // Drive the emoji from the wallet when available (ground truth) so that a
    // wrong mark never shows a green when the wallet is in the red.
    const realPnl = walletDeltaUsd ?? windowPnl;
    const emoji = realPnl >= 0 ? '🟢' : '🔴';
    await this.send(
      `${emoji} Window ${pnlSign(windowPnl)}$${windowPnl.toFixed(2)} (mark)${walletLine}${mismatchWarning} | today: $${realizedTodayUsd.toFixed(2)} (mark) | ${outcome}`,
    );
  }

  /**
   * Pushed reality check: the on-chain net worth (cash + held token value) vs
   * the bot's internal mark P&L. A large positive gap means "profit" is locked
   * in unredeemed tokens or was over-counted — exactly the divergence that made
   * a wall of green windows hide a falling balance. Called periodically by the
   * orchestrator. All fields are pre-fetched by the caller so this never does
   * I/O itself.
   */
  async netWorthCheck(p: {
    netWorthUsd: number;
    startBalanceUsd: number;
    cashUsd: number;
    redeemableUsd: number;
    redeemableCount: number;
    markSessionUsd: number;
  }): Promise<void> {
    const netDelta = p.netWorthUsd - p.startBalanceUsd;
    // gap > 0  => mark claims MORE profit than the wallet shows (overstated, bad).
    // gap < 0  => wallet is ahead of mark (mark conservative — e.g. unresolved
    //             windows whose real PnL landed in net worth but was never booked).
    const gap = p.markSessionUsd - netDelta;
    // Only flag the dangerous direction (mark overstating real money).
    const flag = gap >= 5 ? '⚠️ ' : '';
    let gapLine: string;
    if (gap >= 0.01) {
      gapLine = `⚠️ Mark overstates wallet by $${gap.toFixed(2)} (unredeemed / over-counted).`;
    } else if (gap <= -0.01) {
      gapLine = `✅ Wallet ahead of mark by $${(-gap).toFixed(2)} (mark conservative).`;
    } else {
      gapLine = '✅ Mark matches wallet.';
    }
    const lines = [
      `${flag}*Reality check*`,
      `Net worth: $${p.netWorthUsd.toFixed(2)} (${netDelta >= 0 ? '+' : ''}$${netDelta.toFixed(2)} vs start)`,
      `Cash: $${p.cashUsd.toFixed(2)} | Redeemable: $${p.redeemableUsd.toFixed(2)} (${p.redeemableCount})`,
      `Mark P&L: ${p.markSessionUsd >= 0 ? '+' : ''}$${p.markSessionUsd.toFixed(2)} session`,
      gapLine,
    ];
    await this.send(lines.join('\n'));
  }
}
