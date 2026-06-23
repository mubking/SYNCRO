import { deriveStealthAddress } from '../../shared/src/crypto/stealth-derive';

// ── deriveStealthAddress unit tests ──────────────────────────────────────────

describe('deriveStealthAddress', () => {
  const META = 'test-meta-address';
  const SUB_ID = 'sub-abc-123';

  it('returns a 64-char hex string', () => {
    expect(deriveStealthAddress(META, SUB_ID, 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(deriveStealthAddress(META, SUB_ID, 0)).toBe(deriveStealthAddress(META, SUB_ID, 0));
  });

  it('different indices produce different addresses', () => {
    expect(deriveStealthAddress(META, SUB_ID, 0)).not.toBe(deriveStealthAddress(META, SUB_ID, 1));
  });

  it('different subscription IDs produce different addresses', () => {
    expect(deriveStealthAddress(META, 'sub-111', 0)).not.toBe(deriveStealthAddress(META, 'sub-222', 0));
  });

  it('different meta-addresses produce different addresses', () => {
    expect(deriveStealthAddress('meta-A', SUB_ID, 0)).not.toBe(deriveStealthAddress('meta-B', SUB_ID, 0));
  });

  it('100 consecutive indices are all unique (no collisions)', () => {
    const addrs = Array.from({ length: 100 }, (_, i) => deriveStealthAddress(META, SUB_ID, i));
    expect(new Set(addrs).size).toBe(100);
  });

  it('throws RangeError for negative index', () => {
    expect(() => deriveStealthAddress(META, SUB_ID, -1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer index', () => {
    expect(() => deriveStealthAddress(META, SUB_ID, 1.5)).toThrow(RangeError);
  });
});

// ── Stealth index assignment in subscription-service tests ───────────────────

jest.mock('../src/config/database', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../src/services/blockchain-service', () => ({
  blockchainService: { syncSubscription: jest.fn() },
}));
jest.mock('../src/services/analytics-service', () => ({
  analyticsService: { checkBudgetThreshold: jest.fn() },
}));
jest.mock('../src/services/referral-service', () => ({
  referralService: { markConverted: jest.fn() },
}));
jest.mock('../src/services/renewal-cooldown-service', () => ({
  renewalCooldownService: { checkCooldown: jest.fn(), recordRenewalAttempt: jest.fn() },
}));
jest.mock('../src/utils/transaction');

import { subscriptionService } from '../src/services/subscription-service';
import { DatabaseTransaction } from '../src/utils/transaction';
import { blockchainService } from '../src/services/blockchain-service';
import { analyticsService } from '../src/services/analytics-service';
import { referralService } from '../src/services/referral-service';

describe('SubscriptionService — stealth index assignment', () => {
  const USER_ID = 'user-xyz';
  const BASE = { name: 'Netflix', price: 15.99, billing_cycle: 'monthly' as const };

  beforeEach(() => {
    // resetMocks:true wipes implementations — restore each test
    (analyticsService.checkBudgetThreshold as jest.Mock).mockResolvedValue(undefined);
    (referralService.markConverted as jest.Mock).mockResolvedValue(undefined);
    (blockchainService.syncSubscription as jest.Mock).mockResolvedValue({ success: true });
    delete process.env.STEALTH_META_ADDRESS;
  });

  function setupTransaction(
    indexRow: { stealth_index: number } | null,
    insertedSub: Record<string, unknown>,
  ) {
    (DatabaseTransaction.execute as jest.Mock).mockImplementation(
      async (fn: (c: any) => Promise<any>) => {
        let call = 0;
        return fn({
          from: () => {
            call++;
            if (call === 1) {
              return {
                select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ single: () => Promise.resolve({ data: indexRow, error: null }) }) }) }) }),
              };
            }
            if (call === 2) {
              return {
                insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: insertedSub, error: null }) }) }),
              };
            }
            // call === 3: UPDATE stealth_address
            return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        });
      },
    );
  }

  it('assigns stealth_index 0 when no subscriptions exist', async () => {
    setupTransaction(null, { id: 's1', user_id: USER_ID, name: 'Netflix', stealth_index: 0, stealth_address: null });
    const { subscription } = await subscriptionService.createSubscription(USER_ID, BASE);
    expect(subscription.stealth_index).toBe(0);
  });

  it('assigns stealth_index = max + 1', async () => {
    setupTransaction({ stealth_index: 2 }, { id: 's2', user_id: USER_ID, name: 'Netflix', stealth_index: 3, stealth_address: null });
    const { subscription } = await subscriptionService.createSubscription(USER_ID, BASE);
    expect(subscription.stealth_index).toBe(3);
  });

  it('derives and persists stealth_address when STEALTH_META_ADDRESS is set', async () => {
    process.env.STEALTH_META_ADDRESS = 'secret-meta';
    setupTransaction(null, { id: 'sub-stealth', user_id: USER_ID, name: 'Netflix', stealth_index: 0, stealth_address: null });
    const { subscription } = await subscriptionService.createSubscription(USER_ID, BASE);
    expect(subscription.stealth_address).toBe(deriveStealthAddress('secret-meta', 'sub-stealth', 0));
  });
});
