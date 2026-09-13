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
 * The half-hour bucket, shifted +2h for SAST.
 *
 * ONE definition, used by the time series, the heatgrid AND the historical
 * profile. The projection is drawn against the actuals on the same axis, so if
 * the profile bucketed an hour differently the two lines would be offset from
 * each other by half an hour and nothing on screen would say so.
 */
const HALF_HOUR_BUCKET = "TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI')"

/**
 * The score band for the heatgrid.
 *
 * SCOREGROUP IS EMPTY ON THIS VIEW. The grid was rendering every lead in a
 * single '(none)' row — one band, no breakdown, the whole point of the panel
 * gone — and it read as "these leads have no score" rather than "this column is
 * not populated". scripts/dialler-stats.sql section 6b flagged the risk; the
 * report confirmed it.
 *
 * So the band is derived from SCORE when SCOREGROUP is blank, using the same
 * expression as app/api/dashboard/leads-loaded/route.ts:146 so the Distributed
 * report and this one band a lead identically. A score of 0 is the UNSCORED
 * sentinel and stays '(none)' — that is a real answer, not a missing one.
 *
 * If the grid is still one '(none)' row after this, SCORE is empty here too and
 * the credit panel below it is the only place scores exist.
 */
const SCORE_BAND = `COALESCE(
             NULLIF(TRIM(SCOREGROUP), ''),
             CASE
               WHEN TRY_TO_NUMBER(SCORE) IS NULL OR TRY_TO_NUMBER(SCORE) <= 0 THEN NULL
               WHEN TRY_TO_NUMBER(SCORE) < 600 THEN '0-599'
               WHEN TRY_TO_NUMBER(SCORE) >= 900 THEN '900+'
               ELSE TO_VARCHAR(FLOOR(TRY_TO_NUMBER(SCORE) / 50) * 50) || '-'
                 || TO_VARCHAR(FLOOR(TRY_TO_NUMBER(SCORE) / 50) * 50 + 49)
             END,
             '(none)'
           )`

/** Shift an ISO date by whole days, in UTC so it cannot land a day out. */
function dayShift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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

const SCORE_VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_CREDIT_SCORES"
const MAP_VIEW_FOR_SCORES = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP"

type ScoreRow = {
  SCOREGROUP3: string | null
  LEADS: number | string
  SCORED_LEADS: number | string
  UNSCORED_LEADS: number | string
  NO_CREDIT_SNAPSHOT: number | string
  SUM_SCORE3: number | string | null
  SUM_SALARY: number | string | null
  SALARY_LEADS: number | string
  SUM_AVAILABLE_SPEND: number | string | null
  AVAILABLE_SPEND_LEADS: number | string
  SUM_CREDIT_RATIO: number | string | null
  CREDIT_RATIO_LEADS: number | string
  DEBT_REVIEW: number | string
  SEQUESTRATION: number | string
  ADMIN_ORDER: number | string
  DECEASED: number | string
  JUDGEMENT_12M: number | string
  DEFAULTS_12M: number | string
  NO_CREDIT_INFO: number | string
}

/**
 * Credit scores for the selected campaigns.
 *
 * READS A DIFFERENT POPULATION FROM THE REST OF THE PAGE, and the screen says
 * so. Every other figure here counts leads CALLED, from VW_DIALLER_STATS.
 * These count leads DISTRIBUTED, from the HLL — the dialler view is
 * pre-aggregated and carries no id, so there is nothing to join credit data
 * onto. The two are not the same number and must never be added.
 *
 * FILTERED ON THE SILVERSURFER CAMPAIGN, which is what the picker sends anyway.
 * Aggregating the scores up to Yaxxa campaign names would fan out: one
 * SilverSurfer campaign feeds many Yaxxa campaigns, so a campaign running on
 * three dialler campaigns would have each of its distributed leads counted
 * three times. Nothing in the HLL says which Yaxxa campaign a lead ended up on
 * — that is exactly what the dialler knows and the HLL does not.
 *
 * With NOTHING selected the report covers the whole dialler book, so the scores
 * are narrowed to campaigns that HAVE a dialler mapping. Otherwise this panel
 * would quietly include every campaign in the business, dialler or not.
 */
function buildScoreQuery(ssIds: string[], startDate: string, endDate: string): string {
  const scope =
    ssIds.length > 0
      ? `SS_CAMPAIGNID IN (${ssIds.map((id) => `'${escSql(id)}'`).join(",")})`
      : `EXISTS (SELECT 1 FROM ${MAP_VIEW_FOR_SCORES} m WHERE m.SS_CAMPAIGNID = s.SS_CAMPAIGNID)`
  return `SELECT SCOREGROUP3,
                 SUM(LEADS) AS LEADS,
                 SUM(SCORED_LEADS) AS SCORED_LEADS,
                 SUM(UNSCORED_LEADS) AS UNSCORED_LEADS,
                 SUM(NO_CREDIT_SNAPSHOT) AS NO_CREDIT_SNAPSHOT,
                 SUM(SUM_SCORE3) AS SUM_SCORE3,
                 SUM(SUM_SALARY) AS SUM_SALARY,
                 SUM(SALARY_LEADS) AS SALARY_LEADS,
                 SUM(SUM_AVAILABLE_SPEND) AS SUM_AVAILABLE_SPEND,
                 SUM(AVAILABLE_SPEND_LEADS) AS AVAILABLE_SPEND_LEADS,
                 SUM(SUM_CREDIT_RATIO) AS SUM_CREDIT_RATIO,
                 SUM(CREDIT_RATIO_LEADS) AS CREDIT_RATIO_LEADS,
                 SUM(DEBT_REVIEW) AS DEBT_REVIEW,
                 SUM(SEQUESTRATION) AS SEQUESTRATION,
                 SUM(ADMIN_ORDER) AS ADMIN_ORDER,
                 SUM(DECEASED) AS DECEASED,
                 SUM(JUDGEMENT_12M) AS JUDGEMENT_12M,
                 SUM(DEFAULTS_12M) AS DEFAULTS_12M,
                 SUM(NO_CREDIT_INFO) AS NO_CREDIT_INFO
            FROM ${SCORE_VIEW} s
           WHERE ${scope}
             AND LOAD_DATE BETWEEN '${startDate}' AND '${endDate}'
           GROUP BY 1
           ORDER BY 1`
}

/**
 * Roll the bands up into one set of figures.
 *
 * SUMS DIVIDED BY THEIR OWN COUNTS, never an average of the view's averages —
 * that would weight a band of 9 leads the same as one of 9,000. And each
 * measure uses its OWN denominator: salary is populated on a different set of
 * leads from score, so one shared count would be wrong for at least one of
 * them.
 */
function summariseScores(rows: ScoreRow[]) {
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0)
  const sum = (pick: (r: ScoreRow) => unknown) => rows.reduce((a, r) => a + n(pick(r)), 0)
  const ratio = (total: number, count: number) => (count > 0 ? total / count : null)

  const leads = sum((r) => r.LEADS)
  const scored = sum((r) => r.SCORED_LEADS)
  const salaryLeads = sum((r) => r.SALARY_LEADS)
  const spendLeads = sum((r) => r.AVAILABLE_SPEND_LEADS)
  const ratioLeads = sum((r) => r.CREDIT_RATIO_LEADS)

  return {
    bands: rows.map((r) => ({
      band: (r.SCOREGROUP3 ?? "(none)").trim() || "(none)",
      leads: n(r.LEADS),
      scored: n(r.SCORED_LEADS),
      avgScore: ratio(n(r.SUM_SCORE3), n(r.SCORED_LEADS)),
    })),
    totals: {
      leads,
      scored,
      unscored: sum((r) => r.UNSCORED_LEADS),
      noCreditSnapshot: sum((r) => r.NO_CREDIT_SNAPSHOT),
      avgScore: ratio(sum((r) => r.SUM_SCORE3), scored),
      avgSalary: ratio(sum((r) => r.SUM_SALARY), salaryLeads),
      avgAvailableSpend: ratio(sum((r) => r.SUM_AVAILABLE_SPEND), spendLeads),
      avgCreditRatio: ratio(sum((r) => r.SUM_CREDIT_RATIO), ratioLeads),
    },
    flags: {
      debtReview: sum((r) => r.DEBT_REVIEW),
      sequestration: sum((r) => r.SEQUESTRATION),
      adminOrder: sum((r) => r.ADMIN_ORDER),
      deceased: sum((r) => r.DECEASED),
      judgement12m: sum((r) => r.JUDGEMENT_12M),
      defaults12m: sum((r) => r.DEFAULTS_12M),
      noCreditInfo: sum((r) => r.NO_CREDIT_INFO),
    },
  }
}

const EMPTY_FIGURES = {
  totals: {
    totalLeads: 0,
    rows: 0,
    days: 0,
    campaigns: 0,
    avgScore: null as number | null,
    unscoredRows: 0,
  },
  bucketProfile: { buckets: [] as { bucket: string; share: number }[], days: 0, from: "", to: "" },
  dailyHistory: [] as { date: string; leads: number }[],
  historyFrom: null as string | null,
  scores: null as unknown,
  scoresError: null as string | null,
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

    // For the single-day view the half-hour shape has to come from OTHER days —
    // the selected one is the thing being projected. Every filter is reused
    // except the date; four weeks back, ending the day before.
    const profileStart = dayShift(startDate, -28)
    const profileEnd = dayShift(startDate, -1)
    const profileWhere = `
    WHERE ${campaignFilter}
      CALL_START_TIME BETWEEN '${profileStart}' AND '${profileEnd}'
      ${inClause("CALL_STATUS", callStatuses)}
  `

    // The daily forecast must not depend on how wide a range the user happened
    // to pick — "this month" is about three weeks and cannot support
    // day-of-week factors on its own — so it always fits on 12 trailing weeks
    // ending at the selected end date.
    const historyStart = dayShift(endDate, -84)
    const historyWhere = `
    WHERE ${campaignFilter}
      CALL_START_TIME BETWEEN '${historyStart}' AND '${endDate}'
      ${inClause("CALL_STATUS", callStatuses)}
  `

    const [totals, byBucket, byStatus, byCampaign, byScoreDate, bucketProfile, dailyHistory] =
      await Promise.all([
      executeSnowflakeQuery<{
        TOTAL_LEADS: number | string | null
        TOTAL_ROWS: number | string
        DISTINCT_DAYS: number | string
        DISTINCT_CAMPAIGNS: number | string
        AVG_SCORE: number | string | null
        UNSCORED_ROWS: number | string
      }>(
        // ZERO IS NOT A SCORE, it is the unscored sentinel that CREDITRISK uses
        // (SCORE3 = 0 alongside SCOREGROUP3 = '0'). This was a bare AVG(SCORE),
        // so every unscored lead was averaged in as a zero and the tile has
        // been understated for as long as it has existed. The count comes back
        // too, so "excluded" is visible on screen rather than a silent filter.
        `SELECT
           SUM(LEADS) AS TOTAL_LEADS,
           COUNT(*) AS TOTAL_ROWS,
           COUNT(DISTINCT CALL_START_TIME) AS DISTINCT_DAYS,
           COUNT(DISTINCT CAMPAIGN_NAME) AS DISTINCT_CAMPAIGNS,
           AVG(IFF(SCORE > 0, SCORE, NULL)) AS AVG_SCORE,
           COUNT_IF(NVL(SCORE, 0) = 0) AS UNSCORED_ROWS
         FROM ${VIEW}
         ${where}`,
        SF_OPTS
      ),
      // Single day → bucket by 30-min slot (shifted +2h for SAST). Multi-day → bucket by date.
      executeSnowflakeQuery<{ BUCKET: string; LEADS: number | string | null }>(
        startDate === endDate
          ? `SELECT
               ${HALF_HOUR_BUCKET} AS BUCKET,
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
               ${SCORE_BAND} AS SCOREGROUP,
               ${HALF_HOUR_BUCKET} AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`
          : `SELECT
               ${SCORE_BAND} AS SCOREGROUP,
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`,
        SF_OPTS
      ),
      // Half-hour-of-day shape over the trailing four weeks, for the intraday
      // projection. Same bucket expression as the series above, so the two line
      // up on the axis. Not asked for on a multi-day range.
      startDate === endDate
        ? executeSnowflakeQuery<{
            BUCKET: string
            LEADS: number | string | null
            DAYS: number | string
          }>(
            `SELECT
               ${HALF_HOUR_BUCKET} AS BUCKET,
               SUM(LEADS) AS LEADS,
               COUNT(DISTINCT TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD')) AS DAYS
             FROM ${VIEW}
             ${profileWhere}
             GROUP BY 1
             ORDER BY 1`,
            SF_OPTS
          )
        : Promise.resolve([]),
      // Daily series for FITTING the forecast — deliberately wider than the
      // selected range. Not asked for on a single day, which uses the profile.
      startDate === endDate
        ? Promise.resolve([])
        : executeSnowflakeQuery<{ BUCKET: string; LEADS: number | string | null }>(
            `SELECT
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS BUCKET,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${historyWhere}
             GROUP BY 1
             ORDER BY 1`,
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

    // BEST EFFORT, like the health checks in the campaign-map route. The view
    // is deployed separately (scripts/dialler/02-credit-scores.sql) and the app
    // has no grant on CREDITRISK until somebody runs section F — a report that
    // will not load because an optional panel is not provisioned yet is worse
    // than one without the panel.
    let scores: unknown = null
    let scoresError: string | null = null
    try {
      const rows = await executeSnowflakeQuery<ScoreRow>(
        buildScoreQuery(ssIds, startDate, endDate),
        SF_OPTS
      )
      scores = summariseScores(rows)
    } catch (e) {
      scoresError = e instanceof Error ? e.message : String(e)
      console.error("[/api/dashboard/dialler-stats] credit scores failed:", scoresError)
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
      scores,
      scoresError,
      totals: {
        totalLeads: num(t.TOTAL_LEADS),
        rows: num(t.TOTAL_ROWS),
        days: num(t.DISTINCT_DAYS),
        campaigns: num(t.DISTINCT_CAMPAIGNS),
        avgScore: numFloat(t.AVG_SCORE),
        unscoredRows: num(t.UNSCORED_ROWS),
      },
      byBucket: byBucket.map((r) => ({ bucket: r.BUCKET, leads: num(r.LEADS) })),
      // Share of a day's leads landing in each half-hour, over the trailing
      // window. Empty on a multi-day range.
      bucketProfile: (() => {
        const rows = bucketProfile as {
          BUCKET: string
          LEADS: number | string | null
          DAYS: number | string
        }[]
        const total = rows.reduce((a, r) => a + num(r.LEADS), 0)
        if (!(total > 0)) return { buckets: [], days: 0, from: profileStart, to: profileEnd }
        return {
          buckets: rows.map((r) => ({ bucket: r.BUCKET, share: num(r.LEADS) / total })),
          // The busiest bucket's day count, not the sum: a bucket nobody dials
          // in would otherwise drag the reported basis below the real one.
          days: Math.max(...rows.map((r) => Number(r.DAYS) || 0), 0),
          from: profileStart,
          to: profileEnd,
        }
      })(),
      // Trailing daily series the forecast is fitted on, independent of the
      // selected range. Empty on a single-day view.
      dailyHistory: (dailyHistory as { BUCKET: string; LEADS: number | string | null }[]).map(
        (r) => ({ date: r.BUCKET, leads: num(r.LEADS) })
      ),
      historyFrom: historyStart,
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
