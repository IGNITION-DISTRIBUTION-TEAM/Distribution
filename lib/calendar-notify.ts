import { sendGraphMail } from "@/lib/graph-mail"
import {
  logNotification,
  type CalendarTask,
  type RecipientsMode,
} from "@/lib/calendar-store"
import { formatDateShort, formatWhen } from "@/lib/calendar-dates"

/**
 * Calendar email, sent from the DWH_automation mailbox.
 *
 * Same contract as lib/ticket-notify.ts, deliberately: every function here is
 * BEST EFFORT and NEVER THROWS, and returns whether mail actually went. A task
 * that was written to Snowflake must not be reported as failed because the
 * mail step was — the user would retry and create a duplicate. Mail being
 * disabled or unconfigured is an expected state while email is being set up,
 * so it is logged with console.info rather than console.error; anything else
 * is a real fault.
 *
 * One addition over ticket-notify: every attempt, including "there was nobody
 * to send to", is written to TSK_CALENDAR_NOTIFICATIONS. Mail that never
 * throws is mail whose absence is invisible, and the whole point of this
 * feature is that teammates get told.
 */

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Nobody needs 100 people on one task; this is a runaway guard, not a policy. */
const MAX_TO = 100

function calendarLink(): string | null {
  return APP_URL ? `${APP_URL}/departments/calendar` : null
}

function footer(): string[] {
  const link = calendarLink()
  return [
    "",
    ...(link ? [`Open the calendar: ${link}`, ""] : []),
    "This is an automated message from the Ignition Distribution portal.",
    "Replies to this address are not monitored.",
  ]
}

/**
 * Who this task's mail goes to.
 *
 * Pure and exported so scripts/calendar/calendar-tests.ts can cover it — the
 * merge is the piece most likely to be quietly wrong, and a bug here means
 * either the wrong people are told or nobody is.
 *
 * Lower-casing happens BEFORE the dedupe on purpose. Exchange treats addresses
 * case-insensitively; a Set does not, so "Ann@x.co" and "ann@x.co" would
 * otherwise both survive and Ann would get two copies.
 */
export function resolveRecipients(
  task: { recipientsMode: RecipientsMode; recipients: string[] },
  team: string[]
): string[] {
  const source =
    task.recipientsMode === "custom"
      ? task.recipients
      : task.recipientsMode === "both"
        ? [...team, ...task.recipients]
        : team

  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of source) {
    const email = String(raw ?? "").trim().toLowerCase()
    if (!email || seen.has(email) || !EMAIL_RE.test(email)) continue
    seen.add(email)
    out.push(email)
    if (out.length >= MAX_TO) break
  }
  return out
}

/**
 * Send, classify a failure, and record the attempt. Returns whether mail went.
 *
 * The log write lives here rather than in the callers so no route can forget
 * it — every path that can send, including the empty-recipients path, goes
 * through this one function.
 */
async function trySend(input: {
  to: string[]
  subject: string
  lines: string[]
  what: string
  taskId: number | null
  kind: string
  title: string | null
  forDate: string | null
  actor: string
}): Promise<boolean> {
  const { to, what, taskId, kind, title, forDate, actor } = input

  if (to.length === 0) {
    console.info(`[calendar-notify] ${what} not sent (no recipients)`)
    await logNotification({
      taskId, kind, title, forDate, recipients: [], ok: false,
      message: "no recipients", actor,
    })
    return false
  }

  try {
    await sendGraphMail({ to, subject: input.subject, body: input.lines.join("\n") })
    await logNotification({
      taskId, kind, title, forDate, recipients: to, ok: true, message: null, actor,
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Matches the two throws in lib/graph-mail.ts and the missing-key case.
    const expected = /disabled in App settings|no sending mailbox|GRAPH_MAIL_PRIVATE_KEY/i.test(
      message
    )
    if (expected) {
      console.info(`[calendar-notify] ${what} not sent (mail not configured): ${message}`)
    } else {
      console.error(`[calendar-notify] ${what} failed:`, message)
    }
    await logNotification({ taskId, kind, title, forDate, recipients: to, ok: false, message, actor })
    return false
  }
}

/** The block of detail every mail repeats, so a reader never has to open the app. */
function detailLines(task: CalendarTask): string[] {
  const lines = [`When: ${formatWhen(task.dueDate, task.dueTime)}`]
  if (task.assignee) lines.push(`Assigned to: ${task.assignee}`)
  if (task.description) lines.push("", task.description)
  return lines
}

export async function notifyTaskCreated(
  task: CalendarTask,
  to: string[],
  actor: string
): Promise<boolean> {
  return trySend({
    to,
    subject: `[Calendar] New task: ${task.title} — ${formatDateShort(task.dueDate)}`,
    lines: [
      `${actor} added a task to the team calendar.`,
      "",
      task.title,
      ...detailLines(task),
      ...footer(),
    ],
    what: `created #${task.id}`,
    taskId: task.id,
    kind: "created",
    title: task.title,
    forDate: null,
    actor,
  })
}

/**
 * Update mail, with a change list in the same `A → B` shape ticket-notify
 * uses. `changes` comes from comparing the pre-image the PATCH route reads
 * before it writes — a bare "this task changed" is not worth an email.
 */
export async function notifyTaskUpdated(
  task: CalendarTask,
  to: string[],
  actor: string,
  changes: string[]
): Promise<boolean> {
  return trySend({
    to,
    subject: `[Calendar] Updated: ${task.title} — ${formatDateShort(task.dueDate)}`,
    lines: [
      `${actor} changed a task on the team calendar.`,
      "",
      task.title,
      ...(changes.length > 0 ? ["", ...changes] : []),
      "",
      ...detailLines(task),
      ...footer(),
    ],
    what: `updated #${task.id}`,
    taskId: task.id,
    kind: "updated",
    title: task.title,
    forDate: null,
    actor,
  })
}

export async function notifyTaskDeleted(
  task: CalendarTask,
  to: string[],
  actor: string
): Promise<boolean> {
  return trySend({
    to,
    subject: `[Calendar] Cancelled: ${task.title} — ${formatDateShort(task.dueDate)}`,
    lines: [
      `${actor} removed a task from the team calendar.`,
      "",
      task.title,
      `When it was due: ${formatWhen(task.dueDate, task.dueTime)}`,
      ...footer(),
    ],
    what: `deleted #${task.id}`,
    taskId: task.id,
    kind: "deleted",
    title: task.title,
    forDate: null,
    actor,
  })
}

/** How near "due" is, in the words a subject line wants. */
export function dueWording(daysAway: number): string {
  if (daysAway <= 0) return "Due today"
  if (daysAway === 1) return "Due tomorrow"
  return `Due in ${daysAway} days`
}

export async function notifyTaskReminder(
  task: CalendarTask,
  to: string[],
  daysAway: number
): Promise<boolean> {
  const wording = dueWording(daysAway)
  return trySend({
    to,
    subject: `[Calendar] ${wording}: ${task.title}`,
    lines: [
      `Reminder — ${wording.toLowerCase()}.`,
      "",
      task.title,
      ...detailLines(task),
      ...(task.createdBy ? ["", `Added by ${task.createdBy}.`] : []),
      ...footer(),
    ],
    what: `reminder #${task.id}`,
    taskId: task.id,
    kind: "reminder",
    title: task.title,
    forDate: task.dueDate,
    actor: "cron",
  })
}
