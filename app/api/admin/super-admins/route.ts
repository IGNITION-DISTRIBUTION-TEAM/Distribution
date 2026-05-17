import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"
import { isValidEmail } from "@/lib/auth-gate"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS"

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const rows = await executeSnowflakeQuery<{ AD_EMAIL: string }>(
    `SELECT AD_EMAIL FROM ${TABLE} ORDER BY AD_EMAIL`
  )
  return NextResponse.json({
    admins: rows.map((r) => String(r.AD_EMAIL).toLowerCase()),
  })
}

export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { adEmail?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const adEmail = (body.adEmail ?? "").trim().toLowerCase()
  if (!isValidEmail(adEmail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 })
  }

  await executeSnowflakeQuery(
    `MERGE INTO ${TABLE} t
     USING (SELECT ${sqlString(adEmail)} AS AD_EMAIL) s
     ON LOWER(t.AD_EMAIL) = LOWER(s.AD_EMAIL)
     WHEN NOT MATCHED THEN INSERT (AD_EMAIL) VALUES (s.AD_EMAIL)`
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const adEmail = (request.nextUrl.searchParams.get("adEmail") ?? "").trim().toLowerCase()
  if (!isValidEmail(adEmail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 })
  }

  // Guardrail: never let the last super admin be deleted, otherwise
  // nobody can manage the gate.
  const count = await executeSnowflakeQuery<{ N: number }>(`SELECT COUNT(*) AS N FROM ${TABLE}`)
  const total = Number(count[0]?.N ?? 0)
  if (total <= 1) {
    return NextResponse.json(
      { error: "Cannot remove the last super admin." },
      { status: 400 }
    )
  }

  await executeSnowflakeQuery(
    `DELETE FROM ${TABLE} WHERE LOWER(AD_EMAIL) = ${sqlString(adEmail)}`
  )
  return NextResponse.json({ ok: true })
}
