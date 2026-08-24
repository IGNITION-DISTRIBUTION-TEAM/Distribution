import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TICKETS_TABLE, TICKET_STATUSES } from "@/lib/tickets-shared"
import { SF_OPTS, sqlString } from "@/lib/tickets-server"
import { notifyTicketUpdated } from "@/lib/ticket-notify"

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
    // Read the current state BEFORE updating: the notification needs the
    // requestor and the status it is moving from, and neither survives the write.
    // Best-effort — a failed read must not block the update itself.
    let before: {
      ref: string
      name: string
      email: string
      status: string | null
    } | null = null
    try {
      const prev = await executeSnowflakeQueryWithMeta(
        `SELECT TICKET_REF, CREATED_BY_NAME, CREATED_BY_EMAIL, STATUS
         FROM ${TICKETS_TABLE} WHERE TICKET_ID = ${sqlString(id)}`,
        SF_OPTS
      )
      const r = prev.rows[0]
      if (r) {
        before = {
          ref: String(r[0] ?? ""),
          name: String(r[1] ?? ""),
          email: String(r[2] ?? ""),
          status: r[3] == null ? null : String(r[3]),
        }
      }
    } catch (error) {
      console.warn("[/api/tickets/[id]] could not read ticket before update:", error)
    }

    const { rows } = await executeSnowflakeQueryWithMeta(
      `UPDATE ${TICKETS_TABLE} SET ${sets.join(", ")} WHERE TICKET_ID = ${sqlString(id)}`,
      SF_OPTS
    )
    // UPDATE returns [rows_updated, multi_joined_rows_updated].
    const updated = Number(rows[0]?.[0] ?? 0)
    if (updated === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 })
    }

    // Notify the requestor. Never allowed to fail the update — the change is
    // already committed, and notifyTicketUpdated swallows its own errors.
    let notified = false
    if (before?.email) {
      notified = await notifyTicketUpdated({
        ticketRef: before.ref,
        requestorName: before.name,
        requestorEmail: before.email,
        status: body.status !== undefined ? String(body.status) : null,
        previousStatus: before.status,
        assignedTo:
          body.assignedTo !== undefined && String(body.assignedTo).trim() !== ""
            ? String(body.assignedTo).trim()
            : null,
        updatedBy: guard.email,
      })
    }

    return NextResponse.json({ success: true, notified })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/[id]] update error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
