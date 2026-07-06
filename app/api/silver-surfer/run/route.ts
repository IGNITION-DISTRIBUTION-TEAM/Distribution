import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta, formatSnowflakeValue } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"

const DB = "DATAWAREHOUSE"
const SCHEMA = "DISTRIBUTION_AUTOMATION"
const TEMP_TABLE = `${DB}.${SCHEMA}.TEMP_UPLOAD`
const SYNC_PROC = `${DB}.${SCHEMA}.SP_SYNC_BATCH_COUNTS_TODAY`
const SF_OPTS = { database: DB, schema: SCHEMA }

// POST /api/silver-surfer/run — refresh today's batch counts and return them:
//   1. TRUNCATE TEMP_UPLOAD
//   2. CALL SP_SYNC_BATCH_COUNTS_TODAY()
//   3. SELECT * FROM TEMP_UPLOAD
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  try {
    await executeSnowflakeQueryWithMeta(`TRUNCATE TABLE ${TEMP_TABLE}`, SF_OPTS)
    await executeSnowflakeQueryWithMeta(`CALL ${SYNC_PROC}()`, SF_OPTS)
    const { columns, rows } = await executeSnowflakeQueryWithMeta(
      `SELECT * FROM ${TEMP_TABLE}`,
      SF_OPTS
    )

    return NextResponse.json({
      columns: columns.map((c) => c.name),
      rows: rows.map((row) =>
        row.map((v, i) => {
          const formatted = formatSnowflakeValue(v, columns[i]?.type ?? "TEXT")
          return formatted == null ? "" : String(formatted)
        })
      ),
      rowCount: rows.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/silver-surfer/run] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
