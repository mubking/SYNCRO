import { TelegramBotService } from '../src/services/telegram-bot-service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

var mockSingle = jest.fn();
var mockEq = jest.fn(() => ({ single: mockSingle }));
var mockSelect = jest.fn(() => ({ eq: mockEq }));
var mockFrom = jest.fn(() => ({ select: mockSelect }));
var mockTrackDbRequest = jest.fn(() => jest.fn());

jest.mock('../src/config/database', () => ({
  get supabase() { return { from: mockFrom }; },
  get trackDbRequest() { return mockTrackDbRequest; },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeFetchResponse(status: number, body = '{}'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function stubChatId(chatId: string | null): void {
  mockSingle.mockResolvedValue(
    chatId
      ? { data: { telegram_chat_id: chatId }, error: null }
      : { data: null, error: null }
  );
}

beforeEach(() => {
  jest.clearAllMocks();

  mockFrom.mockReturnValue({ select: mockSelect });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockEq.mockReturnValue({ single: mockSingle });
  mockTrackDbRequest.mockReturnValue(jest.fn());

  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-123';
});

describe('TelegramBotService.sendRenewalReminder', () => {
  const service = new TelegramBotService();
  const userId = 'user-abc';
  const subscriptionName = 'Netflix';
  const daysUntilRenewal = 3;

  describe('success path', () => {
    it('sends a message to Telegram and logs success', async () => {
      stubChatId('987654321');
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toMatch(/sendMessage$/);

      const body = JSON.parse(options.body);
      expect(body.chat_id).toBe('987654321');
      expect(body.text).toContain('Netflix');
      expect(body.text).toContain('3 days');

      const logger = require('../src/config/logger');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('sent'),
        expect.objectContaining({ status: 'success', userId })
      );
    });

    it('uses singular "day" when daysUntilRenewal is 1', async () => {
      stubChatId('111');
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200));

      await service.sendRenewalReminder(userId, subscriptionName, 1);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('1 day');
      expect(body.text).not.toContain('1 days');
    });
  });

  describe('user has no linked Telegram', () => {
    it('skips silently without calling Telegram API', async () => {
      stubChatId(null);

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).not.toHaveBeenCalled();

      const logger = require('../src/config/logger');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('no linked Telegram'),
        expect.objectContaining({ userId })
      );
    });
  });

  describe('transient failures — retries with backoff', () => {
    it('retries on HTTP 429 and eventually succeeds', async () => {
      stubChatId('222');
      mockFetch
        .mockResolvedValueOnce(makeFetchResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeFetchResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeFetchResponse(200));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).toHaveBeenCalledTimes(3);

      const logger = require('../src/config/logger');
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('sent'),
        expect.objectContaining({ status: 'success' })
      );
    });

    it('retries on HTTP 500 and eventually succeeds', async () => {
      stubChatId('333');
      mockFetch
        .mockResolvedValueOnce(makeFetchResponse(500, 'Internal Server Error'))
        .mockResolvedValueOnce(makeFetchResponse(200));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after MAX_RETRIES and logs failure without throwing', async () => {
      stubChatId('444');
      mockFetch.mockResolvedValue(makeFetchResponse(500, 'always failing'));

      await expect(
        service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal)
      ).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledTimes(3);

      const logger = require('../src/config/logger');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send'),
        expect.objectContaining({ status: 'failure', userId })
      );
    });
  });

  describe('permanent failures — no retry', () => {
    it('does not retry on HTTP 400 (bad request)', async () => {
      stubChatId('555');
      mockFetch.mockResolvedValueOnce(makeFetchResponse(400, 'Bad Request'));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const logger = require('../src/config/logger');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send'),
        expect.objectContaining({ status: 'failure' })
      );
    });

    it('does not retry on HTTP 403 (forbidden — bad token)', async () => {
      stubChatId('666');
      mockFetch.mockResolvedValueOnce(makeFetchResponse(403, 'Forbidden'));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('DB lookup failure', () => {
    it('logs error and does not crash when DB throws', async () => {
      mockSingle.mockRejectedValueOnce(new Error('DB connection refused'));

      await expect(
        service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal)
      ).resolves.toBeUndefined();

      expect(mockFetch).not.toHaveBeenCalled();
      const logger = require('../src/config/logger');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve chat ID'),
        expect.objectContaining({ userId })
      );
    });
  });

  describe('structured logging', () => {
    it('always includes a requestId in log entries', async () => {
      stubChatId('777');
      mockFetch.mockResolvedValueOnce(makeFetchResponse(200));

      await service.sendRenewalReminder(userId, subscriptionName, daysUntilRenewal);

      const logger = require('../src/config/logger');
      const successCall = logger.info.mock.calls.find(([msg]: [string]) =>
        msg.includes('sent')
      );
      expect(successCall[1]).toHaveProperty('requestId');
      expect(typeof successCall[1].requestId).toBe('string');
    });
  });
});
