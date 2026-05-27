import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../util/logger.js';

export interface TelegramDeps {
  token: string;
  allowedChatId: string;
}

/** Create the Telegram polling bot. Returns null if creds are missing — the
 *  orchestrator should silently skip Telegram integration in that case. */
export function createBot(deps: TelegramDeps): TelegramBot | null {
  if (!deps.token || !deps.allowedChatId) return null;
  const bot = new TelegramBot(deps.token, { polling: true });
  bot.on('polling_error', (err: any) =>
    logger.warn({ err: err?.message }, 'telegram polling error'),
  );
  return bot;
}

/** Only commands from the configured chat are honored — anyone else is ignored
 *  silently (no reply leaks). */
export function isAuthorized(chatId: string | number, allowed: string): boolean {
  return String(chatId) === String(allowed);
}

/** Escape MarkdownV2 reserved characters so user-provided strings don't break
 *  formatting. We only use plain Markdown so this is a soft helper. */
export function escapeMd(text: string): string {
  return String(text).replace(/([_*[\]()~`>#+=|{}.!\\-])/g, '\\$1');
}
