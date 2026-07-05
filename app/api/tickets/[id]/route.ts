import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TICKETS_TABLE, TICKET_STATUSES } from "@/lib/tickets-shared"
import { SF_OPTS, sqlString } from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// PATCH /api/tickets/[id] — update status and/or assignedTo.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "tickets")
  if (guard instanceof NextResponse) return guard

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid ticket id" }, { status: 400 })
  }

  let body: { status?: unknown; assignedTo?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []
  if (body.status !== undefined) {
    const status = String(body.status)
    if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${TICKET_STATUSES.join(", ")}` },
        { status: 400 }
      )
    }
    sets.push(`STATUS = ${sqlString(status)}`)
  }
  if (body.assignedTo !== undefined) {
    const assignedTo = String(body.assignedTo).trim().slice(0, 320)
    sets.push(`ASSIGNED_TO = ${assignedTo ? sqlString(assignedTo) : "NULL"}`)
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }
  sets.push(`UPDATED_BY = ${sqlString(guard.email)}`, `UPDATED_AT = CURRENT_TIMESTAMP()`)

  try {
    const { rows } = await executeSnowflakeQueryWithMeta(
      `UPDATE ${TICKETS_TABLE} SET ${sets.join(", ")} WHERE TICKET_ID = ${sqlString(id)}`,
      SF_OPTS
    )
    // UPDATE returns [rows_updated, multi_joined_rows_updated].
    const updated = Number(rows[0]?.[0] ?? 0)
    if (updated === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/[id]] update error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
