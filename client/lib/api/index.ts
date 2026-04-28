/**
 * API Infrastructure - Main Export
 * Centralized exports for all API utilities
 */

// Types
export * from './types'

// Error Handling
export * from './errors'

// Authentication & Authorization
export * from './auth'

// Validation
export * from './validation'

// Rate Limiting
export * from './rate-limit'

// Environment
export * from './env'

/**
 * Helper to create a complete API route handler with all middleware
 */
import { NextResponse, type NextRequest } from 'next/server'
import { withErrorHandling, createSuccessResponse } from './errors'
import { requireAuth, requireRole, createRequestContext, type UserRole } from './auth'
import { type RequestContext, type ApiResponse } from './types'
import { isMaintenanceMode } from './env'
import { ApiErrors } from './errors'

type RouteHandler = (
  request: NextRequest,
  context: RequestContext,
  user?: Awaited<ReturnType<typeof requireAuth>>
) => Promise<NextResponse<ApiResponse>>

type RouteOptions = {
  requireAuth?: boolean
  requireRole?: UserRole[]
  rateLimit?: (request: NextRequest) => void
  skipMaintenanceCheck?: boolean
}

export function createApiRoute(
  handler: RouteHandler,
  options: RouteOptions = {}
) {
  return withErrorHandling(async (request: NextRequest) => {
    if (!options.skipMaintenanceCheck && isMaintenanceMode()) {
      throw ApiErrors.serviceUnavailable('Service is currently under maintenance')
    }

    if (options.rateLimit) {
      options.rateLimit(request)
    }

    const context = createRequestContext(request)

    let user: Awaited<ReturnType<typeof requireAuth>> | undefined
    if (options.requireAuth) {
      user = await requireAuth(request)
      context.userId = user.id
      context.userEmail = user.email

      if (options.requireRole) {
        await requireRole(request, options.requireRole)
      }
    }

    return handler(request, context, user) as unknown as NextResponse<ApiResponse>
  }, crypto.randomUUID())
}

