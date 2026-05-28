# Repository Issue Backlog — May 2026

## #35 — [P0] Eliminate accidental service-role usage from client server code

**Scope:** client-api
**Priority:** P0

**Summary:**
The client package included `SUPABASE_SERVICE_ROLE_KEY` in its environment configuration schema and validation script. This made the privileged service-role key accessible to any Next.js API route importing `@/lib/api/env`, creating a vector for accidental privilege escalation.

**Resolution:**
- Removed `SUPABASE_SERVICE_ROLE_KEY` from `client/lib/api/env.ts` schema and parser
- Removed `SUPABASE_SERVICE_ROLE_KEY` from `client/scripts/validate-env.js` required vars list
- Removed docs references in `client/README.md` and `client/BACKEND_DOCUMENTATION.md`
- Added test coverage (`client/lib/api/env.test.ts`) confirming the key is excluded
- The `backend/` package retains its own `SUPABASE_SERVICE_ROLE_KEY` usage (justified — backend needs admin privileges for auth admin operations and internal services)

**Service-role justification in backend:**
- `backend/lib/supabase.ts` — direct service-role client for backend-internal DB access
- `backend/src/config/database.ts` — service-role client with connection pool monitoring
- `backend/src/routes/user.ts:104` — `supabase.auth.admin.deleteUser()` requires admin privileges
- `scripts/*` — admin-level RLS audit scripts (offline use only)

## #697 — [P2] Tighten bundle-size budgets for the client app

**Scope:** ops
**Priority:** P2

**Summary:**
The repo had a bundle-size CI workflow but it was rudimentary — it measured the total `.next` directory size via `du -sk` and posted a raw KB comment with no per-route analysis, no baseline comparison, and no budget enforcement. This made it easy for bundle regressions to slip through unnoticed.

**Resolution:**
- Added `@next/bundle-analyzer` to client devDependencies and wired it into `next.config.mjs` via the `ANALYZE=true` environment variable
- Created `client/bundle-size.json` with route-level and chunk-level budgets for all 16 UI routes
- Created `client/scripts/check-bundle-size.js` that reads the Next.js build manifest, resolves per-route JS chunks from `.next/static/chunks/app/`, measures actual file sizes, and compares against defined budgets
- Rewrote `.github/workflows/bundle-size.yml` to:
  - Build from the `client/` directory with `npm ci` (fixed broken pnpm setup)
  - Run the check script with `--json` output
  - Post a detailed PR comment with per-route breakdown, violations, and warnings
  - Fail CI on any budget violation
- Added test coverage (`client/__tests__/lib/check-bundle-size.test.ts`) for the core `checkBudgets`, `routeToChunkPrefix`, and `formatKB` functions
- Updated `client/docs/TEST_INFRASTRUCTURE.md` with bundle-size workflow documentation

**Key files:**
- `client/bundle-size.json` — budget definitions
- `client/scripts/check-bundle-size.js` — budget enforcement script
- `client/next.config.mjs` — conditional bundle analyzer integration
- `.github/workflows/bundle-size.yml` — CI workflow
- `client/__tests__/lib/check-bundle-size.test.ts` — unit tests
