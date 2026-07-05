import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { put } from "@vercel/blob"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { readSessionIdentity, requireDepartmentAccess } from "@/lib/admin-guard"
import {
  TICKETS_TABLE,
  TICKET_STATUSES,
  OPEN_STATUSES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_EXTENSIONS,
  type TicketAttachment,
  type TicketRow,
} from "@/lib/tickets-shared"
import {
  SF_OPTS,
  ensureTicketTables,
  getActiveDepartments,
  getFormConfig,
  rateLimitOk,
  sqlString,
} from "@/lib/tickets-server"

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
      let attachments: TicketAttachment[] = []
      try {
        const parsed = JSON.parse(String(r.FIELDS ?? "{}"))
        if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed._attachments)) {
            attachments = (parsed._attachments as unknown[])
              .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
              .map((a) => ({
                name: String(a.name ?? "attachment"),
                size: Number(a.size ?? 0),
                pathname: String(a.pathname ?? ""),
              }))
              .filter((a) => a.pathname)
            delete parsed._attachments
          }
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
        attachments,
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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// POST /api/tickets — create a ticket from { answers: Record<string,string> }.
// PUBLIC by design: the whole company logs tickets via department capture
// links without signing in. Identity comes from the session when one exists,
// otherwise from typed (unverified) requestor name/email. Viewing/managing
// tickets stays behind the "tickets" department grant.
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  if (!rateLimitOk(`tickets:${ip}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "Too many tickets from this connection — wait a minute and try again." },
      { status: 429 }
    )
  }

  // JSON for plain submissions; multipart (payload JSON + files) when the
  // form carries attachments.
  let body: {
    answers?: Record<string, unknown>
    requestor?: { name?: unknown; email?: unknown }
    website?: unknown
  }
  let files: File[] = []
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData()
      body = JSON.parse(String(form.get("payload") ?? ""))
      files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0)
    } else {
      body = await request.json()
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const rawAnswers = body.answers
  if (!rawAnswers || typeof rawAnswers !== "object") {
    return NextResponse.json({ error: "answers object is required" }, { status: 400 })
  }

  if (files.length > MAX_ATTACHMENTS) {
    return NextResponse.json({ error: `Max ${MAX_ATTACHMENTS} attachments` }, { status: 400 })
  }
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `"${f.name}" is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB per file)` },
        { status: 400 }
      )
    }
    const ext = f.name.split(".").pop()?.toLowerCase() ?? ""
    if (!ATTACHMENT_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `"${f.name}" has an unsupported type. Allowed: ${ATTACHMENT_EXTENSIONS.join(", ")}` },
        { status: 400 }
      )
    }
  }
  if (files.length > 0 && !process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Attachments are not configured yet (missing blob storage token) — submit without files or contact the tickets team." },
      { status: 503 }
    )
  }

  // Honeypot: the form includes a hidden "website" input humans never see.
  // Bots that fill it get a plausible success response and nothing is stored.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return NextResponse.json({ success: true, ticketRef: newTicketRef(), ticketId: "" })
  }

  // Identity: verified session if present, else typed requestor details.
  const session = readSessionIdentity(request)
  let requestorName: string
  let requestorEmail: string
  if (session) {
    requestorName = session.name
    requestorEmail = session.email
  } else {
    requestorName = String(body.requestor?.name ?? "").trim().slice(0, 120)
    requestorEmail = String(body.requestor?.email ?? "").trim().toLowerCase().slice(0, 320)
    if (!requestorName) {
      return NextResponse.json({ error: "Your name is required" }, { status: 400 })
    }
    if (!EMAIL_RE.test(requestorEmail)) {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 })
    }
  }

  try {
    await ensureTicketTables()
    const config = await getFormConfig()
    const activeFields = config.fields.filter((f) => f.active)
    const managedDepartments = await getActiveDepartments()
    const managedNames = new Set(managedDepartments.map((d) => d.name))

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
      // When a managed department list exists, the "department" answer comes
      // from that list (capture links / dropdown) rather than the field's own
      // config, so accept managed names regardless of the field's type.
      const isManagedDept = field.key === "department" && managedNames.size > 0
      if (isManagedDept && !managedNames.has(value)) {
        return NextResponse.json(
          { error: `"${field.label}" must be one of the registered departments` },
          { status: 400 }
        )
      }
      if (!isManagedDept && field.type === "select" && field.options && !field.options.includes(value)) {
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

    // Upload attachments to Vercel Blob (private). Only after the answers
    // validated, so rejected submissions never leave orphan files.
    const attachments: TicketAttachment[] = []
    for (const f of files) {
      const safeName = f.name.replace(/[^\w.\-]+/g, "_").slice(-80)
      const blob = await put(`tickets/${ticketRef}/${safeName}`, f, {
        access: "private",
        addRandomSuffix: true,
        contentType: f.type || undefined,
      })
      attachments.push({ name: f.name.slice(-120), size: f.size, pathname: blob.pathname })
    }
    const fieldsJson: Record<string, unknown> = { ...answers }
    if (attachments.length > 0) fieldsJson._attachments = attachments

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
        `${sqlString(JSON.stringify(fieldsJson))}, ${sqlString(requestorName)}, ` +
        `${sqlString(requestorEmail)}`,
      SF_OPTS
    )

    return NextResponse.json({ success: true, ticketRef, ticketId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets] create error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
