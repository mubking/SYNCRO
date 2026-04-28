import { type NextRequest } from "next/server"
import { createApiRoute, createSuccessResponse, validateRequestBody, RateLimiters, ApiErrors, checkOwnership } from "@/lib/api/index"
import { HttpStatus } from "@/lib/api/types"
import { z } from "zod"
import { PaymentService } from "@/lib/payment-service"
import { createClient } from "@/lib/supabase/server"

// Validation schema
const refundSchema = z.object({
  transactionId: z.string().min(1, "Transaction ID is required"),
})

export const POST = createApiRoute(
  async (request: NextRequest, context, user) => {
    if (!user) {
      throw ApiErrors.unauthorized("User not authenticated")
    }

    // Validate request body
    const body = await validateRequestBody(request, refundSchema)

    const supabase = await createClient()

    // Verify payment ownership before refunding
    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("user_id, status")
      .eq("transaction_id", body.transactionId)
      .single()

    if (paymentError || !payment) {
      throw ApiErrors.notFound("Payment")
    }

    // Verify the payment belongs to the requesting user
    checkOwnership(user.id, payment.user_id)

    // Check if payment is already refunded
    if (payment.status === "refunded") {
      throw ApiErrors.badRequest("Payment has already been refunded")
    }

    const paymentService = new PaymentService({
      provider: "stripe", // For now, assume Stripe
    })

    const result = await paymentService.refundPayment(body.transactionId)

    if (!result.success) {
      throw ApiErrors.internalError(`Refund failed: ${result.error || "Unknown error"}`)
    }

    return createSuccessResponse(
      {
        refundId: result.transactionId,
        status: "refunded",
      },
      HttpStatus.OK,
      context.requestId
    )
  },
  {
    requireAuth: true,
    rateLimit: RateLimiters.strict,
  }
)
