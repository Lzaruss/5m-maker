import type TelegramBot from 'node-telegram-bot-api';
import { isAuthorized } from './bot.js';
import { logger } from '../util/logger.js';
import type { BotState } from './state.js';
import { getUsdcBalance } from '../clob/client.js';
import { getAccountValue } from '../clob/positions.js';
import { cancelAll } from '../clob/orders.js';
import { logEvent } from '../persistence/eventLog.js';

export interface CommandsDeps {
  bot: TelegramBot;
  chatId: string;
  state: BotState;
  cfg: {
    enabled: boolean;
    assets: readonly string[];
    dailyLossHaltUsd: number;
    sessionLossHaltUsd: number;
    maxDeployedUsd: number;
    quoteSizeUsd: number;
    maxBuyPrice: number;
    flattenBeforeSec: number;
    cashFloorUsd: number;
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
    // Drop messages sent before this process started. Telegram queues unread
    // commands (e.g. a /stop sent while the bot was offline) and delivers them
    // on the next polling session — without this check they fire immediately on
    // restart. msg.date is Unix seconds; startedAtMs is milliseconds.
    if (msg.date * 1000 < d.state.startedAtMs) return;
    fn().catch((e) => logger.error({ err: (e as Error).message }, 'telegram command failed'));
  };

  d.bot.onText(/^\/help/, (msg) =>
    guard(msg, async () => {
      // Use HTML parse_mode: MarkdownV1 has no backslash escaping, so
      // /cancel_all (with an underscore) triggers a "Can't find end of entity"
      // error when sent as Markdown. HTML mode treats _ as a plain character.
      const text = [
        '<b>5m-maker bot</b>',
        '',
        '📊 <b>Info</b>',
        '/status — uptime + PnL + halt state',
        '/balance — liquid USDC',
        '/pnl — cash vs mark vs net worth',
        '/positions — open on-chain positions + redeemable',
        '/config — show caps in force',
        '/last — last window result',
        '',
        '🎛 <b>Control</b>',
        '/pause — skip quote phase (still flattens at close)',
        '/resume — resume quoting',
        '/cancel_all — cancel every open order (positions remain)',
        '/stop — graceful shutdown (cancel + flatten + exit)',
      ].join('\n');
      try {
        await d.bot.sendMessage(d.chatId, text, { parse_mode: 'HTML' });
      } catch (err: any) {
        logger.warn({ err: (err as Error)?.message }, 'telegram reply failed');
      }
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
            : s.enabled
              ? '🟢 ACTIVE'
              : '🔬 DRY-RUN (live.enabled: false)';
      const text = [
        '*Status*',
        haltLine,
        `Uptime: ${fmtUptime(Date.now() - s.startedAtMs)}`,
        `Today (mark): ${fmtUsd(s.realizedTodayUsd)} | Session (mark): ${fmtUsd(s.realizedSessionUsd)}`,
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
      // Reality first: net worth = liquid cash + market value of held tokens.
      // The bot's INTERNAL mark P&L (realizedTodayUsd) marks resolved winners at
      // $1/share whether or not they were redeemed AND can include shares the
      // reconciler later corrects away — so it routinely overstates the truth.
      // We lead with the on-chain numbers and show the gap explicitly.
      let realityLines: string[];
      try {
        const av = await getAccountValue();
        const netDelta = Number.isFinite(s.startBalanceUsd) ? av.netWorthUsd - s.startBalanceUsd : NaN;
        const gap = s.realizedSessionUsd - netDelta;
        realityLines = [
          `Net worth: $${av.netWorthUsd.toFixed(2)}  (${Number.isFinite(netDelta) ? fmtUsd(netDelta) : '?'} vs start $${s.startBalanceUsd.toFixed(2)})`,
          `  ├ cash:       $${av.cashUsd.toFixed(2)}`,
          `  ├ positions:  $${av.positionValueUsd.toFixed(2)}  (${av.openCount} open)`,
          `  └ redeemable: $${av.redeemableUsd.toFixed(2)}  (${av.redeemableCount} won, not yet claimed)`,
          '',
          `Mark P&L (internal): ${fmtUsd(s.realizedSessionUsd)} session`,
          Number.isFinite(gap)
            ? gap >= 0.01
              ? `⚠️ Mark overstates on-chain by $${gap.toFixed(2)} — provisional windows or unredeemed tokens.`
              : gap <= -0.01
                ? `✅ On-chain ahead of mark by $${(-gap).toFixed(2)} — mark is conservative.`
                : `✅ Mark matches on-chain (gap < $0.01).`
            : `⚠️ Gap unknown — start balance not recorded.`,
        ];
      } catch (err: any) {
        // Fall back to the cash-only comparison if the data API is down.
        realityLines = [
          `Net worth: unavailable (${err?.message ?? 'fetch failed'})`,
          `Mark P&L (internal): ${fmtUsd(s.realizedSessionUsd)} session — NOT verified against chain`,
        ];
      }
      const text = [
        '*PnL — reality check*',
        ...realityLines,
        '',
        `Mark today: ${fmtUsd(s.realizedTodayUsd)} / halt -$${d.cfg.dailyLossHaltUsd.toFixed(2)}`,
        `Windows:    ${s.winningWindows}W / ${s.losingWindows}L / ${s.windowsCount - s.winningWindows - s.losingWindows}flat`,
      ].join('\n');
      await reply(text);
    }),
  );

  d.bot.onText(/^\/positions/, (msg) =>
    guard(msg, async () => {
      try {
        const av = await getAccountValue();
        if (av.openCount === 0) {
          await reply(`📭 No open positions.\n💰 Cash: $${av.cashUsd.toFixed(2)}`);
          return;
        }
        // Sort biggest-value first. Filter out dust positions ($0.00) that the
        // data API sometimes keeps alive briefly after a losing resolution.
        const sorted = [...av.positions]
          .filter((p) => p.currentValue >= 0.005)
          .sort((a, b) => b.currentValue - a.currentValue);
        const hiddenDust = av.positions.length - sorted.length;
        if (sorted.length === 0) {
          await reply(`💭 All ${av.positions.length} position(s) resolved to $0 — nothing to show.\n💰 Cash: $${av.cashUsd.toFixed(2)}`);
          return;
        }
        const lines = ['*Open positions* (by value)'];
        for (const p of sorted.slice(0, 15)) {
          const tag = p.redeemable ? '💵' : '⏳';
          lines.push(
            `${tag} ${p.outcome} ${p.size.toFixed(1)}sh @${p.avgPrice.toFixed(2)} → $${p.currentValue.toFixed(2)}`,
          );
        }
        if (sorted.length > 15) lines.push(`…and ${sorted.length - 15} more`);
        if (hiddenDust > 0) lines.push(`(${hiddenDust} zero-value position(s) hidden)`);
        lines.push('');
        lines.push(`Cash: $${av.cashUsd.toFixed(2)} | Positions: $${av.positionValueUsd.toFixed(2)}`);
        lines.push(`💵 Redeemable now: $${av.redeemableUsd.toFixed(2)} (${av.redeemableCount}) — claim to free capital`);
        lines.push(`Net worth: $${av.netWorthUsd.toFixed(2)}`);
        await reply(lines.join('\n'));
      } catch (err: any) {
        await reply(`❌ positions read failed: ${err.message}`);
      }
    }),
  );

  d.bot.onText(/^\/config/, (msg) =>
    guard(msg, async () => {
      const modeTag = d.state.enabled ? 'LIVE' : 'dry-run';
      const text = [
        `*Config* (${modeTag})`,
        `assets: ${d.cfg.assets.join(', ')}`,
        `quote_size_usd: $${d.cfg.quoteSizeUsd} | max_buy_price: ${d.cfg.maxBuyPrice}`,
        `flatten_before_sec: ${d.cfg.flattenBeforeSec}`,
        `cash_floor_usd: $${d.cfg.cashFloorUsd} | max_deployed_usd: $${d.cfg.maxDeployedUsd}`,
        `daily_loss_halt: -$${d.cfg.dailyLossHaltUsd} | session_loss_halt: -$${d.cfg.sessionLossHaltUsd}`,
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
        `*Last window* — ${w.asset} (${when} UTC)\nPnL: ${fmtUsd(w.windowPnl)}\nOutcome: ${outcome}`,
      );
    }),
  );

  d.bot.onText(/^\/pause/, (msg) =>
    guard(msg, async () => {
      if (d.state.paused) {
        await reply('⏸️ Already paused.');
        return;
      }
      d.state.paused = true;
      logEvent({ kind: 'telegram_pause' });
      await reply('⏸️ Paused. The bot will stop opening new quotes but will still flatten at close.');
    }),
  );

  d.bot.onText(/^\/resume/, (msg) =>
    guard(msg, async () => {
      if (d.state.haltedSession) {
        await reply('🛑 Session halt is active — the process is exiting. Please restart with `npm start`.');
        return;
      }
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
