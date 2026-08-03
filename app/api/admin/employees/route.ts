import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Name columns EMPLOYEE_DETAIL might carry — we only search the ones that
// actually exist (checked against INFORMATION_SCHEMA), so an install with a
// different schema never breaks the query.
const NAME_COLUMN_CANDIDATES = [
  "EMPLOYEE_NAME",
  "FULL_NAME",
  "FIRST_NAME",
  "LAST_NAME",
  "KNOWN_AS",
  "PREFERRED_NAME",
  "DISPLAY_NAME",
]

let cachedNameCols: string[] | null = null

async function nameColumns(): Promise<string[]> {
  if (cachedNameCols) return cachedNameCols
  try {
    const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'HR_SAGE_DATA' AND TABLE_NAME = 'EMPLOYEE_DETAIL'`
    )
    const present = new Set(rows.map((r) => String(r.COLUMN_NAME).toUpperCase()))
    cachedNameCols = NAME_COLUMN_CANDIDATES.filter((c) => present.has(c))
  } catch {
    cachedNameCols = []
  }
  return cachedNameCols
}

// Type-ahead lookup against EMPLOYEE_DETAIL for the email-mapping UI. Matches on
// email OR any available name column; returns up to 25 active employees.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim()
  if (q.length < 2) return NextResponse.json({ employees: [] })

  const like = sqlString(`%${q.toLowerCase()}%`)
  const nameCols = await nameColumns()
  const searchCols = ["EMAIL_ADDRESS", ...nameCols]
  const whereMatch = searchCols.map((c) => `LOWER(${c}) LIKE ${like}`).join(" OR ")
  // Build a display name from whatever name columns exist.
  const displayExpr = nameCols.length
    ? `TRIM(CONCAT_WS(' ', ${nameCols.map((c) => c).join(", ")}))`
    : "NULL"

  try {
    const rows = await executeSnowflakeQuery<{
      EMAIL_ADDRESS: string
      JOB_TITLE: string | null
      EMPLOYEE_STATUS_DISPLAY: string | null
      DISPLAY_NAME: string | null
    }>(
      `SELECT EMAIL_ADDRESS, JOB_TITLE, EMPLOYEE_STATUS_DISPLAY,
              ${displayExpr} AS DISPLAY_NAME
       FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
       WHERE EMAIL_ADDRESS IS NOT NULL
         AND (${whereMatch})
         AND UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
       ORDER BY EMAIL_ADDRESS
       LIMIT 25`
    )

    return NextResponse.json({
      employees: rows.map((r) => ({
        email: String(r.EMAIL_ADDRESS ?? "").toLowerCase(),
        name: r.DISPLAY_NAME ? String(r.DISPLAY_NAME).trim() : null,
        jobTitle: r.JOB_TITLE ?? null,
        status: r.EMPLOYEE_STATUS_DISPLAY ?? null,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/admin/employees] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
