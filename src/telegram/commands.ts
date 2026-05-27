import type TelegramBot from 'node-telegram-bot-api';
import { isAuthorized } from './bot.js';
import { logger } from '../util/logger.js';
import type { BotState } from './state.js';
import { getUsdcBalance } from '../clob/client.js';
import { cancelAll } from '../clob/orders.js';
import { logEvent } from '../persistence/eventLog.js';

export interface CommandsDeps {
  bot: TelegramBot;
  chatId: string;
  state: BotState;
  cfg: {
    dailyLossHaltUsd: number;
    sessionLossHaltUsd: number;
    maxDeployedUsd: number;
  };
  /** Called by /stop. The orchestrator does cancel + flatten + closeLog +
   *  exit; here we just request it. */
  requestShutdown: (reason: string) => void;
}

function fmtUsd(n: number): string {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

export function registerCommands(d: CommandsDeps): void {
  const reply = async (text: string): Promise<void> => {
    try {
      await d.bot.sendMessage(d.chatId, text, { parse_mode: 'Markdown' });
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'telegram reply failed');
    }
  };

  const guard = (msg: TelegramBot.Message, fn: () => Promise<void>) => {
    if (!isAuthorized(msg.chat.id, d.chatId)) return;
    fn().catch((e) => logger.error({ err: (e as Error).message }, 'telegram command failed'));
  };

  d.bot.onText(/^\/help/, (msg) =>
    guard(msg, async () => {
      const text = [
        '*5m-maker bot*',
        '',
        '📊 *Info*',
        '`/status` — uptime + PnL + halt state',
        '`/balance` — current USDC',
        '`/pnl` — today + session realized',
        '`/config` — show caps in force',
        '`/last` — last window result',
        '',
        '🎛 *Control*',
        '`/pause` — skip quote phase (still flatten + redeem)',
        '`/resume` — resume quoting',
        '`/cancel_all` — cancel every open order (positions remain)',
        '`/stop` — graceful shutdown (cancel + flatten + exit)',
      ].join('\n');
      await reply(text);
    }),
  );

  d.bot.onText(/^\/status/, (msg) =>
    guard(msg, async () => {
      const s = d.state;
      const winRate = s.windowsCount > 0 ? Math.round((100 * s.winningWindows) / s.windowsCount) : 0;
      const placeTotal = s.placeOkCount + s.placeFailCount;
      const failRate = placeTotal > 0 ? Math.round((100 * s.placeFailCount) / placeTotal) : 0;
      const haltLine = s.haltedSession
        ? '🛑 SESSION HALT (exiting)'
        : s.haltedDaily
          ? `⏸️ DAILY HALT — resumes ${new Date(s.haltUntilMs).toISOString().slice(11, 16)} UTC`
          : s.paused
            ? '⏸️ PAUSED (manual)'
            : '🟢 ACTIVE';
      const text = [
        '*Status*',
        haltLine,
        `Uptime: ${fmtUptime(Date.now() - s.startedAtMs)}`,
        `Today: ${fmtUsd(s.realizedTodayUsd)} | Session: ${fmtUsd(s.realizedSessionUsd)}`,
        `Windows: ${s.windowsCount} (${s.winningWindows}W/${s.losingWindows}L, ${winRate}% win)`,
        `Places: ${s.placeOkCount}/${placeTotal} ok (${failRate}% fail)`,
      ].join('\n');
      await reply(text);
    }),
  );

  d.bot.onText(/^\/balance/, (msg) =>
    guard(msg, async () => {
      try {
        const bal = await getUsdcBalance();
        const delta = bal - d.state.startBalanceUsd;
        await reply(
          `💰 Balance: $${bal.toFixed(2)}\nStart: $${d.state.startBalanceUsd.toFixed(2)} (${fmtUsd(delta)})`,
        );
      } catch (err: any) {
        await reply(`❌ Balance read failed: ${err.message}`);
      }
    }),
  );

  d.bot.onText(/^\/pnl/, (msg) =>
    guard(msg, async () => {
      const s = d.state;
      const text = [
        '*PnL*',
        `Today (UTC): ${fmtUsd(s.realizedTodayUsd)} / cap -$${d.cfg.dailyLossHaltUsd.toFixed(2)}`,
        `Session:     ${fmtUsd(s.realizedSessionUsd)} / cap -$${d.cfg.sessionLossHaltUsd.toFixed(2)}`,
        `Windows: ${s.winningWindows}W / ${s.losingWindows}L / ${s.windowsCount - s.winningWindows - s.losingWindows}flat`,
      ].join('\n');
      await reply(text);
    }),
  );

  d.bot.onText(/^\/config/, (msg) =>
    guard(msg, async () => {
      const text = [
        '*Caps in force*',
        `max_deployed_usd: $${d.cfg.maxDeployedUsd}`,
        `daily_loss_halt_usd: $${d.cfg.dailyLossHaltUsd}`,
        `session_loss_halt_usd: $${d.cfg.sessionLossHaltUsd}`,
      ].join('\n');
      await reply(text);
    }),
  );

  d.bot.onText(/^\/last/, (msg) =>
    guard(msg, async () => {
      const w = d.state.lastWindow;
      if (!w) {
        await reply('No completed windows yet this session.');
        return;
      }
      const outcome = w.yesWon === null ? '⚪ unresolved' : w.yesWon ? '🟢 YES won' : '🔴 NO won';
      const when = new Date(w.ts).toISOString().slice(11, 19);
      await reply(
        `*Last window* (${when} UTC)\nPnL: ${fmtUsd(w.windowPnl)}\nOutcome: ${outcome}`,
      );
    }),
  );

  d.bot.onText(/^\/pause/, (msg) =>
    guard(msg, async () => {
      d.state.paused = true;
      logEvent({ kind: 'telegram_pause' });
      await reply('⏸️ Paused. The bot will stop opening new quotes but will still flatten at close.');
    }),
  );

  d.bot.onText(/^\/resume/, (msg) =>
    guard(msg, async () => {
      d.state.paused = false;
      if (d.state.haltedDaily) {
        d.state.haltedDaily = false;
        d.state.haltUntilMs = 0;
        logEvent({ kind: 'telegram_resume', wasDaily: true });
        await reply('▶️ Manual resume — daily halt cleared, quoting active.');
      } else {
        logEvent({ kind: 'telegram_resume', wasDaily: false });
        await reply('▶️ Resumed.');
      }
    }),
  );

  d.bot.onText(/^\/cancel_all/, (msg) =>
    guard(msg, async () => {
      try {
        await cancelAll();
        logEvent({ kind: 'telegram_cancel_all' });
        await reply('🧹 All open orders cancelled. Positions (if any) remain — bot will flatten or hold to resolution per config.');
      } catch (err: any) {
        await reply(`❌ cancelAll failed: ${err.message}`);
      }
    }),
  );

  d.bot.onText(/^\/stop/, (msg) =>
    guard(msg, async () => {
      logEvent({ kind: 'telegram_stop' });
      await reply('🛑 Stop requested — cancelling, flattening, and exiting…');
      d.requestShutdown('telegram_stop');
    }),
  );
}
