import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { readGraphMailConfig } from "@/lib/graph-mail"
import { addDaysIso, sastTodayIso } from "@/lib/calendar-dates"
import {
  CAL_SF,
  ITEMS_TABLE,
  blit,
  ensureCalendarTables,
  lit,
  loadRecipients,
  loadTask,
  loadTasks,
  normDaysBefore,
  normMode,
  olit,
  validateDescription,
  validateDueDate,
  validateDueTime,
  validateTaskRecipients,
  validateTitle,
} from "@/lib/calendar-store"
import { notifyTaskCreated, resolveRecipients } from "@/lib/calendar-notify"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The shared team calendar's tasks.
 *
 * "Task" here means a dated thing a person put on a team calendar. It is not
 * a scheduled Snowflake procedure (/api/distribution/tasks), the daily
 * checklist (/api/daily-tasks), or an SFTP job (Task Automation).
 *
 * Access is the department grant and nothing finer: this is one shared
 * calendar by design, so anyone with "calendar" can edit and delete anyone's
 * task. Each row records who created it.
 */

/** How far back closed tasks stay in the list. There is no pagination. */
const HISTORY_DAYS = 30

/** Is Graph mail switched on? Only the boolean — no config detail leaves here. */
async function mailEnabled(): Promise<boolean> {
  try {
    const config = await readGraphMailConfig()
    return Boolean(config.enabled && config.mailbox)
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  try {
    await ensureCalendarTables()
    const today = sastTodayIso()
    const [tasks, team, enabled] = await Promise.all([
      loadTasks(addDaysIso(today, -HISTORY_DAYS)),
      loadRecipients(),
      mailEnabled(),
    ])
    // `today` travels with the payload so the grouped list and the server agree
    // on the day boundary even if the viewer's clock or timezone does not.
    return NextResponse.json({ tasks, team, mailEnabled: enabled, today })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/tasks GET] error:", message)
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

  const title = validateTitle(body.title)
  if (typeof title !== "string") return NextResponse.json(title, { status: 400 })
  const description = validateDescription(body.description)
  if (description !== null && typeof description !== "string") {
    return NextResponse.json(description, { status: 400 })
  }
  const dueDate = validateDueDate(body.dueDate)
  if (typeof dueDate !== "string") return NextResponse.json(dueDate, { status: 400 })
  const dueTime = validateDueTime(body.dueTime)
  if (dueTime !== null && typeof dueTime !== "string") {
    return NextResponse.json(dueTime, { status: 400 })
  }
  const recipients = validateTaskRecipients(body.recipients)
  if (!Array.isArray(recipients)) return NextResponse.json(recipients, { status: 400 })

  const mode = normMode(body.recipientsMode)
  const remindEnabled = body.remindEnabled === undefined ? true : Boolean(body.remindEnabled)
  const remindDays = normDaysBefore(body.remindDaysBefore)
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : ""

  try {
    await ensureCalendarTables()
    // `ensure` creates columns with no DEFAULT, so every one of these is
    // written explicitly rather than left to the table definition.
    await executeSnowflakeQuery(
      `INSERT INTO ${ITEMS_TABLE}
         (TITLE, DESCRIPTION, DUE_DATE, DUE_TIME, STATUS, ASSIGNEE,
          RECIPIENTS_MODE, RECIPIENTS_JSON, REMIND_ENABLED, REMIND_DAYS_BEFORE,
          CREATED_AT, CREATED_BY, UPDATED_AT, UPDATED_BY)
       SELECT ${lit(title)}, ${olit(description)}, ${lit(dueDate)}, ${olit(dueTime)},
              'open', ${olit(assignee)}, ${lit(mode)}, ${lit(JSON.stringify(recipients))},
              ${blit(remindEnabled)}, ${remindDays},
              CURRENT_TIMESTAMP(), ${lit(guard.email)}, CURRENT_TIMESTAMP(), ${lit(guard.email)}`,
      CAL_SF
    )

    // Snowflake AUTOINCREMENT has no RETURNING on this driver path and
    // SELECT MAX(ID) is racy on a shared calendar, so the row is re-read by the
    // fields that identify it — the newest one this author just wrote.
    const [created] = await executeSnowflakeQuery<{ ID: number | string }>(
      `SELECT ID FROM ${ITEMS_TABLE}
        WHERE CREATED_BY = ${lit(guard.email)} AND TITLE = ${lit(title)}
          AND DUE_DATE = ${lit(dueDate)}
        ORDER BY CREATED_AT DESC NULLS LAST, ID DESC LIMIT 1`,
      CAL_SF
    )
    const id = created ? Number(created.ID) : null
    const task = id === null ? null : await loadTask(id)
    if (!task) {
      // Written, but not found again. Say so rather than claiming mail went.
      return NextResponse.json({ ok: true, notified: false, recipientCount: 0 })
    }

    const to = resolveRecipients(task, (await loadRecipients(true)).map((r) => r.email))
    const notified = await notifyTaskCreated(task, to, guard.email)
    return NextResponse.json({ ok: true, id: task.id, notified, recipientCount: to.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/tasks POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
