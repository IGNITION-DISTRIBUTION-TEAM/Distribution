import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Find candidate objects for QUALITY_MIX_SOURCE_TABLE by searching Snowflake's
 * column metadata for the billing extract's signature columns, so the table
 * does not have to be hunted for by hand.
 *
 * Tries SNOWFLAKE.ACCOUNT_USAGE.COLUMNS first because it spans every database;
 * that view needs a grant the app role may not hold (and lags by up to ~90
 * minutes), so it falls back to the configured database's INFORMATION_SCHEMA,
 * which is always readable but only covers that one database.
 *
 * Metadata only — no row data is read. Super-admin because it enumerates the
 * account's schema.
 */

// The columns the quality mix report actually reads. A candidate is scored on
// how many of these it has; missing ones are reported so a near-miss object can
// be judged rather than silently discarded.
const REQUIRED = [
  "ACCOUNTNO",
  "SALESDATE",
  "SCORE",
  "ISFIRSTCOLLECTION",
  "PAID_FLAG",
  "UNPAID_GROUP_DESCRIPTION",
  "VAS_BUTTON_FLAG",
  "PRODUCT_GROUPS",
  "PRODUCTPRICE",
  "SCHEDULEDATE",
  "BILLINGDATE",
] as const

// Enough of the signature to be worth showing, so a view exposing a subset
// still surfaces instead of being dropped.
const MIN_MATCHES = 5

const inList = REQUIRED.map((c) => `'${c}'`).join(",")

const searchSql = (source: string) => `
  SELECT
    TABLE_CATALOG AS DB,
    TABLE_SCHEMA  AS SCH,
    TABLE_NAME    AS OBJ,
    COUNT(DISTINCT UPPER(COLUMN_NAME)) AS MATCHED,
    LISTAGG(DISTINCT UPPER(COLUMN_NAME), ',') AS COLS
  FROM ${source}
  WHERE UPPER(COLUMN_NAME) IN (${inList})
    ${source.includes("ACCOUNT_USAGE") ? "AND DELETED IS NULL" : ""}
  GROUP BY 1, 2, 3
  HAVING COUNT(DISTINCT UPPER(COLUMN_NAME)) >= ${MIN_MATCHES}
  ORDER BY MATCHED DESC, DB, SCH, OBJ
  LIMIT 50`

type Row = {
  DB: string | null
  SCH: string | null
  OBJ: string | null
  MATCHED: number | string
  COLS: string | null
}

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const appDb = (process.env.SNOWFLAKE_DATABASE ?? "DATAWAREHOUSE").trim()
  const attempts: { source: string; label: string }[] = [
    { source: "SNOWFLAKE.ACCOUNT_USAGE.COLUMNS", label: "account-wide (ACCOUNT_USAGE)" },
    { source: `${appDb}.INFORMATION_SCHEMA.COLUMNS`, label: `${appDb} only (INFORMATION_SCHEMA)` },
  ]

  const notes: string[] = []
  for (const attempt of attempts) {
    try {
      const rows = await executeSnowflakeQuery<Row>(searchSql(attempt.source))
      const candidates = rows.map((r) => {
        const have = new Set(
          String(r.COLS ?? "")
            .split(",")
            .map((c) => c.trim().toUpperCase())
            .filter(Boolean)
        )
        return {
          table: [r.DB, r.SCH, r.OBJ].filter(Boolean).join("."),
          matched: Number(r.MATCHED) || 0,
          required: REQUIRED.length,
          missing: REQUIRED.filter((c) => !have.has(c)),
        }
      })
      return NextResponse.json({
        searchedVia: attempt.label,
        required: REQUIRED,
        candidates,
        notes,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[/api/reporting/quality-mix/discover] ${attempt.source} failed:`, message)
      notes.push(`${attempt.label} unavailable: ${message.slice(0, 200)}`)
      // fall through to the next source
    }
  }

  return NextResponse.json(
    {
      error:
        "Could not read column metadata from Snowflake. Grant the app role IMPORTED PRIVILEGES on the SNOWFLAKE database for an account-wide search, or name the table manually.",
      notes,
      required: REQUIRED,
    },
    { status: 500 }
  )
}
