import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  TICKETS_TABLE,
  TICKET_STATUSES,
  OPEN_STATUSES,
  type TicketRow,
} from "@/lib/tickets-shared"
import { SF_OPTS, ensureTicketTables, getFormConfig, sqlString, sessionName } from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

const MAX_VALUE_LEN = 4000

function newTicketRef(): string {
  const stamp = Date.now().toString(36).toUpperCase()
  const rand = randomUUID().slice(0, 4).toUpperCase()
  return `TKT-${stamp}-${rand}`
}

// GET /api/tickets?status=<status|all|open> — newest 200 tickets.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "tickets")
  if (guard instanceof NextResponse) return guard

  const statusParam = request.nextUrl.searchParams.get("status") ?? "all"
  let statusFilter = ""
  if (statusParam === "open") {
    statusFilter = `WHERE STATUS IN (${OPEN_STATUSES.map((s) => sqlString(s)).join(",")})`
  } else if ((TICKET_STATUSES as readonly string[]).includes(statusParam)) {
    statusFilter = `WHERE STATUS = ${sqlString(statusParam)}`
  }

  try {
    await ensureTicketTables()
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT TICKET_ID, TICKET_REF, STATUS, REQUEST_TYPE, URGENCY, ASSIGNED_TO, FIELDS,
              CREATED_BY_NAME, CREATED_BY_EMAIL, UPDATED_BY,
              TO_VARCHAR(SLA_DUE_AT, 'YYYY-MM-DD HH24:MI') AS SLA_DUE_AT,
              TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI') AS CREATED_AT,
              TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD HH24:MI') AS UPDATED_AT,
              CASE WHEN SLA_DUE_AT < CURRENT_TIMESTAMP()
                    AND STATUS IN (${OPEN_STATUSES.map((s) => sqlString(s)).join(",")})
                   THEN 1 ELSE 0 END AS OVERDUE
       FROM ${TICKETS_TABLE} ${statusFilter}
       ORDER BY CREATED_AT DESC LIMIT 200`,
      SF_OPTS
    )

    const tickets: TicketRow[] = rows.map((r) => {
      let fields: Record<string, string> = {}
      try {
        const parsed = JSON.parse(String(r.FIELDS ?? "{}"))
        if (parsed && typeof parsed === "object") {
          fields = Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")])
          )
        }
      } catch {
        // Leave fields empty if the stored JSON is malformed.
      }
      return {
        ticketId: String(r.TICKET_ID ?? ""),
        ticketRef: String(r.TICKET_REF ?? ""),
        status: String(r.STATUS ?? ""),
        requestType: r.REQUEST_TYPE == null ? null : String(r.REQUEST_TYPE),
        urgency: r.URGENCY == null ? null : String(r.URGENCY),
        slaDueAt: r.SLA_DUE_AT == null ? null : String(r.SLA_DUE_AT),
        overdue: Number(r.OVERDUE ?? 0) === 1,
        assignedTo: r.ASSIGNED_TO == null ? null : String(r.ASSIGNED_TO),
        fields,
        createdByName: r.CREATED_BY_NAME == null ? null : String(r.CREATED_BY_NAME),
        createdByEmail: r.CREATED_BY_EMAIL == null ? null : String(r.CREATED_BY_EMAIL),
        createdAt: r.CREATED_AT == null ? null : String(r.CREATED_AT),
        updatedBy: r.UPDATED_BY == null ? null : String(r.UPDATED_BY),
        updatedAt: r.UPDATED_AT == null ? null : String(r.UPDATED_AT),
      }
    })

    return NextResponse.json({ tickets })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets] list error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/tickets — create a ticket from { answers: Record<string,string> }.
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "tickets")
  if (guard instanceof NextResponse) return guard

  let body: { answers?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const rawAnswers = body.answers
  if (!rawAnswers || typeof rawAnswers !== "object") {
    return NextResponse.json({ error: "answers object is required" }, { status: 400 })
  }

  try {
    await ensureTicketTables()
    const config = await getFormConfig()
    const activeFields = config.fields.filter((f) => f.active)

    // Validate against the live form config; drop unknown keys.
    const answers: Record<string, string> = {}
    for (const field of activeFields) {
      const raw = rawAnswers[field.key]
      const value = raw == null ? "" : String(raw).trim()
      if (field.required && !value) {
        return NextResponse.json({ error: `"${field.label}" is required` }, { status: 400 })
      }
      if (!value) continue
      if (value.length > MAX_VALUE_LEN) {
        return NextResponse.json(
          { error: `"${field.label}" is too long (max ${MAX_VALUE_LEN} characters)` },
          { status: 400 }
        )
      }
      if (field.type === "select" && field.options && !field.options.includes(value)) {
        return NextResponse.json(
          { error: `"${field.label}" must be one of the listed options` },
          { status: 400 }
        )
      }
      if (field.type === "yesno" && !["Yes", "No"].includes(value)) {
        return NextResponse.json({ error: `"${field.label}" must be Yes or No` }, { status: 400 })
      }
      answers[field.key] = value
    }

    const ticketId = randomUUID()
    const ticketRef = newTicketRef()
    const requestType = answers.requestType ?? null
    const urgency = answers.urgency ?? null
    const slaHours = urgency != null ? config.slaHoursByUrgency[urgency] : undefined
    const name = sessionName(request.cookies.get("azure_session")?.value)

    const slaExpr =
      typeof slaHours === "number" && Number.isFinite(slaHours) && slaHours > 0
        ? `DATEADD('minute', ${Math.round(slaHours * 60)}, CURRENT_TIMESTAMP())`
        : "NULL"

    await executeSnowflakeQueryWithMeta(
      `INSERT INTO ${TICKETS_TABLE} ` +
        `(TICKET_ID, TICKET_REF, STATUS, REQUEST_TYPE, URGENCY, SLA_DUE_AT, ASSIGNED_TO, ` +
        `FIELDS, CREATED_BY_NAME, CREATED_BY_EMAIL) ` +
        `SELECT ${sqlString(ticketId)}, ${sqlString(ticketRef)}, 'Received', ` +
        `${requestType ? sqlString(requestType) : "NULL"}, ` +
        `${urgency ? sqlString(urgency) : "NULL"}, ${slaExpr}, NULL, ` +
        `${sqlString(JSON.stringify(answers))}, ${sqlString(name)}, ${sqlString(guard.email)}`,
      SF_OPTS
    )

    return NextResponse.json({ success: true, ticketRef, ticketId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets] create error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
