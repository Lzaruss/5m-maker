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

  async fatal(err: string): Promise<void> {
    await this.send(
      ['❌ *FATAL — bot crashed*', '```', err.slice(0, 800), '```'].join('\n'),
    );
  }

  async shutdown(reason: string): Promise<void> {
    await this.send(`👋 *Shutdown* — reason: \`${reason}\``);
  }

  async windowResult(windowPnl: number, realizedTodayUsd: number, yesWon: boolean | null): Promise<void> {
    const emoji = windowPnl > 0 ? '🟢' : windowPnl < 0 ? '🔴' : '⚪';
    const outcome = yesWon === null ? 'unresolved' : yesWon ? 'YES (Up)' : 'NO (Down)';
    await this.send(
      `${emoji} Window ${windowPnl >= 0 ? '+' : ''}$${windowPnl.toFixed(2)} | today: $${realizedTodayUsd.toFixed(2)} | ${outcome}`,
    );
  }
}
