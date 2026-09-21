import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  AGENT_CONNECTED,
  CALL_DAY,
  CONNECTED,
  FACT_SF_OPTS,
  HALF_HOUR_BUCKET,
  SCORE_BAND,
  SCORE_NUM,
  baseCte,
  buildMappedCheck,
  type FactScope,
} from "@/lib/dialler-fact"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const SF_OPTS = FACT_SF_OPTS

function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * The Dialler report, on DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER.
 *
 * ONE ROW PER CALL, not a pre-aggregated measure — see lib/dialler-fact.ts for
 * what that source change buys and what it obliges (deduplicating by CALL_ID,
 * and the tenant filter).
 *
 * THE CAMPAIGN FILTER IS NOW AN ID JOIN. CAMP_ID is the id
 * TSK_CAMPAIGN_DIALLER_MAP is keyed on, so a selection resolves through the
 * mapping with no string comparison anywhere. The previous version had to
 * translate a selection into Yaxxa NAMES because the old view carried no id,
 * and matched only where two systems happened to spell a campaign identically.
 *
 * CONNECT AND ABANDON COME FROM TIMINGS, NOT STATUS STRINGS. Nobody has
 * recorded what each CALL_STATUS value means and the spelling does not settle
 * it. A non-null customer answer time is not open to interpretation.
 */

type Resolution = {
  requestedSsIds: string[]
  unmappedSsIds: string[]
}

const EMPTY_FIGURES = {
  totals: {
    calls: 0,
    customers: 0,
    campaigns: 0,
    days: 0,
    connected: 0,
    agentConnected: 0,
    abandoned: 0,
    connectRate: null as number | null,
    agentRate: null as number | null,
    abandonRate: null as number | null,
    avgSecondsToAnswer: null as number | null,
    avgTalkSeconds: null as number | null,
    avgScore: null as number | null,
    unscoredCalls: 0,
  },
  bucketProfile: { buckets: [] as { bucket: string; share: number }[], days: 0, from: "", to: "" },
  dailyHistory: [] as { date: string; calls: number }[],
  historyFrom: null as string | null,
  byBucket: [] as { bucket: string; calls: number; connected: number }[],
  byStatus: [] as { status: string; calls: number; connected: number }[],
  byHangup: [] as { reason: string; calls: number }[],
  byCampaign: [] as { campaignName: string; calls: number; connected: number }[],
  byScoreDate: [] as { scoreGroup: string; date: string; count: number }[],
  scores: null as unknown,
  scoresError: null as string | null,
}

/** Shift an ISO date by whole days, in UTC so it cannot land a day out. */
function dayShift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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


export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get("startDate")
  const endDate = searchParams.get("endDate") ?? startDate

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
  const ssIds = collectMulti("ssCampaignIds")
  const callStatuses = collectMulti("callStatuses")

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
    return NextResponse.json({ error: "startDate must be on or before endDate" }, { status: 400 })
  }

  const scope: FactScope = { startDate, endDate, ssIds, callStatuses }
  const singleDay = startDate === endDate
  const bucketExpr = singleDay ? HALF_HOUR_BUCKET : CALL_DAY

  // The intraday shape must come from OTHER days — the selected one is what is
  // being projected. Four weeks back, ending the day before.
  const profileStart = dayShift(startDate, -28)
  const profileEnd = dayShift(startDate, -1)
  // The daily forecast must not depend on how wide a range was picked, so it
  // always fits on 12 trailing weeks ending at the selected end date.
  const historyStart = dayShift(endDate, -84)

  try {
    // Which of the selected campaigns have nothing mapped. They contribute no
    // calls, and the screen says so rather than leaving an unexplained gap.
    let resolution: Resolution | null = null
    if (ssIds.length > 0) {
      const rows = await executeSnowflakeQuery<{ SS_CAMPAIGNID: string; MAPPED: number | string }>(
        buildMappedCheck(ssIds),
        { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }
      )
      const mapped = new Set(
        rows.filter((r) => Number(r.MAPPED ?? 0) > 0).map((r) => String(r.SS_CAMPAIGNID))
      )
      resolution = {
        requestedSsIds: ssIds,
        unmappedSsIds: ssIds.filter((id) => !mapped.has(id)),
      }
      // Nothing mapped at all: no predicate could select a call, and running
      // the queries anyway would return the whole book as if it belonged to the
      // selection.
      if (mapped.size === 0) {
        return NextResponse.json({
          startDate,
          endDate,
          granularity: singleDay ? "halfHour" : "day",
          resolution,
          ...EMPTY_FIGURES,
        })
      }
    }

    const base = baseCte(scope)
    const profileBase = baseCte(scope, "calls", {
      startDate: profileStart,
      endDate: profileEnd,
    })
    const historyBase = baseCte(scope, "calls", { startDate: historyStart, endDate: endDate })

    const [totals, byBucket, byStatus, byHangup, byCampaign, byScoreDate, profile, history] =
      await Promise.all([
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT COUNT(*) AS CALLS,
                  COUNT(DISTINCT RSA_ID) AS CUSTOMERS,
                  COUNT(DISTINCT CAMP_ID) AS CAMPAIGNS,
                  COUNT(DISTINCT CAST(CALL_DATE AS DATE)) AS DAYS,
                  COUNT_IF(${CONNECTED}) AS CONNECTED,
                  COUNT_IF(${AGENT_CONNECTED}) AS AGENT_CONNECTED,
                  -- The customer picked up and no agent ever did. THE ONLY
                  -- ABANDON DEFINITION THIS DATA SUPPORTS, and the one that
                  -- matters commercially.
                  COUNT_IF(${CONNECTED} AND NOT ${AGENT_CONNECTED}) AS ABANDONED,
                  AVG(IFF(${CONNECTED}, SECS_TO_ANSWER, NULL)) AS AVG_SECONDS_TO_ANSWER,
                  -- Talk time is hangup minus agent pickup. Negative values are
                  -- clock skew between the two stamps, not short calls, so they
                  -- are dropped rather than averaged in.
                  AVG(IFF(${AGENT_CONNECTED} AND SECS_TO_HANGUP > SECS_TO_AGENT,
                          SECS_TO_HANGUP - SECS_TO_AGENT, NULL)) AS AVG_TALK_SECONDS,
                  AVG(${SCORE_NUM}) AS AVG_SCORE,
                  COUNT_IF(${SCORE_NUM} IS NULL) AS UNSCORED_CALLS
             FROM calls`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT ${bucketExpr} AS BUCKET,
                  COUNT(*) AS CALLS,
                  COUNT_IF(${CONNECTED}) AS CONNECTED
             FROM calls GROUP BY 1 ORDER BY 1`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(none)') AS CALL_STATUS,
                  COUNT(*) AS CALLS,
                  COUNT_IF(${CONNECTED}) AS CONNECTED
             FROM calls GROUP BY 1 ORDER BY CALLS DESC NULLS LAST`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT COALESCE(NULLIF(TRIM(HANGUP_REASON), ''), '(none)') AS HANGUP_REASON,
                  COUNT(*) AS CALLS
             FROM calls GROUP BY 1 ORDER BY CALLS DESC NULLS LAST`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT COALESCE(NULLIF(TRIM(CAMPAIGN), ''), '(unnamed)') AS CAMPAIGN_NAME,
                  COUNT(*) AS CALLS,
                  COUNT_IF(${CONNECTED}) AS CONNECTED
             FROM calls GROUP BY 1 ORDER BY CALLS DESC NULLS LAST`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `WITH ${base}
           SELECT ${SCORE_BAND} AS SCOREGROUP, ${bucketExpr} AS DAY, COUNT(*) AS CALLS
             FROM calls GROUP BY 1, 2 ORDER BY 1, 2`,
          SF_OPTS
        ),
        singleDay
          ? executeSnowflakeQuery<Record<string, unknown>>(
              `WITH ${profileBase}
               SELECT ${HALF_HOUR_BUCKET} AS BUCKET,
                      COUNT(*) AS CALLS,
                      COUNT(DISTINCT CAST(CALL_DATE AS DATE)) AS DAYS
                 FROM calls GROUP BY 1 ORDER BY 1`,
              SF_OPTS
            )
          : Promise.resolve([] as Record<string, unknown>[]),
        singleDay
          ? Promise.resolve([] as Record<string, unknown>[])
          : executeSnowflakeQuery<Record<string, unknown>>(
              `WITH ${historyBase}
               SELECT ${CALL_DAY} AS BUCKET, COUNT(*) AS CALLS
                 FROM calls GROUP BY 1 ORDER BY 1`,
              SF_OPTS
            ),
      ])

    const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)
    const numFloat = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return Number.isFinite(n) ? n : null
    }
    const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

    const t = totals[0] ?? {}
    const calls = num(t.CALLS)
    const connected = num(t.CONNECTED)
    const agentConnected = num(t.AGENT_CONNECTED)

    // Best effort, like the health checks on the campaign-map route. The credit
    // view deploys separately and reads a different source.
    let scores: unknown = null
    let scoresError: string | null = null
    try {
      const rows = await executeSnowflakeQuery<ScoreRow>(
        buildScoreQuery(ssIds, startDate, endDate),
        { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }
      )
      scores = summariseScores(rows)
    } catch (e) {
      scoresError = e instanceof Error ? e.message : String(e)
      console.error("[/api/dashboard/dialler-stats] credit scores failed:", scoresError)
    }

    const profileRows = profile as { BUCKET: string; CALLS: unknown; DAYS: unknown }[]
    const profileTotal = profileRows.reduce((a, r) => a + num(r.CALLS), 0)

    return NextResponse.json({
      startDate,
      endDate,
      granularity: singleDay ? "halfHour" : "day",
      resolution,
      scores,
      scoresError,
      totals: {
        calls,
        customers: num(t.CUSTOMERS),
        campaigns: num(t.CAMPAIGNS),
        days: num(t.DAYS),
        connected,
        agentConnected,
        abandoned: num(t.ABANDONED),
        connectRate: ratio(connected, calls),
        agentRate: ratio(agentConnected, calls),
        // Of the customers who PICKED UP — not of every call. An abandon rate
        // over all dials would be dominated by no-answers, which are not
        // abandons and are not the dialler's failure.
        abandonRate: ratio(num(t.ABANDONED), connected),
        avgSecondsToAnswer: numFloat(t.AVG_SECONDS_TO_ANSWER),
        avgTalkSeconds: numFloat(t.AVG_TALK_SECONDS),
        avgScore: numFloat(t.AVG_SCORE),
        unscoredCalls: num(t.UNSCORED_CALLS),
      },
      byBucket: (byBucket as { BUCKET: string; CALLS: unknown; CONNECTED: unknown }[]).map((r) => ({
        bucket: r.BUCKET,
        calls: num(r.CALLS),
        connected: num(r.CONNECTED),
      })),
      byStatus: (byStatus as { CALL_STATUS: string; CALLS: unknown; CONNECTED: unknown }[]).map(
        (r) => ({ status: r.CALL_STATUS, calls: num(r.CALLS), connected: num(r.CONNECTED) })
      ),
      byHangup: (byHangup as { HANGUP_REASON: string; CALLS: unknown }[]).map((r) => ({
        reason: r.HANGUP_REASON,
        calls: num(r.CALLS),
      })),
      byCampaign: (byCampaign as { CAMPAIGN_NAME: string; CALLS: unknown; CONNECTED: unknown }[]).map(
        (r) => ({ campaignName: r.CAMPAIGN_NAME, calls: num(r.CALLS), connected: num(r.CONNECTED) })
      ),
      byScoreDate: (byScoreDate as { SCOREGROUP: string; DAY: string; CALLS: unknown }[]).map(
        (r) => ({ scoreGroup: r.SCOREGROUP, date: r.DAY, count: num(r.CALLS) })
      ),
      bucketProfile:
        profileTotal > 0
          ? {
              buckets: profileRows.map((r) => ({
                bucket: r.BUCKET,
                share: num(r.CALLS) / profileTotal,
              })),
              // The busiest bucket's day count, not the sum: a slot nobody
              // dials in would otherwise drag the reported basis below the real
              // one.
              days: Math.max(...profileRows.map((r) => num(r.DAYS)), 0),
              from: profileStart,
              to: profileEnd,
            }
          : { buckets: [], days: 0, from: profileStart, to: profileEnd },
      dailyHistory: (history as { BUCKET: string; CALLS: unknown }[]).map((r) => ({
        date: r.BUCKET,
        calls: num(r.CALLS),
      })),
      historyFrom: historyStart,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dashboard/dialler-stats] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
