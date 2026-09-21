import { lit } from "@/lib/sql-literal"
import { MAP_TABLE } from "@/lib/dialler-campaign-map"

/**
 * The dialler call fact — one row per call attempt.
 *
 * REPLACES VW_DIALLER_STATS, which was pre-aggregated and cost the report
 * almost everything a dialler report is for:
 *
 *   * It had NO CAMPAIGN ID, only CAMPAIGN_NAME, so the campaign mapping had to
 *     translate a selection into Yaxxa NAMES and match on strings. This table
 *     carries CAMP_ID, so the mapping joins on the id it is keyed on and the
 *     name matching disappears entirely.
 *   * Its SCORE and SCOREGROUP were empty — the score grid rendered every lead
 *     in one "(none)" band. They are populated here.
 *   * LEADS was a measure, so nothing could be counted per call, per customer,
 *     or per outcome. Here a row IS a call, and RSA_ID identifies the person.
 *   * It had no timings, so connect rate, abandon rate and time-to-answer were
 *     not expressible at all.
 *
 * -----------------------------------------------------------------------------
 * THE DEDUPLICATION IS NOT OPTIONAL
 *
 * The table is reloaded, so a CALL_ID appears once per load with the later rows
 * superseding the earlier. Every figure has to be taken from the latest row per
 * call — the query the business supplied does this and so does everything here.
 * Without it a re-loaded day counts twice, and nothing on screen would look
 * wrong.
 *
 * -----------------------------------------------------------------------------
 * TENANT 1002
 *
 * The dialler is multi-tenant, the same way CAMPAIGN_MASTER is: tenants 1000
 * and 1001 carry Internal and test campaigns. Reporting on another tenant's
 * calls would be quietly wrong rather than an error, so the filter is applied
 * here rather than left to each caller to remember.
 */
export const FACT_TABLE = "DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER"
export const FACT_SF_OPTS = { database: "DATAWAREHOUSE", schema: "CX_PRODUCTION" } as const

export const TENANT_ID = 1002

/**
 * Local time for the intraday buckets.
 *
 * INHERITED, NOT VERIFIED. The previous report shifted VW_DIALLER_STATS by +2
 * hours for SAST, so its upstream was UTC and this table is the same feed. But
 * CALL_DATE exists alongside CALL_START_TIME, which is what a source that has
 * already localised the date looks like — so the shift is a single constant
 * here, and scripts/dialler/04-fact-source.sql section 3 is the check that
 * settles it. If the busy hours land two hours out, this is the line to change.
 */
export const SAST_SHIFT_HOURS = 2

const LOCAL_START = `TIMEADD(HOUR, ${SAST_SHIFT_HOURS}, CALL_START_TIME)`

/** Half-hour slot of the local call start, as HH:MM. */
export const HALF_HOUR_BUCKET = `TO_CHAR(TIME_SLICE(${LOCAL_START}, 30, 'MINUTE'), 'HH24:MI')`

/** The calendar day a call belongs to. CALL_DATE is already day-grain. */
export const CALL_DAY = `TO_CHAR(CAST(CALL_DATE AS DATE), 'YYYY-MM-DD')`

/**
 * Outcome, derived from TIMINGS rather than from parsing CALL_STATUS strings.
 *
 * Nobody has written down what each status value means, and the spelling does
 * not settle it — "ANSWERED" could be the switch or the person, and those give
 * different answers to the same question. A non-null answer time is not open to
 * interpretation: the customer picked up, or they did not.
 *
 * `> 0` as well as non-null because a zero-second answer is the switch, not a
 * human, and counting those inflates connect rate.
 */
/*
 * THESE ARE DERIVED, NOT COLUMNS. The table stores timestamps —
 * CALL_ANSWER_TIME, CALL_AGENT_TIME, CALL_HANGUP_TIME — and the elapsed
 * seconds come from DATEDIFF against CALL_START_TIME, exactly as the query the
 * business supplied does. Projected once in baseCte so every downstream
 * expression reads a name rather than repeating the arithmetic.
 */
export const TIME_TO_ANSWER = `DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME)`
export const TIME_TO_AGENT = `DATEDIFF(second, CALL_START_TIME, CALL_AGENT_TIME)`
export const TIME_TO_HANGUP = `DATEDIFF(second, CALL_START_TIME, CALL_HANGUP_TIME)`

export const CONNECTED = `(SECS_TO_ANSWER IS NOT NULL AND SECS_TO_ANSWER > 0)`
export const AGENT_CONNECTED = `(SECS_TO_AGENT IS NOT NULL AND SECS_TO_AGENT > 0)`

/** Score, with 0 and non-numeric treated as unscored — the CREDITRISK sentinel. */
export const SCORE_NUM = `NULLIF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)), 0)`

/**
 * The score band.
 *
 * SCOREGROUP3 first, since it is CREDITRISK's own banding and the rest of the
 * portal speaks it. The derived 50-point band is the fallback, using the same
 * expression as app/api/dashboard/leads-loaded/route.ts so the Distributed
 * report and this one band a lead identically.
 */
export const SCORE_BAND = `COALESCE(
    NULLIF(TRIM(SCOREGROUP), ''),
    CASE
      WHEN ${SCORE_NUM} IS NULL THEN NULL
      WHEN ${SCORE_NUM} < 600 THEN '0-599'
      WHEN ${SCORE_NUM} >= 900 THEN '900+'
      ELSE TO_VARCHAR(FLOOR(${SCORE_NUM} / 50) * 50) || '-'
        || TO_VARCHAR(FLOOR(${SCORE_NUM} / 50) * 50 + 49)
    END,
    '(none)')`

export type FactScope = {
  startDate: string
  endDate: string
  /** SilverSurfer campaign ids from the picker. Empty means every mapped campaign. */
  ssIds: string[]
  callStatuses: string[]
}

/**
 * Which calls are in scope.
 *
 * THE CAMPAIGN PREDICATE IS AN ID JOIN, NOT A NAME MATCH. CAMP_ID here is the
 * same id TSK_CAMPAIGN_DIALLER_MAP is keyed on, so a selection resolves through
 * the mapping without any string comparison — which is what the previous
 * report had to do, and what made it match only by coincidence.
 *
 * WITH NOTHING SELECTED the scope is every MAPPED campaign, not every campaign
 * in the dialler. The picker offers only mapped campaigns, so "All dialler
 * campaigns" has to mean the same set or the total exceeds the sum of its
 * parts and nothing says why.
 */
export function scopeClauses(scope: FactScope): string[] {
  const mapped =
    scope.ssIds.length > 0
      ? `SELECT YAXXA_CAMPAIGNID FROM ${MAP_TABLE} WHERE SS_CAMPAIGNID IN (${scope.ssIds
          .map((id) => lit(id))
          .join(", ")})`
      : `SELECT YAXXA_CAMPAIGNID FROM ${MAP_TABLE}`
  return [
    `TENANT_ID = ${TENANT_ID}`,
    `CAST(CALL_DATE AS DATE) BETWEEN ${lit(scope.startDate)} AND ${lit(scope.endDate)}`,
    `CAST(CAMP_ID AS VARCHAR) IN (${mapped})`,
    scope.callStatuses.length > 0
      ? `CALL_STATUS IN (${scope.callStatuses.map((s) => lit(s)).join(", ")})`
      : "",
  ].filter(Boolean)
}

/**
 * The deduplicated base CTE every query starts from.
 *
 * `dateOverride` exists for the forecast windows, which reuse every filter
 * except the date — the intraday shape has to come from OTHER days, since the
 * selected one is what is being projected.
 */
export function baseCte(
  scope: FactScope,
  alias = "calls",
  dateOverride?: { startDate: string; endDate: string }
): string {
  const effective = dateOverride ? { ...scope, ...dateOverride } : scope
  return (
    `${alias} AS (\n` +
    `  SELECT *,\n` +
    `         ${TIME_TO_ANSWER} AS SECS_TO_ANSWER,\n` +
    `         ${TIME_TO_AGENT}  AS SECS_TO_AGENT,\n` +
    `         ${TIME_TO_HANGUP} AS SECS_TO_HANGUP\n` +
    `    FROM ${FACT_TABLE}\n` +
    `   WHERE ${scopeClauses(effective).join("\n     AND ")}\n` +
    `  QUALIFY ROW_NUMBER() OVER (PARTITION BY CALL_ID ORDER BY LOAD_DATE DESC) = 1\n` +
    `)`
  )
}

/** Which of the selected SilverSurfer campaigns have a Yaxxa campaign mapped. */
export function buildMappedCheck(ssIds: string[]): string {
  const values = ssIds.map((id) => `(${lit(id)})`).join(", ")
  return (
    `WITH SEL AS (SELECT * FROM VALUES ${values} AS v(SS_CAMPAIGNID))\n` +
    `SELECT s.SS_CAMPAIGNID, COUNT(m.YAXXA_CAMPAIGNID) AS MAPPED\n` +
    `  FROM SEL s\n` +
    `  LEFT JOIN ${MAP_TABLE} m ON m.SS_CAMPAIGNID = s.SS_CAMPAIGNID\n` +
    ` GROUP BY s.SS_CAMPAIGNID`
  )
}
