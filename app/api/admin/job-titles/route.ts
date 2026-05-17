import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Distinct JOB_TITLE values from EMPLOYEE_DETAIL — feeds the "Allowed roles"
// selector so admins can only pick titles that actually exist in HR.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const rows = await executeSnowflakeQuery<{ JOB_TITLE: string | null }>(
    `SELECT DISTINCT JOB_TITLE
     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
     WHERE JOB_TITLE IS NOT NULL AND TRIM(JOB_TITLE) <> ''
       AND UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
     ORDER BY JOB_TITLE`
  )

  return NextResponse.json({
    jobTitles: rows
      .map((r) => (r.JOB_TITLE ?? "").trim())
      .filter((t) => t.length > 0),
  })
}
