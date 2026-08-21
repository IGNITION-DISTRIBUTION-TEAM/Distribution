import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Customer quality mix — FTC (first time collection) and FID (first time
 * default) by credit score band, from the billing/collections extract.
 *
 * Grain: the source is one row per collection attempt (many rows per account).
 * The first collection is identified by ISFIRSTCOLLECTION = 1, de-duplicated to
 * the earliest SCHEDULEDATE per account — the test extract contained an account
 * with two rows flagged as first collection, so the flag alone is not unique.
 *
 * Definitions, as confirmed by the business:
 *   FTC = the first collection was paid IN FULL
 *   FID = the exact inverse of FTC
 *
 * So on the matured base the two are complementary and sum to 100%. Disputes
 * and suspensions therefore count as defaults; the reason breakdown still
 * reports them separately so the composition stays visible.
 *
 *   base = accounts that HAVE a first collection (one row each)
 *   FTC  = those where PAID_FLAG = 1 on that row
 *   FID  = those where PAID_FLAG = 0 on that row, split by UNPAID_GROUP_DESCRIPTION
 *
 * Every measure — score band, VAS, price, outcome — is read from the
 * first-collection row, not aggregated across the account's later billing rows.
 * Accounts with no first collection are outside the base entirely and reported
 * as `totals.pending` so the exclusion stays visible.
 *
 * On "in full": this extract cannot express a partial settlement. TOTAL,
 * BILLED_AMOUNT_INCL_VAT and DC_INSTRUCTEDAMOUNT are always equal, so there is
 * no collected-amount separate from the amount instructed — an attempt is paid
 * or it is not. PAID_FLAG was checked against UNPAID_GROUP_DESCRIPTION and
 * TRANSACTIONCLASSNAME across the sample with no disagreement, so "in full" is
 * taken from PAID_FLAG. If the billing platform can record a partial
 * settlement, that amount is NOT in this feed and would need adding before the
 * distinction can be enforced here.
 *
 * Note PRODUCTPRICE is not the amount due: billed amounts legitimately differ
 * from it (pro-rata, plan changes, discounts), so it must not be used to infer
 * underpayment.
 *
 * Score bands are derived from the raw SCORE in 50-point buckets, deliberately
 * NOT from SCOREGROUP: the existing SCOREGROUP labels are narrow percentile
 * bands ("662 to 672", "887 to 907") that cross the round boundaries the
 * business talks in, so "650-699" cannot be assembled from them.
 *
 * Cohorts are by sale month (SALESDATE), taken from the first-collection row.
 * An account with no first collection never enters a rate, so a young cohort
 * cannot read as 0% default.
 *
 * Source object: defaults to the view scripts/quality-mix.sql creates, so the
 * report works as soon as that view exists with no further configuration. Set
 * QUALITY_MIX_SOURCE_TABLE to point somewhere else (a differently-named view, or
 * the raw billing table).
 */

// What scripts/quality-mix.sql builds. Keep the two in step.
const DEFAULT_SOURCE_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE"

const DATE = /^\d{4}-\d{2}-\d{2}$/
const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === "number" ? v : Number(String(v))
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null
  const n = typeof v === "number" ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}
const rate = (a: number, b: number): number | null => (b > 0 ? a / b : null)

// Ordering for the derived bands so the UI doesn't have to know about them.
const BAND_ORDER = [
  "<600",
  "600-649",
  "650-699",
  "700-749",
  "750-799",
  "800-849",
  "850-899",
  "900+",
  "unknown",
]

/**
 * The account's score as a number, with 0 and non-numeric treated as missing so
 * MAX() ignores them rather than letting a placeholder win.
 */
const SCORE_NUM = `NULLIF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)), 0)`

/**
 * Derived 50-point band from an already-numeric score column. Banding happens
 * after aggregating to the account (never as MAX over the band *string* — that
 * sorts 'unknown' above '900+' and would mis-bucket a scored account).
 */
const bandSql = (col: string) => `
  CASE
    WHEN ${col} IS NULL THEN 'unknown'
    WHEN ${col} < 600 THEN '<600'
    WHEN ${col} >= 900 THEN '900+'
    ELSE TO_VARCHAR(FLOOR(${col} / 50) * 50) || '-' || TO_VARCHAR(FLOOR(${col} / 50) * 50 + 49)
  END`

// PAID_FLAG / VAS_BUTTON_FLAG arrive as 0/1, sometimes as text.
const PAID = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0)`
const VAS = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0)`
const IS_FIRST = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1`

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "reporting")
  if (guard instanceof NextResponse) return guard

  const table = (process.env.QUALITY_MIX_SOURCE_TABLE ?? "").trim() || DEFAULT_SOURCE_TABLE
  if (!QUALIFIED.test(table)) {
    return NextResponse.json(
      { error: `QUALITY_MIX_SOURCE_TABLE must be DATABASE.SCHEMA.OBJECT (got "${table}")` },
      { status: 400 }
    )
  }
  const [database, schema] = table.split(".")
  const SF = { database, schema } as const

  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get("startDate") ?? ""
  const endDate = searchParams.get("endDate") ?? startDate
  // Products are multi-select. `productGroup` (singular) is still accepted so an
  // existing link keeps working.
  const products = Array.from(
    new Set(
      [
        ...(searchParams.get("products") ?? "").split(","),
        searchParams.get("productGroup") ?? "",
      ]
        .map((v) => v.trim())
        .filter(Boolean)
    )
  )
  const campaignName = (searchParams.get("campaignName") ?? "").trim()
  const brand = (searchParams.get("brand") ?? "").trim()
  // Which banding to report on. "scoregroup" uses the business's own SCOREGROUP
  // labels (as in scripts/quality-mix.sql); "derived" uses round 50-point
  // buckets, which is the only way to answer a question phrased as "650-699"
  // since SCOREGROUP labels cross those boundaries.
  const bandMode = searchParams.get("bandMode") === "scoregroup" ? "scoregroup" : "derived"

  if (!DATE.test(startDate) || !DATE.test(endDate)) {
    return NextResponse.json(
      { error: "startDate and endDate are required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (startDate > endDate) {
    return NextResponse.json({ error: "startDate must be on or before endDate" }, { status: 400 })
  }

  // Filter on the SALE date, so a cohort is defined by when it was written.
  // Brand is matched space-insensitively ("MOBILE TALK" vs "MOBILETALK") since
  // the source is inconsistent about spacing.
  const filters = [
    `TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${startDate}' AND '${endDate}'`,
    products.length > 0
      ? `PRODUCT_GROUPS IN (${products.map((p) => `'${escSql(p)}'`).join(",")})`
      : "",
    campaignName ? `CAMPAIGNNAME = '${escSql(campaignName)}'` : "",
    brand ? `UPPER(REPLACE(BRAND, ' ', '')) = '${escSql(brand.replace(/ /g, "").toUpperCase())}'` : "",
  ].filter(Boolean)
  const where = `WHERE ${filters.join(" AND ")}`

  // FTC/FID are measured on FIRST-TIME collections only, so the whole report is
  // built from the first-collection row itself — one row per account — rather
  // than aggregating attributes across the account's later billing rows.
  //
  // That matters beyond the outcome: taking VAS as MAX() over every row counted
  // a VAS added later as an upsell as though it were attached at the sale, which
  // overstated attachment. Read off the first collection, the flags describe the
  // account as it was when it first billed.
  //
  // Accounts with no first-collection row are simply not in the base; they are
  // counted separately as `notFirstBilled` for transparency.
  const accountCte = `
    WITH scoped AS (
      SELECT * FROM ${table} ${where}
    ),
    first_ranked AS (
      SELECT
        ACCOUNTNO,
        TRY_TO_DATE(TO_VARCHAR(SALESDATE)) AS SALE_DATE,
        ${SCORE_NUM} AS SCORE_NUM,
        SCOREGROUP AS SCOREGROUP_VAL,
        UPPER(REPLACE(BRAND, ' ', '')) AS BRAND_VAL,
        ${VAS} AS VAS_FLAG,
        NULLIF(TRY_TO_NUMBER(TO_VARCHAR(PRODUCTPRICE)), 0) AS PRICE,
        ${PAID} AS PAID,
        UNPAID_GROUP_DESCRIPTION AS REASON,
        ROW_NUMBER() OVER (
          PARTITION BY ACCOUNTNO
          ORDER BY TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)) NULLS LAST,
                   TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)) NULLS LAST
        ) AS RN
      FROM scoped
      WHERE ${IS_FIRST}
    ),
    joined AS (
      SELECT
        ACCOUNTNO, SALE_DATE, VAS_FLAG, PRICE, PAID, REASON,
        BRAND_VAL AS BRAND,
        ${
          bandMode === "scoregroup"
            ? `COALESCE(NULLIF(TRIM(SCOREGROUP_VAL), ''), 'unknown')`
            : bandSql("SCORE_NUM")
        } AS BAND,
        ${
          // Sort key so bands order by score, not alphabetically ('908+' would
          // otherwise precede '662 to 672'). Unknown sorts last.
          bandMode === "scoregroup"
            ? `COALESCE(TRY_TO_NUMBER(REGEXP_SUBSTR(TRIM(SCOREGROUP_VAL), '^[0-9]+')), 99999)`
            : `COALESCE(FLOOR(SCORE_NUM / 50) * 50, 99999)`
        } AS BAND_SORT,
        -- every row here IS a first collection, so nothing is pending
        0 AS PENDING
      FROM first_ranked
      WHERE RN = 1
    )`

  try {
    // NB: order must match the query order below.
    // NB: order must match the query order below.
    const [byBand, byCohort, reasons, options, notBilled, reasonsByMonth] =
      await Promise.all([
      executeSnowflakeQuery<{
        BAND: string
        BAND_SORT: number | string
        ACCOUNTS: number | string
        BASE: number | string
        FTC: number | string
        PENDING: number | string
        VAS_ACCOUNTS: number | string
        AVG_PRICE: number | string | null
      }>(
        `${accountCte}
         SELECT
           BAND,
           MIN(BAND_SORT) AS BAND_SORT,
           COUNT(*) AS ACCOUNTS,
           SUM(IFF(PENDING = 0, 1, 0)) AS BASE,
           SUM(IFF(PENDING = 0 AND PAID = 1, 1, 0)) AS FTC,
           SUM(PENDING) AS PENDING,
           SUM(IFF(VAS_FLAG = 1, 1, 0)) AS VAS_ACCOUNTS,
           AVG(PRICE) AS AVG_PRICE
         FROM joined
         GROUP BY BAND`,
        SF
      ),
      executeSnowflakeQuery<{
        COHORT: string
        BAND: string
        BAND_SORT: number | string
        ACCOUNTS: number | string
        BASE: number | string
        FTC: number | string
        PENDING: number | string
      }>(
        `${accountCte}
         SELECT
           TO_CHAR(SALE_DATE, 'YYYY-MM') AS COHORT,
           BAND,
           MIN(BAND_SORT) AS BAND_SORT,
           COUNT(*) AS ACCOUNTS,
           SUM(IFF(PENDING = 0, 1, 0)) AS BASE,
           SUM(IFF(PENDING = 0 AND PAID = 1, 1, 0)) AS FTC,
           SUM(PENDING) AS PENDING
         FROM joined
         WHERE SALE_DATE IS NOT NULL
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        SF
      ),
      executeSnowflakeQuery<{ REASON: string | null; ACCOUNTS: number | string }>(
        `${accountCte}
         SELECT COALESCE(NULLIF(TRIM(REASON), ''), '(not given)') AS REASON, COUNT(*) AS ACCOUNTS
         FROM joined
         WHERE PENDING = 0 AND PAID = 0
         GROUP BY 1
         ORDER BY ACCOUNTS DESC`,
        SF
      ),
      // Distinct brand/product PAIRS in the period, filtered only by date so the
      // dropdowns never collapse to the current selection. Pairs (rather than
      // two independent lists) let the product list cascade off the chosen brand
      // client-side, with no extra round trip.
      executeSnowflakeQuery<{ BRAND: string | null; PRODUCT: string | null }>(
        `SELECT DISTINCT
           UPPER(REPLACE(BRAND, ' ', '')) AS BRAND,
           PRODUCT_GROUPS AS PRODUCT
         FROM ${table}
         WHERE TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${startDate}' AND '${endDate}'
           AND BRAND IS NOT NULL AND TRIM(BRAND) <> ''
           AND PRODUCT_GROUPS IS NOT NULL AND TRIM(PRODUCT_GROUPS) <> ''
         ORDER BY 1, 2`,
        SF
      ),
      executeSnowflakeQuery<{ N: number | string }>(
        `WITH scoped AS (
           SELECT * FROM ${table} ${where}
         ),
         all_accts AS (SELECT DISTINCT ACCOUNTNO FROM scoped),
         first_accts AS (SELECT DISTINCT ACCOUNTNO FROM scoped WHERE ${IS_FIRST})
         SELECT COUNT(*) AS N
         FROM all_accts a
         LEFT JOIN first_accts f ON f.ACCOUNTNO = a.ACCOUNTNO
         WHERE f.ACCOUNTNO IS NULL`,
        SF
      ),
      // Failure reasons split by sale month, so a shift in the mix is visible
      // rather than only the period total.
      executeSnowflakeQuery<{
        MONTH: string
        REASON: string | null
        ACCOUNTS: number | string
      }>(
        `${accountCte}
         SELECT
           TO_CHAR(SALE_DATE, 'YYYY-MM') AS MONTH,
           COALESCE(NULLIF(TRIM(REASON), ''), '(not given)') AS REASON,
           COUNT(*) AS ACCOUNTS
         FROM joined
         WHERE PAID = 0 AND SALE_DATE IS NOT NULL
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        SF
      ),
    ])

    const bandRows = byBand
      .map((r) => {
        const accounts = num(r.ACCOUNTS)
        const base = num(r.BASE)
        const ftc = num(r.FTC)
        return {
          band: String(r.BAND ?? "unknown"),
          bandSort: num(r.BAND_SORT),
          accounts,
          base,
          ftc,
          fid: base - ftc,
          pending: num(r.PENDING),
          ftcRate: rate(ftc, base),
          fidRate: rate(base - ftc, base),
          vasRate: rate(num(r.VAS_ACCOUNTS), accounts),
          avgPrice: numOrNull(r.AVG_PRICE),
        }
      })
      .sort((a, b) => a.bandSort - b.bandSort || a.band.localeCompare(b.band))

    const totalAccounts = bandRows.reduce((s, r) => s + r.accounts, 0)
    const bands = bandRows.map((r) => ({
      ...r,
      // Share of the written base — this is the "mix" the CEO asked about.
      mixShare: rate(r.accounts, totalAccounts),
    }))

    const totalBase = bandRows.reduce((s, r) => s + r.base, 0)
    const totalFtc = bandRows.reduce((s, r) => s + r.ftc, 0)
    const totalPending = num(notBilled[0]?.N)
    const totalVas = byBand.reduce((s, r) => s + num(r.VAS_ACCOUNTS), 0)

    const cohorts = byCohort.map((r) => {
      const base = num(r.BASE)
      const ftc = num(r.FTC)
      return {
        cohort: String(r.COHORT),
        band: String(r.BAND ?? "unknown"),
        bandSort: num(r.BAND_SORT),
        accounts: num(r.ACCOUNTS),
        base,
        ftc,
        fid: base - ftc,
        pending: num(r.PENDING),
        ftcRate: rate(ftc, base),
        fidRate: rate(base - ftc, base),
      }
    })

    return NextResponse.json({
      startDate,
      endDate,
      sourceTable: table,
      usingDefaultSource: table === DEFAULT_SOURCE_TABLE,
      bandMode,
      // Actual bands present, already in score order — the UI stacks its charts
      // in this order rather than knowing the banding scheme itself.
      bandOrder: bands.map((b) => b.band),
      bands,
      cohorts,
      reasons: reasons.map((r) => ({
        reason: String(r.REASON ?? "(not given)"),
        accounts: num(r.ACCOUNTS),
      })),
      reasonsByMonth: reasonsByMonth.map((r) => ({
        month: String(r.MONTH),
        reason: String(r.REASON ?? "(not given)"),
        accounts: num(r.ACCOUNTS),
      })),
      // Flat lists for the "all" case, plus the pairs the UI cascades on.
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
      filters: {
        products,
        campaignName: campaignName || null,
        brand: brand || null,
      },
      totals: {
        accounts: totalAccounts,
        base: totalBase,
        ftc: totalFtc,
        fid: totalBase - totalFtc,
        pending: totalPending,
        ftcRate: rate(totalFtc, totalBase),
        fidRate: rate(totalBase - totalFtc, totalBase),
        vasRate: rate(totalVas, totalAccounts),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/reporting/quality-mix] error:", message)

    // A missing or ungranted object is a setup problem, not a failure — return
    // it as such so the UI can offer the table search instead of a raw error.
    if (/does not exist|not authorized|invalid identifier/i.test(message)) {
      return NextResponse.json(
        {
          error: `Could not read ${table}: ${message}`,
          notConfigured: true,
          sourceTable: table,
          usingDefaultSource: table === DEFAULT_SOURCE_TABLE,
        },
        { status: 400 }
      )
    }
    return NextResponse.json({ error: message, sourceTable: table }, { status: 500 })
  }
}
