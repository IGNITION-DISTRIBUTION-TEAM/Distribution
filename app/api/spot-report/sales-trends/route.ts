import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live rebuild of the Spot Report "Sales Trends" page payload, from the source
// the PBI map lists for that page: UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE
// (ACTIVATION_DATE, TENANT, ACCOUNT_NUMBER). The static build script
// (web/build/build_data.py) shaped the same 5-key JSON; the tenant->group
// mapping and DEFINED_GROUPS below mirror it exactly.
const SRC = "UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const DEFINED_GROUPS = [
  "Spar Retail", "Build It", "Midas", "Mica", "Fashion Fusion",
  "Progas", "Aheers", "The Unlimited", "Ladysmith Office National",
  "OnAir", "Pet Pool & Home", "Spot Mobile", "Spot Connect App & Digital",
]

function mapTenantGroup(name: string): string {
  const nl = (name || "").toLowerCase()
  if (nl.includes("build it")) return "Build It"
  if (nl.includes("midas") || nl.includes("kr motor spares") || nl.includes("aca auto parts") || nl.includes("aca autoparts")) return "Midas"
  if (nl.includes("mica") || nl.includes("greenfields hardware")) return "Mica"
  if (nl.includes("spargs") || nl.includes("savemor") || nl.includes("spar")) return "Spar Retail"
  if (nl.includes("fashion")) return "Fashion Fusion"
  if (nl.includes("progas")) return "Progas"
  if (nl.includes("aheers")) return "Aheers"
  if (nl === "the unlimited") return "The Unlimited"
  if (nl.includes("ladysmith office national")) return "Ladysmith Office National"
  if (nl.includes("onair") || nl.includes("on air")) return "OnAir"
  if (nl.includes("pet pool")) return "Pet Pool & Home"
  if (nl === "spot mobile") return "Spot Mobile"
  if (nl.includes("uconnect app") || nl.includes("uconnect digital")) return "Spot Connect App & Digital"
  return "Other Tenants"
}

const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    // Daily activations per tenant over the last ~13 months (matches the static
    // page's rolling-13-month range). daily + daily_by_group are both derived
    // from this so they always reconcile.
    const perTenant = await executeSnowflakeQuery<{ D: string; TENANT: string | null; N: string | number }>(
      `SELECT TO_VARCHAR(CAST(ACTIVATION_DATE AS DATE), 'YYYY-MM-DD') AS D,
              TENANT,
              COUNT(ACCOUNT_NUMBER) AS N
       FROM ${SRC}
       WHERE CAST(ACTIVATION_DATE AS DATE) >= DATEADD('month', -13, CURRENT_DATE())
         AND CAST(ACTIVATION_DATE AS DATE) < CURRENT_DATE()
       GROUP BY 1, 2
       ORDER BY 1`,
      SF_OPTS
    )

    const dailyMap = new Map<string, number>()
    const groupMap = new Map<string, number>() // key: date|group
    for (const r of perTenant) {
      const d = String(r.D)
      const n = num(r.N)
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + n)
      const g = mapTenantGroup(String(r.TENANT ?? ""))
      const gk = `${d}|${g}`
      groupMap.set(gk, (groupMap.get(gk) ?? 0) + n)
    }
    const daily = Array.from(dailyMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, activations]) => ({ date, activations }))
    const daily_by_group = Array.from(groupMap.entries())
      .map(([k, activations]) => {
        const [date, group] = k.split("|")
        return { date, group, activations }
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.group.localeCompare(b.group))

    // Per-tenant counts for this calendar month vs last, for the league tables.
    const tm = await executeSnowflakeQuery<{ TENANT: string | null; LAST_MONTH: string | number; THIS_MONTH: string | number }>(
      `SELECT TENANT,
              COUNT_IF(DATE_TRUNC('month', CAST(ACTIVATION_DATE AS DATE))
                       = DATE_TRUNC('month', DATEADD('month', -1, CURRENT_DATE()))) AS LAST_MONTH,
              COUNT_IF(DATE_TRUNC('month', CAST(ACTIVATION_DATE AS DATE))
                       = DATE_TRUNC('month', CURRENT_DATE())) AS THIS_MONTH
       FROM ${SRC}
       WHERE CAST(ACTIVATION_DATE AS DATE) >= DATE_TRUNC('month', DATEADD('month', -1, CURRENT_DATE()))
       GROUP BY TENANT
       HAVING LAST_MONTH > 0 OR THIS_MONTH > 0`,
      SF_OPTS
    )
    const tenant_month = tm.map((r) => ({
      tenant: String(r.TENANT ?? ""),
      last_month: num(r.LAST_MONTH),
      this_month: num(r.THIS_MONTH),
      group: mapTenantGroup(String(r.TENANT ?? "")),
    }))

    return NextResponse.json({
      daily,
      daily_by_group,
      tenant_month,
      // Not yet ported to live — the page's SNU/Active-1 mini panel stays on the
      // static snapshot via the client's fallback merge.
      snu_active1: [],
      defined_groups: DEFINED_GROUPS,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/sales-trends] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
