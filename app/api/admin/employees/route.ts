import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Quick lookup against EMPLOYEE_DETAIL for the email-mapping UI. Returns up
// to 25 active employees whose email or name contains the query.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim()
  if (q.length < 2) return NextResponse.json({ employees: [] })

  const like = sqlString(`%${q.toLowerCase()}%`)
  const rows = await executeSnowflakeQuery<{
    EMAIL_ADDRESS: string
    JOB_TITLE: string | null
    EMPLOYEE_STATUS_DISPLAY: string | null
    FIRST_NAME?: string | null
    LAST_NAME?: string | null
    EMPLOYEE_NAME?: string | null
  }>(
    `SELECT *
     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
     WHERE LOWER(EMAIL_ADDRESS) LIKE ${like}
     ORDER BY EMAIL_ADDRESS
     LIMIT 25`
  )

  return NextResponse.json({
    employees: rows.map((r) => ({
      email: String(r.EMAIL_ADDRESS ?? "").toLowerCase(),
      jobTitle: r.JOB_TITLE ?? null,
      status: r.EMPLOYEE_STATUS_DISPLAY ?? null,
    })),
  })
}
