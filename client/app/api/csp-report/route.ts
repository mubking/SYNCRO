import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import * as Sentry from "@sentry/nextjs"
import { createClient } from "@/lib/supabase/server"
import { checkRateLimit } from "@/lib/api/rate-limit"

const CspReportSchema = z.object({
  "csp-report": z.object({
    "document-uri": z.string().url(),
    "violated-directive": z.string(),
    "blocked-uri": z.string().optional(),
    "source-file": z.string().optional(),
    "line-number": z.number().optional(),
    "column-number": z.number().optional(),
    "disposition": z.enum(["enforce", "report"]).optional(),
    "status-code": z.number().optional(),
    "script-sample": z.string().optional(),
  }),
})

// 30 reports per minute per IP — enough signal, not a flood
const CSP_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 }

// Only persist 20% of reports to avoid noise; Sentry captures the rest
const SAMPLE_RATE = 0.2

// Strip fields that could leak user data
function sanitize(report: z.infer<typeof CspReportSchema>["csp-report"]) {
  return {
    violated_directive: report["violated-directive"],
    blocked_uri: report["blocked-uri"] ?? null,
    // Remove query strings from URIs to avoid leaking tokens/PII
    document_uri: report["document-uri"].split("?")[0],
    disposition: report["disposition"] ?? null,
  }
}

export async function POST(request: NextRequest) {
  const rateCheck = checkRateLimit(request, CSP_RATE_LIMIT)
  if (!rateCheck.allowed) {
    return NextResponse.json({ success: false }, { status: 429 })
  }

  let result
  try {
    result = CspReportSchema.safeParse(await request.json())
  } catch {
    return NextResponse.json({ success: false }, { status: 400 })
  }

  if (!result.success) {
    return NextResponse.json({ success: false }, { status: 400 })
  }

  const clean = sanitize(result.data["csp-report"])

  // Always send to Sentry so violations are queryable and can trigger alerts
  Sentry.captureEvent({
    message: `CSP violation: ${clean.violated_directive}`,
    level: "warning",
    tags: {
      csp_directive: clean.violated_directive,
      disposition: clean.disposition ?? "unknown",
    },
    extra: clean,
  })

  // Persist a sample to DB for ad-hoc querying / dashboards
  if (Math.random() < SAMPLE_RATE) {
    const supabase = await createClient()
    await supabase.from("csp_violations").insert(clean)
  }

  return NextResponse.json({ success: true })
}
