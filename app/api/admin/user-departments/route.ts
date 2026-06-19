import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"
import { isValidEmail } from "@/lib/auth-gate"
import { isDepartmentId } from "@/lib/departments"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const rows = await executeSnowflakeQuery<{ AD_EMAIL: string; DEPARTMENT: string }>(
    `SELECT AD_EMAIL, DEPARTMENT FROM ${TABLE} ORDER BY AD_EMAIL, DEPARTMENT`
  )
  return NextResponse.json({
    grants: rows.map((r) => ({ adEmail: String(r.AD_EMAIL), department: String(r.DEPARTMENT) })),
  })
}

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { adEmail?: string; department?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const adEmail = (body.adEmail ?? "").trim().toLowerCase()
  const department = (body.department ?? "").trim().toLowerCase()

  if (!isValidEmail(adEmail)) {
    return NextResponse.json({ error: "Valid adEmail required" }, { status: 400 })
  }
  if (!isDepartmentId(department)) {
    return NextResponse.json({ error: "Unknown department" }, { status: 400 })
  }

  const actor = guard.email
  await executeSnowflakeQuery(
    `MERGE INTO ${TABLE} t
     USING (SELECT ${sqlString(adEmail)} AS AD_EMAIL, ${sqlString(department)} AS DEPARTMENT) s
     ON LOWER(t.AD_EMAIL) = s.AD_EMAIL AND LOWER(t.DEPARTMENT) = s.DEPARTMENT
     WHEN NOT MATCHED THEN INSERT (AD_EMAIL, DEPARTMENT, CREATED_BY)
       VALUES (s.AD_EMAIL, s.DEPARTMENT, ${sqlString(actor)})`
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const adEmail = (request.nextUrl.searchParams.get("adEmail") ?? "").trim().toLowerCase()
  const department = (request.nextUrl.searchParams.get("department") ?? "").trim().toLowerCase()
  if (!adEmail || !department) {
    return NextResponse.json({ error: "adEmail and department required" }, { status: 400 })
  }

  await executeSnowflakeQuery(
    `DELETE FROM ${TABLE}
     WHERE LOWER(AD_EMAIL) = ${sqlString(adEmail)} AND LOWER(DEPARTMENT) = ${sqlString(department)}`
  )
  return NextResponse.json({ ok: true })
}
