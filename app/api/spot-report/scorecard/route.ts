import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live activation volume for a single store-group scorecard. Same source as
// Sales Trends (UCONNECT_MAY_MERGE: ACTIVATION_DATE, TENANT, ACCOUNT_NUMBER);
// the group→TENANT filters below mirror the mapTenantGroup logic in
// app/api/spot-report/sales-trends/route.ts. Returns monthly (13m), daily
// (13m; the client shows the last 90), and per-store this/last-month counts.
// SIM-quality, ROS and wastage aren't here — those aren't cleanly derivable and
// stay on the baked snapshot.
const SRC = "UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

// SQL WHERE fragment per store-group key (matches the scorecard selector).
const GROUP_FILTER: Record<string, string> = {
  Spar: "(TENANT ILIKE '%spar%' OR TENANT ILIKE '%savemor%')",
  "Build It": "TENANT ILIKE '%build it%'",
  Mica: "(TENANT ILIKE '%mica%' OR TENANT ILIKE '%greenfields hardware%')",
  "Pet Pool & Home": "TENANT ILIKE '%pet pool%'",
  Aheers: "TENANT ILIKE '%aheers%'",
  "Fashion Fusion": "TENANT ILIKE '%fashion%'",
  Progas: "TENANT ILIKE '%progas%'",
  Midas: "(TENANT ILIKE '%midas%' OR TENANT ILIKE '%kr motor spares%' OR TENANT ILIKE '%aca auto parts%' OR TENANT ILIKE '%aca autoparts%')",
}

const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  const group = request.nextUrl.searchParams.get("group") ?? ""
  const filter = GROUP_FILTER[group]
  if (!filter) return NextResponse.json({ error: `Unknown group '${group}'`, hasData: false }, { status: 400 })

  try {
    const rows = await executeSnowflakeQuery<{ TENANT: string | null; D: string; N: string | number }>(
      `SELECT TENANT,
              TO_VARCHAR(CAST(ACTIVATION_DATE AS DATE), 'YYYY-MM-DD') AS D,
              COUNT(ACCOUNT_NUMBER) AS N
       FROM ${SRC}
       WHERE MASTER_TENANT = 'uConnect'
         AND ${filter}
         AND CAST(ACTIVATION_DATE AS DATE) >= DATEADD('month', -13, DATE_TRUNC('month', CURRENT_DATE()))
         AND CAST(ACTIVATION_DATE AS DATE) < DATE_TRUNC('month', DATEADD('month', 1, CURRENT_DATE()))
       GROUP BY 1, 2`,
      SF_OPTS
    )

    const monthKey = (d: string) => `${d.slice(0, 7)}-01`
    const thisMonth = new Date().toISOString().slice(0, 7) // server month; fine for a monthly bucket
    const monthly = new Map<string, number>()
    const daily = new Map<string, number>()
    const store = new Map<string, { tenant: string; this_month: number; last_month: number }>()

    // Determine current & previous calendar month from the data's own max month
    // so "this/last" reconcile with the bars even around month boundaries.
    const allMonths = new Set<string>()
    for (const r of rows) allMonths.add(monthKey(String(r.D)))
    const sortedMonths = Array.from(allMonths).sort()
    const curM = sortedMonths[sortedMonths.length - 1] ?? `${thisMonth}-01`
    const prevM = sortedMonths[sortedMonths.length - 2] ?? null

    for (const r of rows) {
      const d = String(r.D)
      const n = num(r.N)
      const mk = monthKey(d)
      monthly.set(mk, (monthly.get(mk) ?? 0) + n)
      daily.set(d, (daily.get(d) ?? 0) + n)
      const t = String(r.TENANT ?? "Unknown")
      const rec = store.get(t) ?? { tenant: t, this_month: 0, last_month: 0 }
      if (mk === curM) rec.this_month += n
      else if (prevM && mk === prevM) rec.last_month += n
      store.set(t, rec)
    }

    return NextResponse.json({
      hasData: rows.length > 0,
      group,
      monthly: Array.from(monthly.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, activations]) => ({ month, activations })),
      daily: Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, activations]) => ({ date, activations })),
      stores: Array.from(store.values()).filter((s) => s.this_month > 0 || s.last_month > 0).sort((a, b) => b.this_month - a.this_month),
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/scorecard] error:", message)
    return NextResponse.json({ error: message, hasData: false }, { status: 200 })
  }
}
