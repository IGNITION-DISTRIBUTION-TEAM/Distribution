import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const rows = await executeSnowflakeQuery<{ ROLE: string }>(
    `SELECT ROLE FROM ${TABLE} ORDER BY ROLE`
  )
  return NextResponse.json({ roles: rows.map((r) => String(r.ROLE)) })
}

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { role?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const role = (body.role ?? "").trim()
  if (!role) return NextResponse.json({ error: "Role required" }, { status: 400 })
  if (role.length > 200) return NextResponse.json({ error: "Role too long" }, { status: 400 })

  await executeSnowflakeQuery(
    `MERGE INTO ${TABLE} t
     USING (SELECT ${sqlString(role)} AS ROLE) s
     ON LOWER(t.ROLE) = LOWER(s.ROLE)
     WHEN NOT MATCHED THEN INSERT (ROLE) VALUES (s.ROLE)`
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const role = (request.nextUrl.searchParams.get("role") ?? "").trim()
  if (!role) return NextResponse.json({ error: "Role required" }, { status: 400 })

  await executeSnowflakeQuery(
    `DELETE FROM ${TABLE} WHERE LOWER(ROLE) = LOWER(${sqlString(role)})`
  )
  return NextResponse.json({ ok: true })
}
