import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  IS_FIRST,
  PAID,
  SCORE_NUM,
  VAS,
  bandExprs,
  escSql,
  num,
  numOrNull,
  filterClauses,
  rate,
  readFilters,
  resolveSourceTable,
  validateDates,
} from "@/lib/quality-mix-sql"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * VAS paid, telco declined — first collections where the two disagree.
 *
 * THE QUESTION. On a first collection a customer can have the VAS billed
 * successfully while the telco line is declined: they are charged for the
 * add-on but the service it attaches to never collected. That is a refund and
 * complaint exposure, and it quietly inflates VAS attach revenue.
 *
 * Reads the same object as the Quality mix report (QUALITY_MIX_SOURCE_TABLE,
 * defaulting to VW_QUALITY_MIX_BASE), with the same filters and the same
 * definitions imported from lib/quality-mix-sql.ts rather than restated. Two
 * reports under one heading that disagree about what "paid" means, or band a
 * score differently, produce figures nobody can add up.
 *
 * -----------------------------------------------------------------------------
 * THE PAIR IS (CUSTOMER, PERIOD), NOT THE ACCOUNT
 *
 * Each product bills on its own row, with VAS_BUTTON_FLAG marking which side.
 * The two rows only describe the same event if they are the same customer AND
 * the same billing period — a VAS first billed in March against a telco first
 * billed in July is two different things, and pairing them would report a
 * disagreement that never happened.
 *
 * So the pivot key is ACCOUNTNO + billing month. Rows that do not pair land in
 * `oneSideOnly` and are excluded from every rate, because an attempt with no
 * counterpart cannot agree or disagree and leaving it in the denominator would
 * understate the rate without appearing to.
 *
 * ACCOUNTNO is the customer key available here: VW_QUALITY_MIX_BASE omits
 * IDNUMBER by design (POPIA), so two accounts belonging to one person cannot be
 * linked and are not claimed to be.
 *
 * -----------------------------------------------------------------------------
 * DEDUPLICATED PER SIDE, WHICH IS THE BUG NEXT DOOR
 *
 * quality-mix picks the first-collection row with PARTITION BY ACCOUNTNO alone,
 * which collapses the VAS and telco rows into whichever billed first. Its own
 * comment records the symptom — "the test extract contained an account with two
 * rows flagged as first collection" — without the cause. Here the partition
 * carries the side as well. Flagged, not fixed there: it moves a published rate.
 *
 * -----------------------------------------------------------------------------
 * "DECLINED" IS ANY UNPAID OUTCOME
 *
 * PAID_FLAG = 0, the same definition FID already uses, so this reconciles
 * against Quality mix instead of being a second and quieter standard. Disputes
 * and suspensions therefore count; UNPAID_GROUP_DESCRIPTION breaks the
 * composition back out so nothing is hidden by the choice.
 */

type AggRow = {
  KIND: string
  K1: string | null
  BAND_SORT: number | string | null
  PAIRS: number | string
  BOTH_PAID: number | string
  VAS_ONLY_PAID: number | string
  TELCO_ONLY_PAID: number | string
  NEITHER_PAID: number | string
  VAS_REVENUE_AT_RISK: number | string | null
  TELCO_ATTEMPTED: number | string | null
}

type DrillRow = {
  ACCOUNTNO: string | null
  POLICYNO: string | null
  PERIOD: string | null
  SALE_DATE: string | null
  BAND: string | null
  VAS_AMOUNT: number | string | null
  TELCO_AMOUNT: number | string | null
  TELCO_REASON: string | null
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "reporting")
  if (guard instanceof NextResponse) return guard

  const { table, error: tableError } = resolveSourceTable()
  if (tableError) return NextResponse.json({ error: tableError }, { status: 400 })
  const [database, schema] = table.split(".")
  const SF = { database, schema } as const

  const { searchParams } = new URL(request.url)
  const f = readFilters(searchParams)
  const dateError = validateDates(f)
  if (dateError) return NextResponse.json({ error: dateError }, { status: 400 })

  const band = bandExprs(f.bandMode)

  // Paging for the affected-customers table. Defaulted rather than rejected, so
  // a hand-edited URL renders a sane page instead of an error.
  const limitRaw = Number(searchParams.get("limit") ?? 50)
  const offsetRaw = Number(searchParams.get("offset") ?? 0)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  // A page change redraws ONE table. Re-running the five grouped scans behind
  // the tiles to do it would be wasted work, and they cannot change when only
  // the offset does.
  const accountsOnly = searchParams.get("part") === "accounts"

  // The billing period. BILLINGDATE is when it actually billed; SCHEDULEDATE is
  // the fallback for a row that never reached a billing date, so an attempt is
  // never dropped from its own period for having failed early.
  const PERIOD = `TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
      TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)),
      TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)))), 'YYYY-MM')`

  // Row-level filters MINUS the product one. Products are applied per ACCOUNT
  // below: VAS and telco are different products, so filtering rows by product
  // group would delete one side of every pair and the report would correctly
  // conclude nothing disagrees — an empty screen that reads like a clean result.
  const rowFilters = filterClauses({ ...f, products: [] })
  const where = `WHERE ${rowFilters.join(" AND ")}`
  const productClause =
    f.products.length > 0
      ? `AND ACCOUNTNO IN (
           SELECT ACCOUNTNO FROM ${table}
            ${where}
              AND ${IS_FIRST}
              AND PRODUCT_GROUPS IN (${f.products.map((p) => `'${escSql(p)}'`).join(",")}))`
      : ""

  const cte = `
    WITH scoped AS (
      SELECT * FROM ${table} ${where}
    ),
    first_rows AS (
      SELECT
        ACCOUNTNO,
        POLICYNO,
        ${PERIOD} AS PERIOD,
        TRY_TO_DATE(TO_VARCHAR(SALESDATE)) AS SALE_DATE,
        ${SCORE_NUM} AS SCORE_NUM,
        SCOREGROUP AS SCOREGROUP_VAL,
        UPPER(REPLACE(BRAND, ' ', '')) AS BRAND_VAL,
        CHANNEL AS CHANNEL_VAL,
        ${VAS} AS VAS_FLAG,
        ${PAID} AS PAID,
        UNPAID_GROUP_DESCRIPTION AS REASON,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(BILLED_AMOUNT)), 0) AS AMOUNT,
        ROW_NUMBER() OVER (
          PARTITION BY ACCOUNTNO, ${PERIOD}, ${VAS}
          ORDER BY TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)) NULLS LAST,
                   TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)) NULLS LAST
        ) AS RN
      FROM scoped
      WHERE ${IS_FIRST} ${productClause}
    ),
    pairs AS (
      SELECT
        ACCOUNTNO,
        PERIOD,
        -- One row per side after RN = 1, so MAX is picking that single value.
        MAX(IFF(VAS_FLAG = 1, PAID, NULL))   AS VAS_PAID,
        MAX(IFF(VAS_FLAG = 0, PAID, NULL))   AS TELCO_PAID,
        MAX(IFF(VAS_FLAG = 1, AMOUNT, NULL)) AS VAS_AMOUNT,
        MAX(IFF(VAS_FLAG = 0, AMOUNT, NULL)) AS TELCO_AMOUNT,
        MAX(IFF(VAS_FLAG = 0, REASON, NULL)) AS TELCO_REASON,
        MAX(IFF(VAS_FLAG = 1, POLICYNO, NULL)) AS VAS_POLICY,
        -- Sale attributes are constant across an account's rows, so either side
        -- gives the same answer; the telco side is preferred only so the choice
        -- is deterministic rather than dependent on which row sorted first.
        COALESCE(MAX(IFF(VAS_FLAG = 0, SALE_DATE, NULL)), MAX(SALE_DATE))       AS SALE_DATE,
        COALESCE(MAX(IFF(VAS_FLAG = 0, SCORE_NUM, NULL)), MAX(SCORE_NUM))       AS SCORE_NUM,
        COALESCE(MAX(IFF(VAS_FLAG = 0, SCOREGROUP_VAL, NULL)), MAX(SCOREGROUP_VAL)) AS SCOREGROUP_VAL,
        COALESCE(MAX(IFF(VAS_FLAG = 0, BRAND_VAL, NULL)), MAX(BRAND_VAL))       AS BRAND,
        COALESCE(MAX(IFF(VAS_FLAG = 0, CHANNEL_VAL, NULL)), MAX(CHANNEL_VAL))   AS CHANNEL
      FROM first_rows
      WHERE RN = 1
      GROUP BY ACCOUNTNO, PERIOD
    ),
    banded AS (
      SELECT p.*, ${band.band} AS BAND, ${band.sort} AS BAND_SORT
      FROM pairs p
    ),
    joined AS (
      SELECT * FROM banded${
        f.bands.length > 0
          ? ` WHERE BAND IN (${f.bands.map((b) => `'${escSql(b)}'`).join(",")})`
          : ""
      }
    ),
    -- Only a pair can agree or disagree. A lone attempt is reported separately
    -- rather than counted as agreement.
    paired AS (
      SELECT * FROM joined WHERE VAS_PAID IS NOT NULL AND TELCO_PAID IS NOT NULL
    )`

  const aggSql = `${cte}
    SELECT
      'total' AS KIND,
      CAST(NULL AS VARCHAR) AS K1,
      CAST(NULL AS NUMBER) AS BAND_SORT,
      COUNT(*) AS PAIRS,
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 1, 1, 0)) AS BOTH_PAID,
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, 1, 0)) AS VAS_ONLY_PAID,
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 1, 1, 0)) AS TELCO_ONLY_PAID,
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 0, 1, 0)) AS NEITHER_PAID,
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(VAS_AMOUNT, 0), 0)) AS VAS_REVENUE_AT_RISK,
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(TELCO_AMOUNT, 0), 0)) AS TELCO_ATTEMPTED
    FROM paired

    UNION ALL

    SELECT 'band', BAND, MIN(BAND_SORT), COUNT(*),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(VAS_AMOUNT, 0), 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(TELCO_AMOUNT, 0), 0))
    FROM paired GROUP BY BAND

    UNION ALL

    -- Reason is the TELCO row's, since that is the side that declined.
    SELECT 'reason', COALESCE(NULLIF(TRIM(TELCO_REASON), ''), '(none)'),
      CAST(NULL AS NUMBER), COUNT(*),
      0, COUNT(*), 0, 0,
      SUM(COALESCE(VAS_AMOUNT, 0)),
      SUM(COALESCE(TELCO_AMOUNT, 0))
    FROM paired WHERE VAS_PAID = 1 AND TELCO_PAID = 0
    GROUP BY 2

    UNION ALL

    SELECT 'brand', COALESCE(NULLIF(TRIM(BRAND), ''), '(none)'),
      CAST(NULL AS NUMBER), COUNT(*),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(VAS_AMOUNT, 0), 0)),
      CAST(NULL AS NUMBER)
    FROM paired GROUP BY 2

    UNION ALL

    SELECT 'period', PERIOD, CAST(NULL AS NUMBER), COUNT(*),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 1, 1, 0)),
      SUM(IFF(VAS_PAID = 0 AND TELCO_PAID = 0, 1, 0)),
      SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, COALESCE(VAS_AMOUNT, 0), 0)),
      CAST(NULL AS NUMBER)
    FROM paired WHERE PERIOD IS NOT NULL GROUP BY 2

    UNION ALL

    -- Not a rate, a caveat: attempts with no counterpart in their own period.
    SELECT 'unpaired', CAST(NULL AS VARCHAR), CAST(NULL AS NUMBER), COUNT(*),
      0,
      SUM(IFF(VAS_PAID IS NOT NULL, 1, 0)),
      SUM(IFF(TELCO_PAID IS NOT NULL, 1, 0)),
      0, CAST(NULL AS NUMBER), CAST(NULL AS NUMBER)
    FROM joined WHERE VAS_PAID IS NULL OR TELCO_PAID IS NULL`

  const drillSql = `${cte}
    SELECT ACCOUNTNO, VAS_POLICY AS POLICYNO, PERIOD,
           TO_CHAR(SALE_DATE, 'YYYY-MM-DD') AS SALE_DATE,
           BAND, VAS_AMOUNT, TELCO_AMOUNT,
           COALESCE(NULLIF(TRIM(TELCO_REASON), ''), '(none)') AS TELCO_REASON
      FROM paired
     WHERE VAS_PAID = 1 AND TELCO_PAID = 0
     -- THE TIEBREAKER IS NOT TIDYING. VAS is typically one price — every row in
     -- the first screenshot of this table was R 195 — so VAS_AMOUNT alone
     -- leaves the whole sort key tied, and Snowflake gives no stable order
     -- among tied rows. LIMIT/OFFSET over that returns the same customer on two
     -- pages and silently drops another. ACCOUNTNO + PERIOD is the pivot key and
     -- therefore unique per row, which is what makes the order total.
     ORDER BY VAS_AMOUNT DESC NULLS LAST, ACCOUNTNO, PERIOD
     LIMIT ${limit} OFFSET ${offset}`

  // A validator should never be handed a paraphrase of the query.
  if (searchParams.get("sql") === "1") {
    return NextResponse.json({ table, aggSql, drillSql })
  }

  const mapDrill = (rows: DrillRow[]) =>
    rows.map((r) => ({
      accountNo: r.ACCOUNTNO ?? "",
      policyNo: r.POLICYNO ?? "",
      period: r.PERIOD ?? "",
      saleDate: r.SALE_DATE ?? "",
      band: r.BAND ?? "unknown",
      vasAmount: num(r.VAS_AMOUNT),
      telcoAmount: num(r.TELCO_AMOUNT),
      reason: r.TELCO_REASON ?? "(none)",
    }))

  try {
    if (accountsOnly) {
      const rows = await executeSnowflakeQuery<DrillRow>(drillSql, SF)
      // No total here on purpose: it is `totals.vasOnlyPaid` from the last full
      // run, and turning a page cannot change it.
      return NextResponse.json({ accounts: mapDrill(rows), limit, offset })
    }

    const [agg, drill, options, bandOptions] = await Promise.all([
      executeSnowflakeQuery<AggRow>(aggSql, SF),
      executeSnowflakeQuery<DrillRow>(drillSql, SF),
      // WHAT THE PICKERS LIST. Scoped by DATE ONLY, deliberately: filtered by
      // the current selection they would collapse to it, and a dropdown that
      // only offers what you already chose cannot be changed. Same query and
      // same reasoning as the quality-mix route.
      //
      // PAIRS rather than two independent lists, so the product list can
      // cascade off the chosen brand client-side with no extra round trip.
      executeSnowflakeQuery<{ BRAND: string | null; PRODUCT: string | null }>(
        `SELECT DISTINCT
           UPPER(REPLACE(BRAND, ' ', '')) AS BRAND,
           PRODUCT_GROUPS AS PRODUCT
         FROM ${table}
         WHERE TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${f.startDate}' AND '${f.endDate}'
           AND BRAND IS NOT NULL AND TRIM(BRAND) <> ''
           AND PRODUCT_GROUPS IS NOT NULL AND TRIM(PRODUCT_GROUPS) <> ''
         ORDER BY 1, 2`,
        SF
      ),
      // Bands under the current brand/product, ignoring the BAND filter itself
      // for the same reason.
      executeSnowflakeQuery<{ BAND: string | null; BAND_SORT: number | string }>(
        `SELECT
           COALESCE(NULLIF(TRIM(SCOREGROUP), ''), 'unknown') AS BAND,
           MIN(COALESCE(TRY_TO_NUMBER(REGEXP_SUBSTR(TRIM(SCOREGROUP), '^[0-9]+')), 99999)) AS BAND_SORT
         FROM ${table} ${where}
         GROUP BY 1
         ORDER BY 2, 1`,
        SF
      ),
    ])

    const of = (kind: string) => agg.filter((r) => r.KIND === kind)
    const t = of("total")[0]
    const unpaired = of("unpaired")[0]

    const pairs = num(t?.PAIRS)
    const vasOnly = num(t?.VAS_ONLY_PAID)

    const group = (kind: string) =>
      of(kind)
        .map((r) => ({
          key: r.K1 ?? "(none)",
          sort: numOrNull(r.BAND_SORT),
          pairs: num(r.PAIRS),
          bothPaid: num(r.BOTH_PAID),
          vasOnlyPaid: num(r.VAS_ONLY_PAID),
          telcoOnlyPaid: num(r.TELCO_ONLY_PAID),
          neitherPaid: num(r.NEITHER_PAID),
          vasRevenueAtRisk: num(r.VAS_REVENUE_AT_RISK),
          rate: rate(num(r.VAS_ONLY_PAID), num(r.PAIRS)),
        }))
        .sort((a, b) =>
          a.sort !== null && b.sort !== null
            ? a.sort - b.sort
            : b.vasOnlyPaid - a.vasOnlyPaid || a.key.localeCompare(b.key)
        )

    return NextResponse.json({
      table,
      filters: f,
      totals: {
        pairs,
        bothPaid: num(t?.BOTH_PAID),
        vasOnlyPaid: vasOnly,
        telcoOnlyPaid: num(t?.TELCO_ONLY_PAID),
        neitherPaid: num(t?.NEITHER_PAID),
        vasRevenueAtRisk: num(t?.VAS_REVENUE_AT_RISK),
        telcoAttempted: num(t?.TELCO_ATTEMPTED),
        rate: rate(vasOnly, pairs),
        // The control. If the mirror case is a similar size this is billing
        // noise rather than anything specific to VAS, and the screen says so.
        mirrorRate: rate(num(t?.TELCO_ONLY_PAID), pairs),
      },
      // Excluded from every rate above, and reported so the exclusion is visible.
      unpaired: {
        rows: num(unpaired?.PAIRS),
        vasWithoutTelco: num(unpaired?.VAS_ONLY_PAID),
        telcoWithoutVas: num(unpaired?.TELCO_ONLY_PAID),
      },
      byBand: group("band"),
      byReason: group("reason"),
      byBrand: group("brand"),
      byPeriod: group("period"),
      accounts: mapDrill(drill),
      limit,
      offset,
      // Flat lists for the "all brands" case, plus the pairs the UI cascades on.
      productGroups: [
        ...new Set(options.map((r) => String(r.PRODUCT ?? "").trim()).filter(Boolean)),
      ].sort(),
      brands: [
        ...new Set(options.map((r) => String(r.BRAND ?? "").trim()).filter(Boolean)),
      ].sort(),
      brandProducts: options
        .map((r) => ({
          brand: String(r.BRAND ?? "").trim(),
          product: String(r.PRODUCT ?? "").trim(),
        }))
        .filter((r) => r.brand && r.product),
      bandOptions: bandOptions.map((r) => String(r.BAND ?? "unknown")).filter(Boolean),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/reporting/vas-telco-split] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
