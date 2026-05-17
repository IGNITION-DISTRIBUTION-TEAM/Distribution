import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"
import { isValidEmail } from "@/lib/auth-gate"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Returns a single employee row from EMPLOYEE_DETAIL keyed by column name.
// The mapping UI uses this to display HR context before saving a mapping.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase()
  if (!isValidEmail(email)) return NextResponse.json({ error: "Invalid email" }, { status: 400 })

  // Prefer the active record; fall back to whatever exists otherwise so the
  // UI can show "would be blocked as inactive".
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `SELECT *
     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
     WHERE LOWER(EMAIL_ADDRESS) = ${sqlString(email)}
     ORDER BY CASE WHEN UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%' THEN 0 ELSE 1 END
     LIMIT 1`
  )
  if (rows.length === 0) return NextResponse.json({ employee: null })

  return NextResponse.json({ employee: rows[0] })
}
