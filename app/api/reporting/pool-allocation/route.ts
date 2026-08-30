import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

/**
 * Pool allocation report — where campaign 608's leads came from, what was left
 * behind, and what a different set of settings would have produced.
 *
 * Three questions, one answer set:
 *
 *   1. How did the two bases split?  Read from TM_ONAIR_U5_BALANCED_POOL, which
 *      records SOURCE_POOL per lead, so this is what was actually allocated —
 *      not a reconstruction.
 *   2. What was in the pools?  Counted live from both source tables, so the
 *      headroom shown is today's, not the headroom at allocation time.
 *   3. What if the settings changed?  Deliberately NOT computed here. The whole
 *      allocation is arithmetic over the per-band availability vector, so the
 *      client re-runs it on every keystroke against the numbers below rather
 *      than paying a Snowflake round trip per change. Nothing is written and
 *      nothing is distributed by opening this page.
 *
 * Bands come from TM_U5_BAND_TARGETS rather than from the allocated rows, so a
 * band that could not be filled at all still appears — with zeros, which is the
 * interesting case.
 */

const SCHEMA = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION"
const SF = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

const BANDS = `${SCHEMA}.TM_U5_BAND_TARGETS`
const ALLOCATED = `${SCHEMA}.TM_ONAIR_U5_BALANCED_POOL`
const RUNS = `${SCHEMA}.TM_U5_ALLOCATION_RUNS`
const POOL_DEFAULT = `${SCHEMA}.TM_ONAIR_SCORE_OTPUT`
const POOL_TOPUP = `${SCHEMA}.TM_ONAIR_INCUBATION_SCORE_OTPUT`

export type PoolBand = {
  band: string
  scoreMin: number
  scoreMax: number
  weight: number
  targetOverride: number | null
  topupEnabled: boolean
  enabled: boolean
  /** Eligible and still in the default pool right now. */
  availDefault: number
  /** Eligible and still in the incubation pool right now. */
  availTopup: number
  /** What the last run actually took, by source. */
  allocDefault: number
  allocTopup: number
  /** The quota that run was working to. */
  quota: number | null
}

export type PoolAllocationData = {
  bands: PoolBand[]
  lastRun: {
    runAt: string | null
    agents: number | null
    days: number | null
    leadsPerAgentDay: number | null
    targetTotal: number | null
    selectedTotal: number | null
    selectedDefault: number | null
    selectedTopup: number | null
    shortfall: number | null
  } | null
  runs: {
    runAt: string
    agents: number | null
    days: number | null
    leadsPerAgentDay: number | null
    targetTotal: number | null
    selectedTotal: number | null
    selectedDefault: number | null
    selectedTopup: number | null
  }[]
  /** Set when the balanced process has not been stood up in this environment. */
  notConfigured?: string
}

/** Object not there yet, as opposed to a real failure. */
function isMissingObject(message: string): boolean {
  return /does not exist or not authorized|Object .* does not exist/i.test(message)
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "reporting")
  if (guard instanceof NextResponse) return guard

  // Availability is joined to the band ranges in SQL rather than bucketed in
  // TypeScript: the bands are configuration and can be edited between runs, so
  // the join has to use the same SCORE_MIN..SCORE_MAX the procedure uses or the
  // report and the allocation would disagree about what a band is.
  const bandsSql = `
    WITH cfg AS (
      SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, WEIGHT, TARGET_ROWS,
             TOPUP_ENABLED, ENABLED
      FROM ${BANDS}
    ),
    pool AS (
      SELECT 'default' AS POOL, XDSPRESAGE3::INT AS SCORE
      FROM ${POOL_DEFAULT}
      WHERE LEAD_DESCRIPTION = 'ONAIR 5' AND CONTACTNUMBER1 IS NOT NULL
      UNION ALL
      SELECT 'topup', XDSPRESAGE3::INT
      FROM ${POOL_TOPUP}
      WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION' AND CONTACTNUMBER1 IS NOT NULL
    ),
    avail AS (
      SELECT c.BAND_LABEL,
             COUNT_IF(p.POOL = 'default') AS AVAIL_DEFAULT,
             COUNT_IF(p.POOL = 'topup')   AS AVAIL_TOPUP
      FROM cfg c
      LEFT JOIN pool p ON p.SCORE BETWEEN c.SCORE_MIN AND c.SCORE_MAX
      GROUP BY 1
    ),
    alloc AS (
      SELECT SCOREGROUP AS BAND_LABEL,
             COUNT_IF(SOURCE_POOL = 'default') AS ALLOC_DEFAULT,
             COUNT_IF(SOURCE_POOL = 'topup')   AS ALLOC_TOPUP,
             MAX(BAND_QUOTA)                   AS QUOTA
      FROM ${ALLOCATED}
      GROUP BY 1
    )
    SELECT c.BAND_LABEL, c.SCORE_MIN, c.SCORE_MAX, c.WEIGHT, c.TARGET_ROWS,
           c.TOPUP_ENABLED, c.ENABLED,
           COALESCE(v.AVAIL_DEFAULT, 0) AS AVAIL_DEFAULT,
           COALESCE(v.AVAIL_TOPUP, 0)   AS AVAIL_TOPUP,
           COALESCE(a.ALLOC_DEFAULT, 0) AS ALLOC_DEFAULT,
           COALESCE(a.ALLOC_TOPUP, 0)   AS ALLOC_TOPUP,
           a.QUOTA
    FROM cfg c
    LEFT JOIN avail v ON v.BAND_LABEL = c.BAND_LABEL
    LEFT JOIN alloc a ON a.BAND_LABEL = c.BAND_LABEL
    ORDER BY c.SCORE_MIN`

  const runsSql = `
    SELECT TO_VARCHAR(RUN_AT, 'YYYY-MM-DD HH24:MI') AS RUN_AT,
           AGENTS, DAYS, LEADS_PER_AGENT_DAY, TARGET_TOTAL,
           SELECTED_TOTAL, SELECTED_DEFAULT, SELECTED_TOPUP, SHORTFALL
    FROM ${RUNS}
    ORDER BY RUN_AT DESC
    LIMIT 20`

  try {
    const bandRows = await executeSnowflakeQuery<Record<string, unknown>>(bandsSql, SF)

    // The run log is a nicety — an empty or missing one must not cost you the
    // report itself.
    let runRows: Record<string, unknown>[] = []
    try {
      runRows = await executeSnowflakeQuery<Record<string, unknown>>(runsSql, SF)
    } catch (error) {
      console.warn("[/api/reporting/pool-allocation] run log unavailable:", error)
    }

    const bands: PoolBand[] = bandRows.map((r) => ({
      band: String(r.BAND_LABEL ?? ""),
      scoreMin: num(r.SCORE_MIN),
      scoreMax: num(r.SCORE_MAX),
      weight: numOrNull(r.WEIGHT) ?? 1,
      targetOverride: numOrNull(r.TARGET_ROWS),
      topupEnabled: r.TOPUP_ENABLED !== false,
      enabled: r.ENABLED !== false,
      availDefault: num(r.AVAIL_DEFAULT),
      availTopup: num(r.AVAIL_TOPUP),
      allocDefault: num(r.ALLOC_DEFAULT),
      allocTopup: num(r.ALLOC_TOPUP),
      quota: numOrNull(r.QUOTA),
    }))

    const runs = runRows.map((r) => ({
      runAt: String(r.RUN_AT ?? ""),
      agents: numOrNull(r.AGENTS),
      days: numOrNull(r.DAYS),
      leadsPerAgentDay: numOrNull(r.LEADS_PER_AGENT_DAY),
      targetTotal: numOrNull(r.TARGET_TOTAL),
      selectedTotal: numOrNull(r.SELECTED_TOTAL),
      selectedDefault: numOrNull(r.SELECTED_DEFAULT),
      selectedTopup: numOrNull(r.SELECTED_TOPUP),
    }))

    const first = runRows[0]
    const lastRun = first
      ? {
          runAt: String(first.RUN_AT ?? ""),
          agents: numOrNull(first.AGENTS),
          days: numOrNull(first.DAYS),
          leadsPerAgentDay: numOrNull(first.LEADS_PER_AGENT_DAY),
          targetTotal: numOrNull(first.TARGET_TOTAL),
          selectedTotal: numOrNull(first.SELECTED_TOTAL),
          selectedDefault: numOrNull(first.SELECTED_DEFAULT),
          selectedTopup: numOrNull(first.SELECTED_TOPUP),
          shortfall: numOrNull(first.SHORTFALL),
        }
      : null

    const data: PoolAllocationData = { bands, lastRun, runs }
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isMissingObject(message)) {
      // The balanced process has not been created here yet. Say which piece is
      // missing rather than returning an empty report that looks like real data.
      return NextResponse.json({
        bands: [],
        lastRun: null,
        runs: [],
        notConfigured: message,
      } satisfies PoolAllocationData)
    }
    console.error("[/api/reporting/pool-allocation] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
