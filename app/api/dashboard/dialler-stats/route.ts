import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  MAP_SF_OPTS,
  YAXXA_SOURCE,
  buildYaxxaNamesForSs,
  diallerStatsNameKey,
} from "@/lib/dialler-campaign-map"
import { resolveSourceColumns } from "@/lib/dialler-campaign-columns"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * THE CAMPAIGN FILTER IS A MAPPED FILTER, NOT A NAME MATCH.
 *
 * This view's only campaign column is CAMPAIGN_NAME, and that name comes from
 * YAXXA. The picker on the report lists SILVERSURFER campaigns. Until now the
 * route took `campaignNames` and put the SilverSurfer TITLE straight into the
 * predicate, so it matched only where the two systems happened to spell a
 * campaign identically — and returned an empty report otherwise, with nothing
 * to say why. "All campaigns" looked fine because it sends no predicate.
 *
 * So the route now takes `ssCampaignIds` and translates them through
 * TSK_CAMPAIGN_DIALLER_MAP. IDS, NOT TITLES: a title is a label somebody can
 * rename, and a report filter keyed on one silently changes meaning when they
 * do.
 *
 * THERE IS NO FALLBACK TO THE OLD BEHAVIOUR. A selection with nothing mapped
 * returns no data and says so. Falling back would hide the exact fault this
 * exists to fix, and would hide it by appearing to work.
 */

type MapRow = {
  SS_CAMPAIGNID: string
  YAXXA_CAMPAIGNID: string | null
  YAXXA_NAME: string | null
}

type Resolution = {
  /** What the caller asked for. */
  requestedSsIds: string[]
  mapped: { ssId: string; yaxxaId: string; yaxxaName: string }[]
  /** Selected campaigns with no Yaxxa campaign attached — missing from every figure. */
  unmappedSsIds: string[]
  /** Mapped, but the stats view has no rows under that name in this window. */
  namesWithNoRows: string[]
}

const EMPTY_FIGURES = {
  totals: { totalLeads: 0, rows: 0, days: 0, campaigns: 0, avgScore: null as number | null },
  byBucket: [] as { bucket: string; leads: number }[],
  byStatus: [] as { status: string; leads: number }[],
  byCampaign: [] as { campaignName: string; leads: number }[],
  byScoreDate: [] as { scoreGroup: string; date: string; count: number }[],
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const { searchParams } = new URL(request.url)
  const idsRaw = searchParams.get("ssCampaignIds")
  const startDate = searchParams.get("startDate")
  const endDate = searchParams.get("endDate") ?? startDate

  // No ids at all means EVERY campaign — the report defaults to the whole book
  // rather than refusing to load until something is picked. That path sends no
  // campaign predicate and is deliberately untouched by the mapping.
  const ssIds = Array.from(
    new Set(
      (idsRaw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
  if (ssIds.length > 200) {
    return NextResponse.json({ error: "Max 200 campaigns per request" }, { status: 400 })
  }
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json(
      { error: "startDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json(
      { error: "endDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (startDate > endDate) {
    return NextResponse.json(
      { error: "startDate must be on or before endDate" },
      { status: 400 }
    )
  }

  const collectMulti = (key: string): string[] => {
    const raw = searchParams.get(key)
    if (!raw) return []
    return Array.from(
      new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    )
  }
  const callStatuses = collectMulti("callStatuses")

  try {
    // ------------------------------------------------ selection → Yaxxa names
    let resolution: Resolution | null = null
    let names: string[] = []

    if (ssIds.length > 0) {
      // A failed probe is not fatal here: the map stores a snapshot of the
      // Yaxxa name at attach time, and a report that filters on a slightly
      // stale name beats one that will not load.
      const yaxxaCols = await resolveSourceColumns(YAXXA_SOURCE).catch(() => null)
      const rows = await executeSnowflakeQuery<MapRow>(
        buildYaxxaNamesForSs(ssIds, yaxxaCols),
        MAP_SF_OPTS
      )

      const mapped: Resolution["mapped"] = []
      const withSomething = new Set<string>()
      for (const r of rows) {
        const yaxxaId = r.YAXXA_CAMPAIGNID == null ? "" : String(r.YAXXA_CAMPAIGNID)
        const yaxxaName = (r.YAXXA_NAME == null ? "" : String(r.YAXXA_NAME)).trim()
        if (!yaxxaId) continue
        withSomething.add(String(r.SS_CAMPAIGNID))
        mapped.push({ ssId: String(r.SS_CAMPAIGNID), yaxxaId, yaxxaName })
      }

      // A mapping with no usable name cannot be filtered on, so it counts as
      // mapped (it is) but contributes nothing to the predicate.
      names = Array.from(new Set(mapped.map((m) => m.yaxxaName).filter(Boolean)))

      resolution = {
        requestedSsIds: ssIds,
        mapped,
        unmappedSsIds: ssIds.filter((id) => !withSomething.has(id)),
        namesWithNoRows: [],
      }

      // Nothing to filter on. Returning zeroes with the resolution attached is
      // the honest answer; running the queries with no predicate would report
      // the WHOLE BOOK as if it belonged to the selected campaigns.
      if (names.length === 0) {
        return NextResponse.json({
          campaignNames: [],
          startDate,
          endDate,
          granularity: startDate === endDate ? "halfHour" : "day",
          resolution,
          ...EMPTY_FIGURES,
        })
      }
    }

    const campaignFilter =
      names.length > 0
        ? `TRIM(UPPER(CAMPAIGN_NAME)) IN (` +
          names.map((n) => `'${escSql(diallerStatsNameKey(n))}'`).join(",") +
          `) AND`
        : ""

    const inClause = (col: string, vals: string[]) =>
      vals.length > 0 ? `AND ${col} IN (${vals.map((v) => `'${escSql(v)}'`).join(",")})` : ""

    const where = `
    WHERE ${campaignFilter}
      CALL_START_TIME BETWEEN '${startDate}' AND '${endDate}'
      ${inClause("CALL_STATUS", callStatuses)}
  `

    const [totals, byBucket, byStatus, byCampaign, byScoreDate] = await Promise.all([
      executeSnowflakeQuery<{
        TOTAL_LEADS: number | string | null
        TOTAL_ROWS: number | string
        DISTINCT_DAYS: number | string
        DISTINCT_CAMPAIGNS: number | string
        AVG_SCORE: number | string | null
      }>(
        `SELECT
           SUM(LEADS) AS TOTAL_LEADS,
           COUNT(*) AS TOTAL_ROWS,
           COUNT(DISTINCT CALL_START_TIME) AS DISTINCT_DAYS,
           COUNT(DISTINCT CAMPAIGN_NAME) AS DISTINCT_CAMPAIGNS,
           AVG(SCORE) AS AVG_SCORE
         FROM ${VIEW}
         ${where}`,
        SF_OPTS
      ),
      // Single day → bucket by 30-min slot (shifted +2h for SAST). Multi-day → bucket by date.
      executeSnowflakeQuery<{ BUCKET: string; LEADS: number | string | null }>(
        startDate === endDate
          ? `SELECT
               TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS BUCKET,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`
          : `SELECT
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS BUCKET,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ CALL_STATUS: string | null; LEADS: number | string | null }>(
        `SELECT COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(none)') AS CALL_STATUS, SUM(LEADS) AS LEADS
         FROM ${VIEW}
         ${where}
         GROUP BY 1
         ORDER BY LEADS DESC NULLS LAST`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ CAMPAIGN_NAME: string | null; LEADS: number | string | null }>(
        `SELECT CAMPAIGN_NAME, SUM(LEADS) AS LEADS
         FROM ${VIEW}
         ${where}
         GROUP BY 1
         ORDER BY LEADS DESC NULLS LAST`,
        SF_OPTS
      ),
      // When a single day is selected, bucket the heatgrid by 30-min slot instead of date
      // so the user can see hour-of-day patterns within that day.
      executeSnowflakeQuery<{
        SCOREGROUP: string | null
        DAY: string
        LEADS: number | string | null
      }>(
        startDate === endDate
          ? `SELECT
               COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
               TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`
          : `SELECT
               COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`,
        SF_OPTS
      ),
    ])

    const t = totals[0] ?? {}
    const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)
    const numFloat = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return Number.isFinite(n) ? n : null
    }

    const granularity: "day" | "halfHour" = startDate === endDate ? "halfHour" : "day"

    // A mapping that is right but returns nothing is a DIFFERENT fault from a
    // campaign that was never mapped, and the screen separates them. Compared
    // on the same key the predicate used, or a name that did match would be
    // reported as missing.
    if (resolution) {
      const present = new Set(
        byCampaign.map((r) => diallerStatsNameKey(String(r.CAMPAIGN_NAME ?? "")))
      )
      resolution.namesWithNoRows = names.filter((n) => !present.has(diallerStatsNameKey(n)))
    }

    return NextResponse.json({
      campaignNames: names,
      startDate,
      endDate,
      granularity,
      resolution,
      totals: {
        totalLeads: num(t.TOTAL_LEADS),
        rows: num(t.TOTAL_ROWS),
        days: num(t.DISTINCT_DAYS),
        campaigns: num(t.DISTINCT_CAMPAIGNS),
        avgScore: numFloat(t.AVG_SCORE),
      },
      byBucket: byBucket.map((r) => ({ bucket: r.BUCKET, leads: num(r.LEADS) })),
      byStatus: byStatus.map((r) => ({
        status: r.CALL_STATUS ?? "(none)",
        leads: num(r.LEADS),
      })),
      byCampaign: byCampaign.map((r) => ({
        campaignName: r.CAMPAIGN_NAME ?? "(unnamed)",
        leads: num(r.LEADS),
      })),
      byScoreDate: byScoreDate.map((r) => ({
        scoreGroup: r.SCOREGROUP ?? "(none)",
        date: r.DAY,
        count: num(r.LEADS),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dashboard/dialler-stats] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
