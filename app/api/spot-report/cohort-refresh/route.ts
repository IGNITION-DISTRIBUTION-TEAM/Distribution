import { NextRequest, NextResponse } from "next/server"
import { submitSnowflakeStatementAsync, getSnowflakeStatementStatus } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Background refresh of the cohort materialised table. The source view
// (VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES) is a ~90s 5-way join, so we
// run a CTAS asynchronously (SQL API ?async=true) and return a handle
// immediately; the client polls GET ?handle=… until it's done. The page then
// reads the compact SPOT_COHORT table instantly.
const DB = "DATAWAREHOUSE"
const SCHEMA = "LEADS_DISTRIBUTION"
const TABLE = `${DB}.${SCHEMA}.SPOT_COHORT`
const SF_OPTS = { database: DB, schema: SCHEMA } as const
const SRC = "UCONNECT_DW.ANALYTICS.VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES"

// Aggregate away TENANT/FAIS to keep the stored table small; the page needs
// campaign × cohort × observed-month × aging with the sales/base/revenue sums.
const CTAS = `CREATE OR REPLACE TABLE ${TABLE} AS
  SELECT CAMPAIGN,
         TO_VARCHAR(CAST(COHORT_MONTH AS DATE), 'YYYY-MM-DD') AS COHORT_MONTH,
         TO_VARCHAR(CAST(DATE_SERIES_MONTH AS DATE), 'YYYY-MM-DD') AS DATE_SERIES_MONTH,
         MONTH_PERIOD,
         SUM(SALES) AS SALES,
         SUM(REGISTERED_BASE) AS REGISTERED_BASE,
         SUM(ACTIVE_1_BASE) AS ACTIVE_1_BASE,
         SUM(TOTAL_REVENUE) AS TOTAL_REVENUE,
         CURRENT_TIMESTAMP() AS REFRESHED_AT
  FROM ${SRC}
  GROUP BY CAMPAIGN,
           TO_VARCHAR(CAST(COHORT_MONTH AS DATE), 'YYYY-MM-DD'),
           TO_VARCHAR(CAST(DATE_SERIES_MONTH AS DATE), 'YYYY-MM-DD'),
           MONTH_PERIOD`

// POST — kick off the refresh; returns a statement handle immediately.
export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard
  try {
    const handle = await submitSnowflakeStatementAsync(CTAS, SF_OPTS)
    return NextResponse.json({ started: true, handle })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/cohort-refresh] submit error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET ?handle=… — poll the async statement's status.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard
  const handle = request.nextUrl.searchParams.get("handle")
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 })
  try {
    const status = await getSnowflakeStatementStatus(handle)
    return NextResponse.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}
