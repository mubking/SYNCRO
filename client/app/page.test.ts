import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getInitialData } from './page-data'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

type SupabaseQuery = {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
}

function makeQuery(result: any) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue(result),
  }

  return query as unknown as SupabaseQuery
}

describe('HomePage server payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty initial data for unauthenticated users', async () => {
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('No session') }),
      },
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const initialData = await getInitialData()

    expect(initialData).toEqual({
      subscriptions: [],
      emailAccounts: [],
      payments: [],
      priceChanges: [],
      consolidationSuggestions: [],
    })
  })

  it('loads and normalizes historical price changes for authenticated users', async () => {
    const mockUser = { id: 'user-123' }

    const subscriptionsResult = {
      data: [
        {
          id: 1,
          name: 'ChatGPT Plus',
          category: 'AI Tools',
          price: 20,
          icon: '🤖',
          renews_in: 30,
          status: 'active',
          color: '#000000',
          renewal_url: 'https://chat.openai.com',
          tags: [],
          date_added: '2024-01-01T00:00:00Z',
          email_account_id: 1,
          last_used_at: null,
          has_api_key: false,
          is_trial: false,
          trial_ends_at: null,
          price_after_trial: null,
          source: 'manual',
          manually_edited: false,
          edited_fields: [],
          pricing_type: 'fixed',
          billing_cycle: 'monthly',
          cancelled_at: null,
          active_until: null,
          paused_at: null,
          resumes_at: null,
          price_range: null,
          price_history: [],
        },
      ],
      error: null,
    }

    const emailAccountsResult = { data: [], error: null }
    const paymentsResult = { data: [], error: null }
    const priceHistoryResult = {
      data: [
        {
          id: 'history-uuid',
          subscription_id: 1,
          old_price: '10',
          new_price: '15',
          changed_at: '2024-02-01T12:00:00Z',
        },
      ],
      error: null,
    }

    const fromMock = vi.fn((table: string) => {
      if (table === 'subscriptions') return makeQuery(subscriptionsResult)
      if (table === 'email_accounts') return makeQuery(emailAccountsResult)
      if (table === 'payments') return makeQuery(paymentsResult)
      if (table === 'subscription_price_history') return makeQuery(priceHistoryResult)
      return makeQuery({ data: [], error: null })
    })

    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
      from: fromMock,
    }

    vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

    const initialData = await getInitialData()

    expect(initialData.priceChanges).toHaveLength(1)
    expect(initialData.priceChanges[0]).toMatchObject({
      id: 'history-uuid',
      subscriptionId: 1,
      name: 'ChatGPT Plus',
      oldPrice: 10,
      newPrice: 15,
      changeType: 'increase',
      annualImpact: 60,
      percentChange: 50,
      changeDate: '2024-02-01T12:00:00Z',
    })
  })
})
