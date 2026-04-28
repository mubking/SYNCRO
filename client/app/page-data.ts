import { createClient } from '@/lib/supabase/server'

export type InitialPriceChange = {
  id: string
  subscriptionId: number
  name: string
  oldPrice: number
  newPrice: number
  changeDate: string
  changeType: 'increase' | 'decrease'
  annualImpact: number
  percentChange: number
}

function transformSubscription(dbSub: any): any {
  return {
    id: dbSub.id,
    name: dbSub.name,
    category: dbSub.category,
    price: dbSub.price,
    icon: dbSub.icon || '🔗',
    renewsIn: dbSub.renews_in,
    status: dbSub.status,
    color: dbSub.color || '#000000',
    renewalUrl: dbSub.renewal_url,
    tags: dbSub.tags || [],
    dateAdded: dbSub.date_added,
    emailAccountId: dbSub.email_account_id,
    lastUsedAt: dbSub.last_used_at,
    hasApiKey: dbSub.has_api_key || false,
    isTrial: dbSub.is_trial || false,
    trialEndsAt: dbSub.trial_ends_at,
    priceAfterTrial: dbSub.price_after_trial,
    source: dbSub.source || 'manual',
    manuallyEdited: dbSub.manually_edited || false,
    editedFields: dbSub.edited_fields || [],
    pricingType: dbSub.pricing_type || 'fixed',
    billingCycle: dbSub.billing_cycle || 'monthly',
    cancelledAt: dbSub.cancelled_at,
    activeUntil: dbSub.active_until,
    pausedAt: dbSub.paused_at,
    resumesAt: dbSub.resumes_at,
    priceRange: dbSub.price_range,
    priceHistory: dbSub.price_history,
  }
}

function normalizePriceChange(
  dbChange: any,
  subscriptionsById: Map<number, any>,
): InitialPriceChange {
  const oldPrice = Number(dbChange.old_price ?? 0)
  const newPrice = Number(dbChange.new_price ?? 0)
  const subscription = subscriptionsById.get(dbChange.subscription_id)
  const changeType = newPrice >= oldPrice ? 'increase' : 'decrease'

  return {
    id: dbChange.id,
    subscriptionId: dbChange.subscription_id,
    name: subscription?.name ?? `Subscription ${dbChange.subscription_id}`,
    oldPrice,
    newPrice,
    changeDate: dbChange.changed_at,
    changeType,
    annualImpact: (newPrice - oldPrice) * 12,
    percentChange: oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0,
  }
}

export async function getInitialData() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return {
        subscriptions: [],
        emailAccounts: [],
        payments: [],
        priceChanges: [],
        consolidationSuggestions: [],
      }
    }

    const [subscriptionsResult, emailAccountsResult, paymentsResult] = await Promise.all([
      supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .order('date_added', { ascending: false }),
      supabase.from('email_accounts').select('*').eq('user_id', user.id),
      supabase
        .from('payments')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
    ])

    const subscriptions = subscriptionsResult.data?.map(transformSubscription) || []
    const emailAccounts = emailAccountsResult.data || []
    const payments = paymentsResult.data || []

    const subscriptionsById = new Map<number, any>(
      (subscriptionsResult.data || []).map((sub: any) => [sub.id, sub]),
    )

    const priceHistoryResult = await supabase
      .from('subscription_price_history')
      .select('id,subscription_id,old_price,new_price,changed_at')
      .eq('user_id', user.id)
      .order('changed_at', { ascending: false })

    if (priceHistoryResult.error) {
      console.error('Error fetching price change history:', priceHistoryResult.error)
    }

    const priceChanges = priceHistoryResult.data
      ? priceHistoryResult.data.map((change: any) =>
          normalizePriceChange(change, subscriptionsById),
        )
      : []

    return {
      subscriptions,
      emailAccounts,
      payments,
      priceChanges,
      consolidationSuggestions: [],
    }
  } catch (error) {
    console.error('Error fetching initial data:', error)
    return {
      subscriptions: [],
      emailAccounts: [],
      payments: [],
      priceChanges: [],
      consolidationSuggestions: [],
    }
  }
}
