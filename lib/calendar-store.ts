/**
 * What the Calendar department stores, and how it talks to Snowflake.
 *
 * NAMING. The tables are TSK_CALENDAR_*, and the item table is
 * TSK_CALENDAR_ITEMS rather than ..._TASKS. `TSK_` is this app's prefix for
 * "a table the app owns" — it does not mean "task" — so TSK_CALENDAR_TASKS
 * would stutter, and "task" already means three other machine things here
 * (/api/distribution/tasks = scheduled procs, /api/daily-tasks = a checklist,
 * Task Automation = SFTP jobs). Everything user-facing still says "task"; only
 * the table name differs.
 *
 *   TSK_CALENDAR_ITEMS          one row per calendar task
 *   TSK_CALENDAR_RECIPIENTS     the standing team mailing list
 *   TSK_CALENDAR_NOTIFICATIONS  append-only, one row per mail attempt
 *
 * The third table is not bookkeeping for its own sake. Mail here is best
 * effort and never throws, which means "email is switched off" and "email
 * works" look identical from inside the app. One INSERT per notify is what
 * makes "did my teammates actually get it?" answerable.
 *
 * PER-TASK RECIPIENTS ARE A JSON COLUMN, not a join table. There are no
 * transactions — every executeSnowflakeQuery is a separate HTTPS round trip —
 * so deleting a task and then its recipient rows would leave orphans the first
 * time either call failed. Recipients carry no per-recipient state, so a row
 * would hold nothing the array does not.
 *
 * All tables self-migrate the way lib/sftp-sync-registry.ts does: CREATE TABLE
 * IF NOT EXISTS, then introspect INFORMATION_SCHEMA and ALTER in anything an
 * older copy is missing.
 */
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { isValidIsoDate, isValidTime } from "@/lib/calendar-dates"

export const CAL_SF = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const
export const ITEMS_TABLE = `${CAL_SF.database}.${CAL_SF.schema}.TSK_CALENDAR_ITEMS`
export const RECIPIENTS_TABLE = `${CAL_SF.database}.${CAL_SF.schema}.TSK_CALENDAR_RECIPIENTS`
export const NOTIFY_TABLE = `${CAL_SF.database}.${CAL_SF.schema}.TSK_CALENDAR_NOTIFICATIONS`

/** SAST wall-clock hour at or after which the cron may send the day's reminders. */
export const REMIND_AT = "07:00"

/** Ceilings, because the recipient list is editable by anyone with the department. */
export const MAX_TEAM_RECIPIENTS = 50
export const MAX_TASK_RECIPIENTS = 20
export const MAX_TITLE = 200
export const MAX_DESCRIPTION = 4000
export const MAX_REMIND_DAYS = 30

/* ------------------------------------------------------------------ tables */

const ITEM_COLUMNS: [string, string][] = [
  ["TITLE", "VARCHAR"],
  ["DESCRIPTION", "VARCHAR"],
  ["DUE_DATE", "VARCHAR"], // 'YYYY-MM-DD', a SAST wall date — see lib/calendar-dates.ts
  ["DUE_TIME", "VARCHAR"], // 'HH:MM', NULL means all day
  ["STATUS", "VARCHAR"], // 'open' | 'done' | 'cancelled'
  ["ASSIGNEE", "VARCHAR"],
  ["RECIPIENTS_MODE", "VARCHAR"], // 'team' | 'custom' | 'both'
  ["RECIPIENTS_JSON", "VARCHAR"], // JSON string[] — the per-task override
  ["REMIND_ENABLED", "BOOLEAN"],
  ["REMIND_DAYS_BEFORE", "NUMBER"], // 0 = the morning it is due
  ["REMINDER_SENT_FOR", "VARCHAR"], // the DUE_DATE a reminder was sent for, not a flag
  ["REMINDER_SENT_AT", "TIMESTAMP_NTZ"],
  ["CREATED_AT", "TIMESTAMP_NTZ"],
  ["CREATED_BY", "VARCHAR"],
  ["UPDATED_AT", "TIMESTAMP_NTZ"],
  ["UPDATED_BY", "VARCHAR"],
]

const RECIPIENT_COLUMNS: [string, string][] = [
  ["EMAIL", "VARCHAR"],
  ["DISPLAY_NAME", "VARCHAR"],
  ["ACTIVE", "BOOLEAN"],
  ["CREATED_AT", "TIMESTAMP_NTZ"],
  ["CREATED_BY", "VARCHAR"],
]

const NOTIFY_COLUMNS: [string, string][] = [
  ["TASK_ID", "NUMBER"],
  ["KIND", "VARCHAR"], // 'created' | 'updated' | 'deleted' | 'reminder'
  ["TITLE", "VARCHAR"],
  ["FOR_DATE", "VARCHAR"], // the reminder's target date; NULL for lifecycle mail
  ["RECIPIENTS_CSV", "VARCHAR"],
  ["RECIPIENT_COUNT", "NUMBER"],
  ["OK", "BOOLEAN"],
  ["MESSAGE", "VARCHAR"], // why it did not send, or NULL
  ["ACTOR", "VARCHAR"], // the acting user's email, or 'cron'
  ["SENT_AT", "TIMESTAMP_NTZ"],
]

/* SQL literals. Same three helpers as lib/sftp-sync-registry.ts — every query
   in this app is raw interpolated SQL, so nothing user-typed may reach one
   without passing through here. */
export const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`
export const nlit = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? "NULL" : String(v)
export const blit = (v: boolean) => (v ? "TRUE" : "FALSE")
/** A literal or NULL, for optional text columns. */
export const olit = (v: string | null | undefined) => (v == null || v === "" ? "NULL" : lit(v))

async function ensure(table: string, bare: string, columns: [string, string][], idCol: string) {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${table} (
       ${idCol} NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       ${columns.map(([n, t]) => `${n} ${t}`).join(", ")}
     )`,
    CAL_SF
  )
  try {
    const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM ${CAL_SF.database}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = '${CAL_SF.schema}' AND TABLE_NAME = '${bare}'`,
      CAL_SF
    )
    const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toUpperCase()))
    for (const [name, type] of columns) {
      if (!have.has(name)) {
        try {
          await executeSnowflakeQuery(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, CAL_SF)
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* introspection best-effort */
  }
}

/**
 * Memo, because this is six round trips to Snowflake and it sits in front of
 * the first paint. Set only on success: a throw leaves it false so the next
 * request tries again, and a cold lambda re-runs it from scratch anyway.
 *
 * Note that `ensure` writes no DEFAULT clauses, so every INSERT below supplies
 * CREATED_AT, STATUS and the rest explicitly, and every read COALESCEs them —
 * a column added by ALTER is NULL on existing rows either way.
 */
let ensured = false

export async function ensureCalendarTables(): Promise<void> {
  if (ensured) return
  await ensure(ITEMS_TABLE, "TSK_CALENDAR_ITEMS", ITEM_COLUMNS, "ID")
  await ensure(RECIPIENTS_TABLE, "TSK_CALENDAR_RECIPIENTS", RECIPIENT_COLUMNS, "RECIPIENT_ID")
  await ensure(NOTIFY_TABLE, "TSK_CALENDAR_NOTIFICATIONS", NOTIFY_COLUMNS, "LOG_ID")
  ensured = true
}

/* ------------------------------------------------------------------ shapes */

export type RecipientsMode = "team" | "custom" | "both"
export type TaskStatus = "open" | "done" | "cancelled"

export type CalendarTask = {
  id: number
  title: string
  description: string | null
  dueDate: string
  dueTime: string | null
  status: TaskStatus
  assignee: string | null
  recipientsMode: RecipientsMode
  recipients: string[]
  remindEnabled: boolean
  remindDaysBefore: number
  reminderSentFor: string | null
  createdAt: string | null
  createdBy: string | null
  updatedAt: string | null
  updatedBy: string | null
}

export type TeamRecipient = {
  id: number
  email: string
  displayName: string | null
  active: boolean
  createdBy: string | null
}

export type NotificationLogRow = {
  id: number
  taskId: number | null
  kind: string
  title: string | null
  forDate: string | null
  recipients: string
  recipientCount: number
  ok: boolean
  message: string | null
  actor: string | null
  sentAt: string | null
}

/* -------------------------------------------------------------- validation */

export function normStatus(value: unknown): TaskStatus {
  const s = String(value ?? "").toLowerCase()
  return s === "done" || s === "cancelled" ? s : "open"
}

export function normMode(value: unknown): RecipientsMode {
  const s = String(value ?? "").toLowerCase()
  return s === "custom" || s === "both" ? s : "team"
}

export function normDaysBefore(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, MAX_REMIND_DAYS)
}

/** A trimmed title, or an error object ready to be returned as a 400 body. */
export function validateTitle(value: unknown): string | { error: string } {
  const title = typeof value === "string" ? value.trim() : ""
  if (!title) return { error: "Title is required" }
  if (title.length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or fewer` }
  return title
}

export function validateDescription(value: unknown): string | null | { error: string } {
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > MAX_DESCRIPTION) {
    return { error: `Description must be ${MAX_DESCRIPTION} characters or fewer` }
  }
  return text
}

export function validateDueDate(value: unknown): string | { error: string } {
  if (!isValidIsoDate(value)) return { error: "Date must be a real date in YYYY-MM-DD form" }
  return value
}

export function validateDueTime(value: unknown): string | null | { error: string } {
  if (value == null || value === "") return null
  if (!isValidTime(value)) return { error: "Time must be HH:MM in 24-hour form" }
  return value
}

/** A row's per-task override list: cleaned, lower-cased, deduped, capped. */
export function validateTaskRecipients(value: unknown): string[] | { error: string } {
  if (value == null) return []
  if (!Array.isArray(value)) return { error: "Recipients must be a list of email addresses" }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const email = String(raw ?? "").trim().toLowerCase()
    if (!email) continue
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) {
      return { error: `Not a valid email address: ${email}` }
    }
    if (seen.has(email)) continue
    seen.add(email)
    out.push(email)
  }
  if (out.length > MAX_TASK_RECIPIENTS) {
    return { error: `A task can notify at most ${MAX_TASK_RECIPIENTS} extra addresses` }
  }
  return out
}

export function parseId(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/* ----------------------------------------------------------- row → object */

function parseRecipientsJson(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((v) => String(v)).filter(Boolean)
  } catch {
    return []
  }
}

const str = (v: unknown): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

/** Snowflake gives booleans back as true/false or the strings "true"/"false". */
const bool = (v: unknown, fallback: boolean): boolean => {
  if (v == null) return fallback
  if (typeof v === "boolean") return v
  const s = String(v).toLowerCase()
  if (s === "true" || s === "1") return true
  if (s === "false" || s === "0") return false
  return fallback
}

export function rowToTask(row: Record<string, unknown>): CalendarTask {
  return {
    id: Number(row.ID),
    title: String(row.TITLE ?? ""),
    description: str(row.DESCRIPTION),
    dueDate: String(row.DUE_DATE ?? ""),
    dueTime: str(row.DUE_TIME),
    status: normStatus(row.STATUS),
    assignee: str(row.ASSIGNEE),
    recipientsMode: normMode(row.RECIPIENTS_MODE),
    recipients: parseRecipientsJson(row.RECIPIENTS_JSON),
    remindEnabled: bool(row.REMIND_ENABLED, true),
    remindDaysBefore: normDaysBefore(row.REMIND_DAYS_BEFORE ?? 0),
    reminderSentFor: str(row.REMINDER_SENT_FOR),
    createdAt: str(row.CREATED_AT),
    createdBy: str(row.CREATED_BY),
    updatedAt: str(row.UPDATED_AT),
    updatedBy: str(row.UPDATED_BY),
  }
}

export function rowToRecipient(row: Record<string, unknown>): TeamRecipient {
  return {
    id: Number(row.RECIPIENT_ID),
    email: String(row.EMAIL ?? "").toLowerCase(),
    displayName: str(row.DISPLAY_NAME),
    active: bool(row.ACTIVE, true),
    createdBy: str(row.CREATED_BY),
  }
}

export function rowToLog(row: Record<string, unknown>): NotificationLogRow {
  return {
    id: Number(row.LOG_ID),
    taskId: row.TASK_ID == null ? null : Number(row.TASK_ID),
    kind: String(row.KIND ?? ""),
    title: str(row.TITLE),
    forDate: str(row.FOR_DATE),
    recipients: String(row.RECIPIENTS_CSV ?? ""),
    recipientCount: Number(row.RECIPIENT_COUNT ?? 0),
    ok: bool(row.OK, false),
    message: str(row.MESSAGE),
    actor: str(row.ACTOR),
    sentAt: str(row.SENT_AT),
  }
}

/* --------------------------------------------------------------- accessors */

const TASK_SELECT = `SELECT ID, TITLE, DESCRIPTION, DUE_DATE, DUE_TIME,
       COALESCE(STATUS, 'open') AS STATUS, ASSIGNEE,
       COALESCE(RECIPIENTS_MODE, 'team') AS RECIPIENTS_MODE, RECIPIENTS_JSON,
       COALESCE(REMIND_ENABLED, TRUE) AS REMIND_ENABLED,
       COALESCE(REMIND_DAYS_BEFORE, 0) AS REMIND_DAYS_BEFORE,
       REMINDER_SENT_FOR, CREATED_AT, CREATED_BY, UPDATED_AT, UPDATED_BY
  FROM ${ITEMS_TABLE}`

export async function loadTask(id: number): Promise<CalendarTask | null> {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `${TASK_SELECT} WHERE ID = ${id}`,
    CAL_SF
  )
  return rows.length > 0 ? rowToTask(rows[0]) : null
}

/**
 * The list the dashboard shows: everything still open, plus anything closed in
 * the last 30 days. There is no pagination, so without that floor the table
 * grows without bound and every visit pays for it.
 */
export async function loadTasks(sinceIso: string): Promise<CalendarTask[]> {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `${TASK_SELECT}
      WHERE COALESCE(STATUS, 'open') = 'open' OR DUE_DATE >= ${lit(sinceIso)}
      ORDER BY DUE_DATE, DUE_TIME NULLS FIRST, ID`,
    CAL_SF
  )
  return rows.map(rowToTask)
}

export async function loadRecipients(activeOnly = false): Promise<TeamRecipient[]> {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `SELECT RECIPIENT_ID, EMAIL, DISPLAY_NAME, COALESCE(ACTIVE, TRUE) AS ACTIVE, CREATED_BY
       FROM ${RECIPIENTS_TABLE}
      ${activeOnly ? "WHERE COALESCE(ACTIVE, TRUE) = TRUE" : ""}
      ORDER BY LOWER(EMAIL)`,
    CAL_SF
  )
  return rows.map(rowToRecipient)
}

/** Just the addresses the standing list would notify. */
export async function loadTeamEmails(): Promise<string[]> {
  return (await loadRecipients(true)).map((r) => r.email)
}

export async function loadNotificationLog(limit: number): Promise<NotificationLogRow[]> {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `SELECT LOG_ID, TASK_ID, KIND, TITLE, FOR_DATE, RECIPIENTS_CSV, RECIPIENT_COUNT,
            OK, MESSAGE, ACTOR, SENT_AT
       FROM ${NOTIFY_TABLE}
      ORDER BY SENT_AT DESC NULLS LAST, LOG_ID DESC
      LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit) || 50))}`,
    CAL_SF
  )
  return rows.map(rowToLog)
}

/**
 * Record a mail attempt. Best effort in the same sense the mail itself is: if
 * the log write fails, the user's action must still succeed, so this swallows.
 * A missing log line is a gap in the evidence, not a failed task.
 */
export async function logNotification(entry: {
  taskId: number | null
  kind: string
  title: string | null
  forDate: string | null
  recipients: string[]
  ok: boolean
  message: string | null
  actor: string
}): Promise<void> {
  try {
    await executeSnowflakeQuery(
      `INSERT INTO ${NOTIFY_TABLE}
         (TASK_ID, KIND, TITLE, FOR_DATE, RECIPIENTS_CSV, RECIPIENT_COUNT, OK, MESSAGE, ACTOR, SENT_AT)
       SELECT ${nlit(entry.taskId)}, ${lit(entry.kind)}, ${olit(entry.title)},
              ${olit(entry.forDate)}, ${lit(entry.recipients.join(", "))},
              ${entry.recipients.length}, ${blit(entry.ok)}, ${olit(entry.message)},
              ${lit(entry.actor)}, CURRENT_TIMESTAMP()`,
      CAL_SF
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[calendar-store] notification log write failed:", message)
  }
}
