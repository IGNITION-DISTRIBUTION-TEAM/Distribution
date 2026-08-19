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
 *   base = accounts whose first collection has been attempted
 *   FTC  = those where PAID_FLAG = 1
 *   FID  = those where PAID_FLAG = 0, split by UNPAID_GROUP_DESCRIPTION
 *
 * Score bands are derived from the raw SCORE in 50-point buckets, deliberately
 * NOT from SCOREGROUP: the existing SCOREGROUP labels are narrow percentile
 * bands ("662 to 672", "887 to 907") that cross the round boundaries the
 * business talks in, so "650-699" cannot be assembled from them.
 *
 * Cohorts are by sale month (SALESDATE). Accounts in a cohort with no first
 * collection row yet are reported as `pending`, never folded into the default
 * rate — a young cohort must not read as 0% default.
 *
 * The source object is configurable because the extract's home in Snowflake is
 * set per environment:
 *   QUALITY_MIX_SOURCE_TABLE  e.g. DATAWAREHOUSE.SCHEMA.VW_BILLING_EXTRACT
 */

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

  const table = (process.env.QUALITY_MIX_SOURCE_TABLE ?? "").trim()
  if (!table) {
    return NextResponse.json(
      {
        error:
          "QUALITY_MIX_SOURCE_TABLE is not set on the server. Point it at the billing extract in Snowflake (DATABASE.SCHEMA.OBJECT) and redeploy.",
        notConfigured: true,
      },
      { status: 400 }
    )
  }
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
  const productGroup = (searchParams.get("productGroup") ?? "").trim()
  const campaignName = (searchParams.get("campaignName") ?? "").trim()

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
  const filters = [
    `TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${startDate}' AND '${endDate}'`,
    productGroup ? `PRODUCT_GROUPS = '${escSql(productGroup)}'` : "",
    campaignName ? `CAMPAIGNNAME = '${escSql(campaignName)}'` : "",
  ].filter(Boolean)
  const where = `WHERE ${filters.join(" AND ")}`

  // One row per account: its first collection (if attempted) plus the sale
  // attributes. MIN/MAX over the account's rows keeps sale-level attributes
  // stable — they repeat identically across a given account's billing rows.
  const accountCte = `
    WITH scoped AS (
      SELECT * FROM ${table} ${where}
    ),
    accounts AS (
      SELECT
        ACCOUNTNO,
        MIN(TRY_TO_DATE(TO_VARCHAR(SALESDATE))) AS SALE_DATE,
        MAX(${SCORE_NUM}) AS SCORE_NUM,
        MAX(${VAS}) AS VAS_FLAG,
        MAX(NULLIF(TRY_TO_NUMBER(TO_VARCHAR(PRODUCTPRICE)), 0)) AS PRICE
      FROM scoped
      GROUP BY ACCOUNTNO
    ),
    first_ranked AS (
      SELECT
        ACCOUNTNO,
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
    firsts AS (
      SELECT ACCOUNTNO, PAID, REASON FROM first_ranked WHERE RN = 1
    ),
    joined AS (
      SELECT
        a.ACCOUNTNO, a.SALE_DATE, a.VAS_FLAG, a.PRICE,
        ${bandSql("a.SCORE_NUM")} AS BAND,
        f.PAID, f.REASON,
        IFF(f.ACCOUNTNO IS NULL, 1, 0) AS PENDING
      FROM accounts a
      LEFT JOIN firsts f ON f.ACCOUNTNO = a.ACCOUNTNO
    )`

  try {
    const [byBand, byCohort, reasons, productGroups] = await Promise.all([
      executeSnowflakeQuery<{
        BAND: string
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
        ACCOUNTS: number | string
        BASE: number | string
        FTC: number | string
        PENDING: number | string
      }>(
        `${accountCte}
         SELECT
           TO_CHAR(SALE_DATE, 'YYYY-MM') AS COHORT,
           BAND,
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
      // Distinct products in the period, ignoring the product filter itself so
      // the dropdown doesn't collapse to the current selection.
      executeSnowflakeQuery<{ PRODUCT_GROUPS: string | null }>(
        `SELECT DISTINCT PRODUCT_GROUPS
         FROM ${table}
         WHERE TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${startDate}' AND '${endDate}'
           AND PRODUCT_GROUPS IS NOT NULL AND TRIM(PRODUCT_GROUPS) <> ''
         ORDER BY 1`,
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
      .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band))

    const totalAccounts = bandRows.reduce((s, r) => s + r.accounts, 0)
    const bands = bandRows.map((r) => ({
      ...r,
      // Share of the written base — this is the "mix" the CEO asked about.
      mixShare: rate(r.accounts, totalAccounts),
    }))

    const totalBase = bandRows.reduce((s, r) => s + r.base, 0)
    const totalFtc = bandRows.reduce((s, r) => s + r.ftc, 0)
    const totalPending = bandRows.reduce((s, r) => s + r.pending, 0)
    const totalVas = byBand.reduce((s, r) => s + num(r.VAS_ACCOUNTS), 0)

    const cohorts = byCohort.map((r) => {
      const base = num(r.BASE)
      const ftc = num(r.FTC)
      return {
        cohort: String(r.COHORT),
        band: String(r.BAND ?? "unknown"),
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
      bandOrder: BAND_ORDER,
      bands,
      cohorts,
      reasons: reasons.map((r) => ({
        reason: String(r.REASON ?? "(not given)"),
        accounts: num(r.ACCOUNTS),
      })),
      productGroups: productGroups
        .map((r) => String(r.PRODUCT_GROUPS ?? "").trim())
        .filter(Boolean),
      filters: { productGroup: productGroup || null, campaignName: campaignName || null },
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
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
