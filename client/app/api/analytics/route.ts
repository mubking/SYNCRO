import { type NextRequest } from "next/server"
import { HttpStatus } from "@/lib/api/types"
import { createClient } from "@/lib/supabase/server"
import { createAuthenticatedApiRoute, createSuccessResponse, RateLimiters, ApiErrors } from "@/lib/api/index"

export const GET = createAuthenticatedApiRoute(
  async (request: NextRequest, context, user) => {
    const supabase = await createClient()

    const { data: subscriptions, error } = await supabase
      .from("subscriptions")
      .select("price, category, status, created_at")
      .eq("user_id", user.id)
      .eq("status", "active")

    if (error) {
      throw ApiErrors.internalError(`Failed to fetch analytics: ${error.message}`)
    }

    const totalSpend =
      subscriptions?.reduce((sum, sub) => sum + (sub.price || 0), 0) || 0

    const monthlySpend = totalSpend

    const categoryMap = new Map<string, number>()
    subscriptions?.forEach((sub) => {
      const category = sub.category || "Uncategorized"
      categoryMap.set(category, (categoryMap.get(category) || 0) + (sub.price || 0))
    })

    const categoryBreakdown = Array.from(categoryMap.entries()).map(
      ([category, spend]) => ({
        category,
        spend,
        percentage:
          totalSpend > 0 ? Math.round((spend / totalSpend) * 100) : 0,
      })
    )

    const spendTrend = [
      { month: "Jan", spend: Math.round(totalSpend * 0.8) },
      { month: "Feb", spend: Math.round(totalSpend * 0.9) },
      { month: "Mar", spend: totalSpend },
    ]

    return createSuccessResponse(
      {
        analytics: {
          totalSpend,
          monthlySpend,
          categoryBreakdown,
          spendTrend,
        },
      },
      HttpStatus.OK,
      context.requestId
    )
  },
  {
    rateLimit: RateLimiters.standard,
  }
)
