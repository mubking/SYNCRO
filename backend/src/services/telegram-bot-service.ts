import { randomUUID } from 'crypto';
import logger from '../config/logger';
import { supabase, trackDbRequest } from '../config/database'; // The existing Supabase client from your database config

// ─── Env Validation ──────────────────────────────────────────────────────────

function getTelegramApiBase(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return `https://api.telegram.org/bot${token}`;
}

// ─── Retry Helpers ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn` up to `maxRetries` times with exponential backoff.
 * Only retries on transient errors (network failures or HTTP 429 / 5xx).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  baseDelayMs = BASE_DELAY_MS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isTransient =
        err instanceof TelegramTransientError ||
        (err instanceof TypeError);

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1); // 300ms, 600ms, 1200ms
      logger.warn(
        `[TelegramBotService] Attempt ${attempt} failed — retrying in ${delay}ms`,
        { error: (err as Error).message }
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// Sentinel so the retry loop can distinguish transient from permanent errors
class TelegramTransientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'TelegramTransientError';
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class TelegramBotService {
  /**
   * Looks up the Telegram chat_id stored on the user's profile.
   * Returns null if the user hasn't linked Telegram.
   */
  private async getUserChatId(userId: string): Promise<string | null> {
    const release = trackDbRequest();
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('telegram_chat_id')
        .eq('id', userId)
        .single();

      if (error || !data?.telegram_chat_id) return null;
      return String(data.telegram_chat_id);
    } finally {
      release();
    }
  }

  /**
   * POSTs a message to the Telegram Bot API.
   * Throws TelegramTransientError on 429 / 5xx so the retry loop can catch it.
   */
  private async callTelegramApi(
    chatId: string,
    text: string
  ): Promise<void> {
    const apiBase = getTelegramApiBase();

    if (!apiBase) {
      throw new Error(
        '[TelegramBotService] TELEGRAM_BOT_TOKEN is not configured'
      );
    }

    const response = await fetch(`${apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      const body = await response.text();

      if (response.status === 429 || response.status >= 500) {
        throw new TelegramTransientError(
          `Telegram API returned ${response.status}: ${body}`,
          response.status
        );
      }

      throw new Error(
        `Telegram API permanent error ${response.status}: ${body}`
      );
    }
  }

  /**
   * Sends a renewal reminder to a user via Telegram.
   * - Silently skips users who haven't linked Telegram.
   * - Retries up to 3× on transient failures.
   * - Logs success and failure with a unique requestId.
   * - Never throws, so it cannot crash the request path.
   */
  async sendRenewalReminder(
    userId: string,
    subscriptionName: string,
    daysUntilRenewal: number
  ): Promise<void> {
    const requestId = randomUUID();

    const baseLog = {
      requestId,
      userId,
      subscriptionName,
      daysUntilRenewal,
    };

    const apiBase = getTelegramApiBase();

    if (!apiBase) {
      logger.error('[TelegramBotService] Missing TELEGRAM_BOT_TOKEN', baseLog);
      return;
    }

    logger.info('[TelegramBotService] Resolving Telegram chat ID', baseLog);

    let chatId: string | null;
    try {
      chatId = await this.getUserChatId(userId);
    } catch (err) {
      logger.error('[TelegramBotService] Failed to resolve chat ID', {
        ...baseLog,
        error: (err as Error).message,
      });
      return; // don't crash the request path
    }

    if (!chatId) {
      logger.info(
        '[TelegramBotService] User has no linked Telegram account — skipping',
        baseLog
      );
      return;
    }

    const message =
      `🔔 *Subscription Reminder*\n\n` +
      `Your subscription to *${subscriptionName}* renews in ` +
      `*${daysUntilRenewal} day${daysUntilRenewal === 1 ? '' : 's'}*.\n\n` +
      `Log in to SYNCRO to manage it.`;

    try {
      await withRetry(() => this.callTelegramApi(chatId!, message));

      logger.info('[TelegramBotService] Renewal reminder sent', {
        ...baseLog,
        chatId,
        status: 'success',
      });
    } catch (err) {
      logger.error('[TelegramBotService] Failed to send renewal reminder', {
        ...baseLog,
        chatId,
        status: 'failure',
        error: (err as Error).message,
      });
      // Intentionally swallowed — failures must not crash the request path
    }
  }
}

export const telegramBotService = new TelegramBotService();