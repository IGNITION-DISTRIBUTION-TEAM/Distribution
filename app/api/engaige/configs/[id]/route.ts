import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { CONFIGS_TABLE, MAPPINGS_TABLE, ASSIGNMENTS_TABLE } from "@/lib/engaige-shared"
import { SF_OPTS, sqlString } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// PATCH /api/engaige/configs/[id] — { action: "toggle" } flips is_active.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  let body: { action?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (body.action !== "toggle") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  }

  try {
    await executeSnowflakeQueryWithMeta(
      `UPDATE ${CONFIGS_TABLE} SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP()
       WHERE config_id = ${sqlString(id)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs/[id]] toggle error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/engaige/configs/[id] — cascade delete mappings, assignments, config.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  try {
    const idLit = sqlString(id)
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${MAPPINGS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${CONFIGS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs/[id]] delete error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
