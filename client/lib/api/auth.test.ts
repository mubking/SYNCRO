import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole, requireMinRole, withAuth, getAuthenticatedUser, UserRole, ROLE_HIERARCHY } from './auth'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getAuthenticatedUser', () => {
    it('should return user when authenticated', async () => {
      const mockUser = { id: '123', email: 'test@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const user = await getAuthenticatedUser(request)

      expect(user).toEqual(mockUser)
    })

    it('should throw when not authenticated', async () => {
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('Not authenticated') }),
        },
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      await expect(getAuthenticatedUser(request)).rejects.toThrow('Invalid or expired session')
    })
  })

  describe('requireRole', () => {
    it('should allow user with correct role from database', async () => {
      const mockUser = { id: '123', email: 'admin@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const result = await requireRole(request, ['admin', 'owner'])

      expect(result.user).toEqual(mockUser)
      expect(result.role).toBe('admin')
    })

    it('should deny user with incorrect role', async () => {
      const mockUser = { id: '123', email: 'user@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'viewer' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      await expect(requireRole(request, ['admin', 'owner'])).rejects.toThrow('Requires one of: admin, owner')
    })

    it('should default to user role when profile not found', async () => {
      const mockUser = { id: '123', email: 'newuser@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: new Error('Not found') }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const result = await requireRole(request, ['user'])

      expect(result.role).toBe('user')
    })

    it('should support multiple allowed roles', async () => {
      const mockUser = { id: '123', email: 'member@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const result = await requireRole(request, ['admin', 'member', 'owner'])

      expect(result.role).toBe('member')
    })
  })

  describe('requireMinRole', () => {
    it('should allow user with exact minimum role', async () => {
      const mockUser = { id: '123', email: 'admin@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const result = await requireMinRole(request, 'admin')

      expect(result.role).toBe('admin')
    })

    it('should allow user with higher role than minimum', async () => {
      const mockUser = { id: '123', email: 'owner@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'owner' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      const result = await requireMinRole(request, 'member')

      expect(result.role).toBe('owner')
    })

    it('should deny user with lower role than minimum', async () => {
      const mockUser = { id: '123', email: 'viewer@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'viewer' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const request = new NextRequest('http://localhost')
      await expect(requireMinRole(request, 'admin')).rejects.toThrow('Requires admin role or higher')
    })
  })

  describe('withAuth', () => {
    it('should pass user to handler when authenticated', async () => {
      const mockUser = { id: '123', email: 'test@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }))
      const wrapped = withAuth(handler)

      const request = new NextRequest('http://localhost')
      await wrapped(request)

      expect(handler).toHaveBeenCalledWith(request, mockUser)
    })

    it('should enforce role when requireRole option provided', async () => {
      const mockUser = { id: '123', email: 'admin@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'admin' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }))
      const wrapped = withAuth(handler, { requireRole: ['admin'] })

      const request = new NextRequest('http://localhost')
      await wrapped(request)

      expect(handler).toHaveBeenCalled()
    })

    it('should reject when role requirement not met', async () => {
      const mockUser = { id: '123', email: 'user@example.com' }
      const mockSupabase = {
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { role: 'user' }, error: null }),
            }),
          }),
        }),
      }
      vi.mocked(createClient).mockResolvedValue(mockSupabase as any)

      const handler = vi.fn()
      const wrapped = withAuth(handler, { requireRole: ['admin'] })

      const request = new NextRequest('http://localhost')
      await expect(wrapped(request)).rejects.toThrow('Requires one of: admin')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('ROLE_HIERARCHY', () => {
    it('should have correct hierarchy order', () => {
      expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin)
      expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.member)
      expect(ROLE_HIERARCHY.member).toBeGreaterThan(ROLE_HIERARCHY.viewer)
      expect(ROLE_HIERARCHY.viewer).toBeGreaterThan(ROLE_HIERARCHY.user)
    })
  })
})
