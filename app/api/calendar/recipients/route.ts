import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { isValidEmail } from "@/lib/auth-gate"
import { readGraphMailConfig } from "@/lib/graph-mail"
import {
  CAL_SF,
  MAX_TEAM_RECIPIENTS,
  RECIPIENTS_TABLE,
  blit,
  ensureCalendarTables,
  lit,
  loadRecipients,
  olit,
  parseId,
} from "@/lib/calendar-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The standing team mailing list for the shared calendar.
 *
 * DELIBERATE DEPARTURE. Every other email list in this app — APP_SUPER_ADMINS,
 * APP_USER_EMAIL_MAP — is super-admin-only, and those are right to be: they
 * are authorization data, deciding who gets into the building. This list is
 * content. It sits on exactly the same footing as the task rows that everyone
 * with the department can already create and delete, and locking it away while
 * leaving task deletion open would be an inconsistent boundary.
 *
 * The consequence, stated plainly: anyone granted Calendar can make this app
 * send mail to any address they type. The guardrails are the department grant
 * itself, the strict isValidEmail shared with the admin routes, a hard cap, a
 * CREATED_BY on every row, and TSK_CALENDAR_NOTIFICATIONS recording every send.
 */

/** Is Graph mail switched on? Only the boolean — no config detail leaves here. */
async function mailEnabled(): Promise<boolean> {
  try {
    const config = await readGraphMailConfig()
    return Boolean(config.enabled && config.mailbox)
  } catch {
    return false
  }
}

/**
 * GET — the list, plus whether mail is on at all.
 *
 * The flag rides along here rather than on the task list because the two
 * things belong together: this endpoint answers "who gets emailed", and "is
 * anyone getting emailed" is the same question one level up. It also means the
 * shell can learn both in one call and the month grid's paged, per-window task
 * fetch does not have to carry a Snowflake read of the Graph config.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard
  try {
    await ensureCalendarTables()
    const [recipients, enabled] = await Promise.all([loadRecipients(), mailEnabled()])
    return NextResponse.json({ recipients, mailEnabled: enabled })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/recipients GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const email = String(body.email ?? "").trim().toLowerCase()
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : ""

  try {
    await ensureCalendarTables()
    const existing = await loadRecipients()
    if (existing.some((r) => r.email === email)) {
      return NextResponse.json({ error: `${email} is already on the list` }, { status: 400 })
    }
    if (existing.length >= MAX_TEAM_RECIPIENTS) {
      return NextResponse.json(
        { error: `The list is capped at ${MAX_TEAM_RECIPIENTS} addresses` },
        { status: 400 }
      )
    }
    await executeSnowflakeQuery(
      `INSERT INTO ${RECIPIENTS_TABLE} (EMAIL, DISPLAY_NAME, ACTIVE, CREATED_AT, CREATED_BY)
       SELECT ${lit(email)}, ${olit(displayName)}, TRUE, CURRENT_TIMESTAMP(), ${lit(guard.email)}`,
      CAL_SF
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/recipients POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Mute someone without losing who added them or when. */
export async function PATCH(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const id = parseId(String(body.id ?? ""))
  if (id === null) return NextResponse.json({ error: "Invalid recipient id" }, { status: 400 })
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be true or false" }, { status: 400 })
  }

  try {
    await ensureCalendarTables()
    await executeSnowflakeQuery(
      `UPDATE ${RECIPIENTS_TABLE} SET ACTIVE = ${blit(body.active)} WHERE RECIPIENT_ID = ${id}`,
      CAL_SF
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/recipients PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  const id = parseId(request.nextUrl.searchParams.get("id"))
  if (id === null) return NextResponse.json({ error: "Invalid recipient id" }, { status: 400 })

  try {
    await ensureCalendarTables()
    await executeSnowflakeQuery(
      `DELETE FROM ${RECIPIENTS_TABLE} WHERE RECIPIENT_ID = ${id}`,
      CAL_SF
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/recipients DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
