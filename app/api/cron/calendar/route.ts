import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { cronAuthed } from "@/lib/cron-auth"
import { daysBetween, sastTodayIso } from "@/lib/calendar-dates"
import { isRecurring, nextOccurrence } from "@/lib/calendar-recurrence"
import {
  CAL_SF,
  ITEMS_TABLE,
  REMIND_AT,
  ensureCalendarTables,
  lit,
  loadTeamEmails,
  rowToTask,
} from "@/lib/calendar-store"
import { notifyTaskReminder, resolveRecipients } from "@/lib/calendar-notify"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Calendar reminders. Vercel Cron hits this every half hour (see vercel.json).
 *
 * A SEPARATE CRON from /api/cron/distribution, not an extra branch inside it:
 * different failure domain (a Snowflake error in the distribution fan-out must
 * not eat calendar mail, or the reverse), and a separate path means a separate
 * Vercel log line, so "did the calendar cron run at all" is answerable.
 *
 * WHY EVERY 30 MINUTES rather than once at 07:00. A once-daily cron that misses
 * its tick sends nothing that day and says nothing about it. Here the predicate
 * is a window, not an instant — an unfired reminder stays selected on every
 * subsequent tick until it goes out. The reminder can be up to 29 minutes late;
 * it cannot be silently absent.
 */

/** How many tasks one invocation will mail, and how far apart. */
const BATCH = 60
const PACE_MS = 1500

/**
 * Roll every overdue recurring series onto its next occurrence.
 *
 * Runs BEFORE the reminder pass, and that order matters: the reminder query
 * refuses anything already past its date, so a series left sitting on
 * yesterday would be skipped, advanced, and only reminded on the next tick
 * half an hour later. Advancing first means it is reminded on this one.
 *
 * Safe to run twice. `nextOccurrence` is asked for the next date that is also
 * today or later, so a series three weeks overdue lands on the real next
 * occurrence in one step rather than being walked forward three times — and
 * once its date is today or later, the WHERE clause below stops matching it.
 *
 * Returns how many rows moved. Failures are logged and skipped: one unparseable
 * rule must not stop the rest of the calendar from working.
 */
async function advanceRecurring(today: string): Promise<number> {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `SELECT ID, TITLE, DUE_DATE,
            COALESCE(RECUR_KIND, 'none') AS RECUR_KIND,
            COALESCE(RECUR_INTERVAL, 1) AS RECUR_INTERVAL,
            RECUR_WEEKDAYS, RECUR_DAY_OF_MONTH, RECUR_UNTIL
       FROM ${ITEMS_TABLE}
      WHERE COALESCE(STATUS, 'open') = 'open'
        AND COALESCE(RECUR_KIND, 'none') <> 'none'
        AND DUE_DATE IS NOT NULL
        AND DUE_DATE < ${lit(today)}
      ORDER BY ID
      LIMIT ${BATCH}`,
    CAL_SF
  )

  let moved = 0
  for (const row of rows) {
    const task = rowToTask(row)
    if (!isRecurring(task.recurrence)) continue
    try {
      const next = nextOccurrence(task.recurrence, task.dueDate, today)
      if (next) {
        // The date guard makes this a no-op if another invocation got here
        // first, so two overlapping runs cannot step the series twice.
        await executeSnowflakeQuery(
          `UPDATE ${ITEMS_TABLE}
              SET DUE_DATE = ${lit(next)}, UPDATED_AT = CURRENT_TIMESTAMP(), UPDATED_BY = 'cron'
            WHERE ID = ${task.id} AND DUE_DATE = ${lit(task.dueDate)}`,
          CAL_SF
        )
      } else {
        // Past its until date: the series is over, so close it rather than
        // leaving it overdue forever.
        await executeSnowflakeQuery(
          `UPDATE ${ITEMS_TABLE}
              SET STATUS = 'done', UPDATED_AT = CURRENT_TIMESTAMP(), UPDATED_BY = 'cron'
            WHERE ID = ${task.id} AND COALESCE(STATUS, 'open') = 'open'`,
          CAL_SF
        )
      }
      moved++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[/api/cron/calendar] advancing task ${task.id} failed:`, message)
    }
  }
  return moved
}

async function handle(request: NextRequest) {
  if (!cronAuthed(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const today = sastTodayIso()
  let due: Record<string, unknown>[] = []
  let team: string[] = []
  let advanced = 0

  try {
    await ensureCalendarTables()
    advanced = await advanceRecurring(today)
    // Everything below is evaluated in SAST. SYSDATE() is UTC, which is what
    // makes CONVERT_TIMEZONE('UTC', …) correct — the same idiom as the
    // distribution cron.
    const NOW = "CONVERT_TIMEZONE('UTC','Africa/Johannesburg', SYSDATE())"
    due = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT ID, TITLE, DESCRIPTION, DUE_DATE, DUE_TIME, ASSIGNEE, CREATED_BY,
              COALESCE(STATUS, 'open') AS STATUS,
              COALESCE(RECIPIENTS_MODE, 'team') AS RECIPIENTS_MODE, RECIPIENTS_JSON,
              COALESCE(REMIND_ENABLED, TRUE) AS REMIND_ENABLED,
              COALESCE(REMIND_DAYS_BEFORE, 0) AS REMIND_DAYS_BEFORE,
              REMINDER_SENT_FOR
         FROM ${ITEMS_TABLE}
        WHERE COALESCE(STATUS, 'open') = 'open'
          AND COALESCE(REMIND_ENABLED, TRUE) = TRUE
          AND DUE_DATE IS NOT NULL
          -- The marker holds the DUE_DATE it was sent for, so moving a task
          -- re-arms its reminder with no extra work in the PATCH handler.
          AND (REMINDER_SENT_FOR IS NULL OR REMINDER_SENT_FOR <> DUE_DATE)
          -- Never reminded about something already past — those belong in the
          -- dashboard's Overdue group, not in somebody's inbox.
          AND TO_DATE(DUE_DATE) >= TO_DATE(${NOW})
          -- <= rather than =: this is what makes a missed tick self-healing.
          AND DATEADD(day, -COALESCE(REMIND_DAYS_BEFORE, 0), TO_DATE(DUE_DATE)) <= TO_DATE(${NOW})
          AND TO_CHAR(${NOW}, 'HH24:MI') >= '${REMIND_AT}'
        ORDER BY DUE_DATE, ID
        LIMIT ${BATCH}`,
      CAL_SF
    )
    team = await loadTeamEmails()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/cron/calendar] selection failed:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const results: { id: number; ok: boolean; recipients: number; error?: string }[] = []
  let sent = 0
  let failed = 0

  for (const row of due) {
    const task = rowToTask(row)
    try {
      /**
       * Claim the row BEFORE sending, and send only if the claim took it.
       *
       * There are no transactions and no row locks here, so two overlapping
       * invocations could in principle both claim; the claim-then-send order
       * narrows that to milliseconds. The trade is deliberate: if the mail then
       * fails the marker is already set and this task gets no retry today — a
       * silent duplicate storm is worse than one missed reminder, and the
       * failure is recorded in TSK_CALENDAR_NOTIFICATIONS either way.
       */
      const claim = await executeSnowflakeQuery<Record<string, unknown>>(
        `UPDATE ${ITEMS_TABLE}
            SET REMINDER_SENT_FOR = DUE_DATE, REMINDER_SENT_AT = CURRENT_TIMESTAMP()
          WHERE ID = ${task.id}
            AND (REMINDER_SENT_FOR IS NULL OR REMINDER_SENT_FOR <> DUE_DATE)`,
        CAL_SF
      )
      // Snowflake's SQL API returns DML as one row whose single column is
      // "number of rows updated". Read it by position rather than by that
      // exact name, so a change in wording cannot silently make every claim
      // look like a miss.
      const updated = Number(Object.values(claim[0] ?? {})[0] ?? 0)
      if (updated < 1) continue

      const to = resolveRecipients(task, team)
      const ok = await notifyTaskReminder(task, to, daysBetween(today, task.dueDate))
      results.push({ id: task.id, ok, recipients: to.length })
      if (ok) sent++
      else failed++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[/api/cron/calendar] task ${task.id} failed:`, message)
      results.push({ id: task.id, ok: false, recipients: 0, error: message })
      failed++
    }

    // Nothing in the mail path handles a 429, so pace the batch. Anything left
    // over is picked up by the next tick — it was never claimed.
    if (PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS))
  }

  return NextResponse.json({ ok: true, today, advanced, considered: due.length, sent, failed, results })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
