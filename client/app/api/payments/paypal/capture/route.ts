/**
 * PayPal Payment Capture Endpoint
 * Captures a PayPal order after user approval
 */

import { type NextRequest } from "next/server"
import { createApiRoute, createSuccessResponse, ApiErrors, RateLimiters } from "@/lib/api/index"
import { HttpStatus } from "@/lib/api/types"
import { PaymentService } from "@/lib/payment-service"
import { z } from "zod"

const captureSchema = z.object({
    orderId: z.string().min(1, "Order ID is required"),
    planName: z.string().min(1, "Plan name is required"),
})

export const POST = createApiRoute(
    async (request: NextRequest, context, user) => {
        if (!user) {
            throw ApiErrors.unauthorized("User not authenticated")
        }

        const body = await request.json()
        const validated = captureSchema.parse(body)

        const paymentService = new PaymentService({
            provider: "paypal",
        })

        // Capture the order using the order_ prefix convention
        const result = await paymentService.processPayment(
            0, // Amount not needed for capture
            "USD",
            `order_${validated.orderId}`,
            {
                planName: validated.planName,
                userId: user.id,
                userEmail: user.email || "",
            }
        )

        if (!result.success) {
            throw ApiErrors.internalError(
                `Payment capture failed: ${result.error || "Unknown error"}`
            )
        }

        return createSuccessResponse(
            {
                payment: {
                    id: result.transactionId,
                    status: "succeeded",
                    provider: "paypal",
                },
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
