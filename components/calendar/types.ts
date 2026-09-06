/**
 * The shapes the Calendar API returns, as the client sees them.
 *
 * Deliberately re-declared rather than imported from lib/calendar-store.ts:
 * that module imports lib/snowflake, and pulling a server module's type into a
 * "use client" file drags its import graph along with it.
 */
export type RecurKind = "none" | "daily" | "weekly" | "monthly"

export type Recurrence = {
  kind: RecurKind
  interval: number
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekdays: number[]
  /** The anchor day, clamped per month. Monthly only. */
  dayOfMonth: number | null
  until: string | null
}

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
  recurrence: Recurrence
  /** Where the series began, as opposed to where it has rolled to. */
  seriesStart: string
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

/** What every mutation answers with, so the UI can say who was told. */
export type MutationResult = {
  ok: true
  id?: number
  notified: boolean
  recipientCount: number
  unchanged?: boolean
  /** Set when ticking off a recurring task moved it to its next occurrence. */
  rolledTo?: string | null
  /** Set when that was the series' last occurrence. */
  seriesEnded?: boolean
}
