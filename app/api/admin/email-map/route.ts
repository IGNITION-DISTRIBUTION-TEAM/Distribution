import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"
import { isValidEmail } from "@/lib/auth-gate"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

type Row = {
  AD_EMAIL: string
  EMPLOYEE_EMAIL: string
  CREATED_AT?: unknown
  CREATED_BY?: string | null
  JOB_TITLE?: string | null
  EMPLOYEE_STATUS_DISPLAY?: string | null
}

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  // Join in JOB_TITLE + status from HR so the UI can show the user's role
  // without an extra round-trip per row. Restrict to the active record so
  // duplicate (Active + Terminated) rows don't double-up the list.
  const rows = await executeSnowflakeQuery<Row>(
    `SELECT m.AD_EMAIL, m.EMPLOYEE_EMAIL, m.CREATED_AT, m.CREATED_BY,
            e.JOB_TITLE, e.EMPLOYEE_STATUS_DISPLAY
     FROM ${TABLE} m
     LEFT JOIN DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL e
       ON LOWER(e.EMAIL_ADDRESS) = LOWER(m.EMPLOYEE_EMAIL)
      AND UPPER(TRIM(e.EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
     ORDER BY m.AD_EMAIL`
  )
  return NextResponse.json({
    mappings: rows.map((r) => ({
      adEmail: String(r.AD_EMAIL).toLowerCase(),
      employeeEmail: String(r.EMPLOYEE_EMAIL).toLowerCase(),
      createdAt: r.CREATED_AT ?? null,
      createdBy: r.CREATED_BY ?? null,
      jobTitle: r.JOB_TITLE ?? null,
      status: r.EMPLOYEE_STATUS_DISPLAY ?? null,
    })),
  })
}

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { adEmail?: string; employeeEmail?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const adEmail = (body.adEmail ?? "").trim().toLowerCase()
  const employeeEmail = (body.employeeEmail ?? "").trim().toLowerCase()
  if (!isValidEmail(adEmail)) return NextResponse.json({ error: "Invalid AD email" }, { status: 400 })
  if (!isValidEmail(employeeEmail))
    return NextResponse.json({ error: "Invalid employee email" }, { status: 400 })

  await executeSnowflakeQuery(
    `MERGE INTO ${TABLE} t
     USING (SELECT ${sqlString(adEmail)} AS AD_EMAIL, ${sqlString(employeeEmail)} AS EMPLOYEE_EMAIL,
                   ${sqlString(guard.email)} AS CREATED_BY) s
     ON LOWER(t.AD_EMAIL) = LOWER(s.AD_EMAIL)
     WHEN MATCHED THEN UPDATE SET EMPLOYEE_EMAIL = s.EMPLOYEE_EMAIL
     WHEN NOT MATCHED THEN INSERT (AD_EMAIL, EMPLOYEE_EMAIL, CREATED_BY)
                          VALUES (s.AD_EMAIL, s.EMPLOYEE_EMAIL, s.CREATED_BY)`
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const adEmail = (request.nextUrl.searchParams.get("adEmail") ?? "").trim().toLowerCase()
  if (!isValidEmail(adEmail)) return NextResponse.json({ error: "Invalid AD email" }, { status: 400 })

  await executeSnowflakeQuery(
    `DELETE FROM ${TABLE} WHERE LOWER(AD_EMAIL) = ${sqlString(adEmail)}`
  )
  return NextResponse.json({ ok: true })
}
