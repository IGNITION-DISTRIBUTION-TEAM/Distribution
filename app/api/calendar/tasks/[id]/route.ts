import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  CAL_SF,
  ITEMS_TABLE,
  blit,
  ensureCalendarTables,
  lit,
  loadRecipients,
  loadTask,
  normDaysBefore,
  normMode,
  normStatus,
  olit,
  parseId,
  validateDescription,
  validateDueDate,
  validateDueTime,
  validateTaskRecipients,
  validateTitle,
  recurrenceSets,
  type CalendarTask,
} from "@/lib/calendar-store"
import {
  describeRecurrence,
  isRecurring,
  nextOccurrence,
  normalizeRecurrence,
} from "@/lib/calendar-recurrence"
import { sastTodayIso } from "@/lib/calendar-dates"
import { notifyTaskDeleted, notifyTaskUpdated, resolveRecipients } from "@/lib/calendar-notify"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Edit and delete one calendar task, addressed by its autoincrement ID.
 *
 * By ID and not by a client-supplied index (which is what /api/daily-tasks
 * does): this is a shared calendar with concurrent editors, so an index-based
 * delete would eventually delete somebody else's row.
 */

/** The change list the update email carries — `Field: old → new`, ticket-notify's shape. */
function describeChanges(
  before: CalendarTask,
  after: CalendarTask,
  /** True when a roll-forward already reported the date move in its own words. */
  skipDate = false
): string[] {
  const out: string[] = []
  const line = (label: string, a: string, b: string) => {
    if (a !== b) out.push(`${label}: ${a || "(none)"} → ${b || "(none)"}`)
  }
  line("Title", before.title, after.title)
  if (!skipDate) line("Date", before.dueDate, after.dueDate)
  line("Time", before.dueTime ?? "(all day)", after.dueTime ?? "(all day)")
  line("Status", before.status, after.status)
  line("Assigned to", before.assignee ?? "", after.assignee ?? "")
  if ((before.description ?? "") !== (after.description ?? "")) out.push("Description changed")
  if (before.recipientsMode !== after.recipientsMode ||
      before.recipients.join(",") !== after.recipients.join(",")) {
    out.push("Notification list changed")
  }
  if (describeRecurrence(before.recurrence) !== describeRecurrence(after.recurrence)) {
    out.push(`Repeats: ${describeRecurrence(before.recurrence)} → ${describeRecurrence(after.recurrence)}`)
  }
  if (before.remindEnabled !== after.remindEnabled) {
    out.push(`Reminder: ${before.remindEnabled ? "on" : "off"} → ${after.remindEnabled ? "on" : "off"}`)
  } else if (before.remindDaysBefore !== after.remindDaysBefore) {
    out.push(`Reminder lead time: ${before.remindDaysBefore} → ${after.remindDaysBefore} day(s)`)
  }
  return out
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []
  if (body.title !== undefined) {
    const title = validateTitle(body.title)
    if (typeof title !== "string") return NextResponse.json(title, { status: 400 })
    sets.push(`TITLE = ${lit(title)}`)
  }
  if (body.description !== undefined) {
    const description = validateDescription(body.description)
    if (description !== null && typeof description !== "string") {
      return NextResponse.json(description, { status: 400 })
    }
    sets.push(`DESCRIPTION = ${olit(description)}`)
  }
  let newDueDate: string | null = null
  if (body.dueDate !== undefined) {
    const dueDate = validateDueDate(body.dueDate)
    if (typeof dueDate !== "string") return NextResponse.json(dueDate, { status: 400 })
    newDueDate = dueDate
    sets.push(`DUE_DATE = ${lit(dueDate)}`)
  }
  if (body.dueTime !== undefined) {
    const dueTime = validateDueTime(body.dueTime)
    if (dueTime !== null && typeof dueTime !== "string") {
      return NextResponse.json(dueTime, { status: 400 })
    }
    sets.push(`DUE_TIME = ${olit(dueTime)}`)
  }
  // Held rather than pushed: ticking off a RECURRING task does not close it, it
  // moves it to its next occurrence, and that decision needs the stored rule.
  const newStatus = body.status === undefined ? null : normStatus(body.status)
  if (body.assignee !== undefined) {
    sets.push(`ASSIGNEE = ${olit(typeof body.assignee === "string" ? body.assignee.trim() : null)}`)
  }
  if (body.recipientsMode !== undefined) {
    sets.push(`RECIPIENTS_MODE = ${lit(normMode(body.recipientsMode))}`)
  }
  if (body.recipients !== undefined) {
    const recipients = validateTaskRecipients(body.recipients)
    if (!Array.isArray(recipients)) return NextResponse.json(recipients, { status: 400 })
    sets.push(`RECIPIENTS_JSON = ${lit(JSON.stringify(recipients))}`)
  }
  if (body.remindEnabled !== undefined) {
    sets.push(`REMIND_ENABLED = ${blit(Boolean(body.remindEnabled))}`)
  }
  if (body.remindDaysBefore !== undefined) {
    sets.push(`REMIND_DAYS_BEFORE = ${normDaysBefore(body.remindDaysBefore)}`)
  }
  // Status and recurrence are appended later (both need the stored row), so a
  // PATCH carrying only one of them is legitimate with nothing in `sets` yet.
  if (sets.length === 0 && body.recurrence === undefined && newStatus === null) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    await ensureCalendarTables()
    // The pre-image is read anyway to build the change list; it also tells us
    // the task existed before we report success on an UPDATE that hit no rows.
    const before = await loadTask(taskId)
    if (!before) return NextResponse.json({ error: "Task not found" }, { status: 404 })

    // Resolved here rather than with the other fields because the rule's
    // defaults are anchored to the task's date — which is whatever this request
    // sets, or the stored one if it is not changing it.
    let rule = before.recurrence
    if (body.recurrence !== undefined) {
      rule = normalizeRecurrence(body.recurrence, newDueDate ?? before.dueDate)
      sets.push(...recurrenceSets(rule))
    }

    /**
     * Ticking off a recurring task.
     *
     * "Done" on a weekly standup means done with THIS week's, not with the
     * standup — so the row rolls to its next occurrence and stays open, and
     * REMINDER_SENT_FOR (which holds a date, not a flag) stops matching, so
     * next week's reminder re-arms by itself. When the rule has run past its
     * until date there is no next occurrence and the series really does close.
     *
     * The trade this makes: no per-occurrence history. Rolling the row forward
     * leaves no record that this week's standup happened. That is a second
     * table if it is ever wanted, not a tweak to this one.
     */
    let rolledTo: string | null = null
    let seriesEnded = false
    if (newStatus !== null) {
      const from = newDueDate ?? before.dueDate
      if (newStatus === "done" && isRecurring(rule)) {
        rolledTo = nextOccurrence(rule, from, sastTodayIso())
        if (rolledTo) {
          // Drop any DUE_DATE this request set explicitly: Snowflake rejects a
          // SET list that names the same column twice, and the roll wins.
          for (let i = sets.length - 1; i >= 0; i--) {
            if (sets[i].startsWith("DUE_DATE =")) sets.splice(i, 1)
          }
          sets.push(`DUE_DATE = ${lit(rolledTo)}`, "STATUS = 'open'")
        } else {
          seriesEnded = true
          sets.push(`STATUS = ${lit(newStatus)}`)
        }
      } else {
        sets.push(`STATUS = ${lit(newStatus)}`)
      }
    }

    sets.push("UPDATED_AT = CURRENT_TIMESTAMP()", `UPDATED_BY = ${lit(guard.email)}`)
    await executeSnowflakeQuery(
      `UPDATE ${ITEMS_TABLE} SET ${sets.join(", ")} WHERE ID = ${taskId}`,
      CAL_SF
    )

    const after = await loadTask(taskId)
    if (!after) return NextResponse.json({ ok: true, notified: false, recipientCount: 0 })

    const changes = describeChanges(before, after, rolledTo !== null)
    if (rolledTo) changes.unshift(`Done for ${before.dueDate}. Next: ${rolledTo}.`)
    if (seriesEnded) changes.unshift("This was the last occurrence — the series has finished.")
    if (changes.length === 0) {
      // Nothing a reader would care about moved. Do not spend an email on it.
      return NextResponse.json({ ok: true, notified: false, recipientCount: 0, unchanged: true })
    }

    const to = resolveRecipients(after, (await loadRecipients(true)).map((r) => r.email))
    const notified = await notifyTaskUpdated(after, to, guard.email, changes)
    return NextResponse.json({
      ok: true,
      notified,
      recipientCount: to.length,
      rolledTo,
      seriesEnded,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/tasks PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })

  try {
    await ensureCalendarTables()
    // Read it first — the mail needs the title and the recipient list, and
    // both are gone the moment the DELETE lands.
    const task = await loadTask(taskId)
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 })
    const to = resolveRecipients(task, (await loadRecipients(true)).map((r) => r.email))

    await executeSnowflakeQuery(`DELETE FROM ${ITEMS_TABLE} WHERE ID = ${taskId}`, CAL_SF)

    // Notify only after the delete succeeded: a failed delete must never send
    // a cancellation for a task that is still on the calendar.
    const notified = await notifyTaskDeleted(task, to, guard.email)
    return NextResponse.json({ ok: true, notified, recipientCount: to.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/tasks DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
