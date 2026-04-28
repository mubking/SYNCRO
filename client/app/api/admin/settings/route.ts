import { NextRequest } from 'next/server'
import { createApiRoute, createSuccessResponse } from '@/lib/api'

export const PUT = createApiRoute(
  async (request: NextRequest) => {
    return createSuccessResponse({ updated: true })
  },
  {
    requireAuth: true,
    requireRole: ['owner'],
  }
)
