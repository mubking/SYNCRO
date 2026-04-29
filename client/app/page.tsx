import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { AppClient } from "@/components/app/app-client";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { ConsolidationSuggestion } from "@/lib/types";

interface DbSubscription {
    id: string;
    name: string;
    category: string | null;
    price: number;
    icon: string | null;
    renews_in: number | null;
    status: string;
    color: string | null;
    renewal_url: string | null;
    tags: string[] | null;
    date_added: string;
    email_account_id: string | null;
    last_used_at: string | null;
    has_api_key: boolean | null;
    is_trial: boolean | null;
    trial_ends_at: string | null;
    price_after_trial: number | null;
    source: string | null;
    manually_edited: boolean | null;
    edited_fields: string[] | null;
    pricing_type: string | null;
    billing_cycle: string | null;
    cancelled_at: string | null;
    active_until: string | null;
    paused_at: string | null;
    resumes_at: string | null;
    price_range: string | null;
    price_history: unknown;
}

function transformSubscription(dbSub: DbSubscription) {
    return {
        id: dbSub.id,
        name: dbSub.name,
        category: dbSub.category,
        price: dbSub.price,
        icon: dbSub.icon ?? "🔗",
        renewsIn: dbSub.renews_in,
        status: dbSub.status,
        color: dbSub.color ?? "#000000",
        renewalUrl: dbSub.renewal_url,
        tags: dbSub.tags ?? [],
        dateAdded: dbSub.date_added,
        emailAccountId: dbSub.email_account_id,
        lastUsedAt: dbSub.last_used_at,
        hasApiKey: dbSub.has_api_key ?? false,
        isTrial: dbSub.is_trial ?? false,
        trialEndsAt: dbSub.trial_ends_at,
        priceAfterTrial: dbSub.price_after_trial,
        source: dbSub.source ?? "manual",
        manuallyEdited: dbSub.manually_edited ?? false,
        editedFields: dbSub.edited_fields ?? [],
        pricingType: dbSub.pricing_type ?? "fixed",
        billingCycle: dbSub.billing_cycle ?? "monthly",
        cancelledAt: dbSub.cancelled_at,
        activeUntil: dbSub.active_until,
        pausedAt: dbSub.paused_at,
        resumesAt: dbSub.resumes_at,
        priceRange: dbSub.price_range,
        priceHistory: dbSub.price_history,
    };
}

type AppSubscription = ReturnType<typeof transformSubscription>;

const FLAGGABLE_CATEGORIES = ["ai_tools", "entertainment", "productivity", "design", "music"];

const BUNDLE_SUGGESTIONS: Record<string, string> = {
    ai_tools: "one AI subscription",
    entertainment: "a streaming bundle",
    productivity: "a single productivity suite",
    design: "one design tool",
    music: "one music service",
};

function buildConsolidationSuggestions(subscriptions: AppSubscription[]): ConsolidationSuggestion[] {
    const byCategory: Record<string, AppSubscription[]> = {};

    for (const sub of subscriptions) {
        const cat = sub.category;
        if (!cat || !FLAGGABLE_CATEGORIES.includes(cat)) continue;
        (byCategory[cat] ??= []).push(sub);
    }

    return Object.entries(byCategory)
        .filter(([, group]) => group.length >= 2)
        .map(([category, group]) => {
            const total = group.reduce((sum, s) => sum + s.price, 0);
            const cheapest = Math.min(...group.map((s) => s.price));
            return {
                id: `consolidation_${category}`,
                category: category.replace("_", " "),
                services: group.map((s) => s.name),
                suggestedBundle: BUNDLE_SUGGESTIONS[category] ?? "a single plan",
                savings: `$${(total - cheapest).toFixed(2)}`,
            };
        });
}

async function getInitialData() {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return {
                subscriptions: [] as AppSubscription[],
                emailAccounts: [],
                payments: [],
                priceChanges: [],
                consolidationSuggestions: [] as ConsolidationSuggestion[],
            };
        }

        const [subscriptionsResult, emailAccountsResult, paymentsResult] = await Promise.all([
            supabase.from("subscriptions").select("*").eq("user_id", user.id).order("date_added", { ascending: false }),
            supabase.from("email_accounts").select("*").eq("user_id", user.id),
            supabase.from("payments").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
        ]);

        const subscriptions = ((subscriptionsResult.data ?? []) as DbSubscription[]).map(transformSubscription);

        return {
            subscriptions,
            emailAccounts: emailAccountsResult.data ?? [],
            payments: paymentsResult.data ?? [],
            priceChanges: [],
            consolidationSuggestions: buildConsolidationSuggestions(subscriptions),
        };
    } catch {
        return {
            subscriptions: [] as AppSubscription[],
            emailAccounts: [],
            payments: [],
            priceChanges: [],
            consolidationSuggestions: [] as ConsolidationSuggestion[],
        };
    }
}

export default async function HomePage() {
    const initialData = await getInitialData();

    return (
        <Suspense
            fallback={
                <div className="min-h-screen bg-[#F9F6F2] dark:bg-[#1E2A35] flex items-center justify-center">
                    <LoadingSpinner size="lg" darkMode={false} />
                </div>
            }
        >
            <AppClient
                initialSubscriptions={initialData.subscriptions}
                initialEmailAccounts={initialData.emailAccounts}
                initialPayments={initialData.payments}
                initialPriceChanges={initialData.priceChanges}
                initialConsolidationSuggestions={initialData.consolidationSuggestions}
            />
        </Suspense>
    );
}
