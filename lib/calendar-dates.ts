/**
 * Dates for the Calendar department, in one place, in Africa/Johannesburg.
 *
 * A calendar task is a WALL DATE — "the 12th" — not an instant. It is stored
 * as a 'YYYY-MM-DD' string and never as a Snowflake DATE or TIMESTAMP, because
 * either of those reaches the browser as something `new Date()` parses as UTC
 * midnight, which renders as the previous day west of Greenwich. The same
 * reasoning already made SCHEDULE_TIME a 'HH:MM' VARCHAR in
 * app/api/distribution/tasks/route.ts.
 *
 * The one rule everything else here follows: "today" is the date it is in
 * Johannesburg, not the date it is on the viewer's laptop. The reminder cron
 * evaluates the same day boundary in Snowflake with
 * CONVERT_TIMEZONE('UTC','Africa/Johannesburg', SYSDATE()), so a user in UTC
 * must not see a task filed under "Tomorrow" that the cron already considers
 * due. There is a private todayLocalIso() in distribution-dashboard.tsx that
 * uses browser-local time — do not copy it here.
 *
 * Africa/Johannesburg is a fixed GMT+02:00 with no DST, so a wall date is
 * unambiguous and no offset table is needed.
 */

export const CAL_TZ = "Africa/Johannesburg"

/** 'YYYY-MM-DD' for the current SAST wall date. en-CA formats in ISO order. */
export function sastTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAL_TZ }).format(now)
}

/**
 * Is this a real calendar date?
 *
 * The shape test alone accepts 2026-02-31. The round trip through UTC — safe,
 * because both ends are UTC and the string carries no offset — rejects it:
 * Date normalises the overflow to 2026-03-03 and the strings stop matching.
 */
export function isValidIsoDate(iso: unknown): iso is string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

/** The repo-wide wall-clock time shape, same regex as the distribution tasks route. */
export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** Date arithmetic on the string, via UTC so no local offset can leak in. */
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 0 = Sunday … 6 = Saturday, for the ISO date as a wall date. */
export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/** 'Friday 12 September'. Built by hand so it cannot pick up a viewer's locale. */
export function formatDateLabel(iso: string, withYear = false): string {
  if (!isValidIsoDate(iso)) return iso
  const d = new Date(`${iso}T00:00:00Z`)
  const base = `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`
  return withYear ? `${base} ${d.getUTCFullYear()}` : base
}

/** 'Fri 12 Sep' — the short form the email subjects use. */
export function formatDateShort(iso: string): string {
  if (!isValidIsoDate(iso)) return iso
  const d = new Date(`${iso}T00:00:00Z`)
  return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)}`
}

/** 'Friday 12 September 2026, 14:30' / '… (all day)' — the email "When:" line. */
export function formatWhen(iso: string, time: string | null): string {
  const day = formatDateLabel(iso, true)
  return time ? `${day}, ${time}` : `${day} (all day)`
}

export type CalendarGroup = "overdue" | "today" | "tomorrow" | "week" | "later"

export const GROUP_LABELS: Record<CalendarGroup, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
}

/** Render order for the grouped list. */
export const GROUP_ORDER: CalendarGroup[] = ["overdue", "today", "tomorrow", "week", "later"]

/**
 * Which bucket a due date falls in, relative to a SAST today.
 *
 * "This week" runs from the day after tomorrow through the coming Sunday, so
 * the week starts on Monday. On a Saturday or Sunday that window is empty or
 * one day long and everything else falls to "Later" — correct, not a bug: on a
 * Sunday, "this week" genuinely has nothing left in it.
 */
export function groupFor(iso: string, today: string): CalendarGroup {
  if (iso < today) return "overdue"
  if (iso === today) return "today"
  const tomorrow = addDaysIso(today, 1)
  if (iso === tomorrow) return "tomorrow"
  const dow = dayOfWeek(today)
  // Days from today to the coming Sunday. Sunday itself has none left.
  const toSunday = dow === 0 ? 0 : 7 - dow
  return iso <= addDaysIso(today, toSunday) ? "week" : "later"
}

/* ------------------------------------------------------- month arithmetic */

/**
 * Month maths for the grid, in the same UTC-string style as everything above.
 *
 * Not date-fns. It sits in package.json as react-day-picker's peer dependency
 * and no source file imports it; becoming the first importer would pull locale
 * formatting into a module that builds its month names by hand precisely so a
 * viewer's locale cannot reach them.
 *
 * Not `Date.setMonth` either. It overflows — the repo already documents the
 * failure at components/distribution-dashboard.tsx:4705, where stepping a
 * month back from 31 August lands in March. Everything here builds the month
 * from parts and clamps the day, which is the same rule the monthly recurrence
 * anchor follows.
 */

/** Days in a civil month. `mo` is 1-12. Mirrors lib/cron-schedule.ts. */
function daysInCivilMonth(y: number, mo: number): number {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(mo) ? 30 : 31
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

/** The 1st of the month containing `iso`. */
export function startOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/**
 * `n` months on (or back), with the day clamped to the target month's length.
 *
 * 31 January plus one month is 28 February, not 3 March. Callers that want a
 * repeating series should still anchor on the stored day rather than chaining
 * this, or the clamp compounds and the series never returns to the 31st.
 */
export function addMonthsIso(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4))
  const mo = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const total = y * 12 + (mo - 1) + n
  const ny = Math.floor(total / 12)
  const nmo = (total % 12) + 1
  return `${pad(ny, 4)}-${pad(nmo)}-${pad(Math.min(d, daysInCivilMonth(ny, nmo)))}`
}

/**
 * The 42 dates a month grid draws: six rows of seven, starting on the Monday
 * of the week containing the 1st.
 *
 * Always 42, never 35. A month that fits in five rows would otherwise make the
 * whole page change height as you page through the year, and the row that
 * appears and disappears is the one under the cursor.
 */
export function monthGridDays(iso: string): string[] {
  const first = startOfMonthIso(iso)
  const dow = dayOfWeek(first) // 0 = Sunday
  const start = addDaysIso(first, dow === 0 ? -6 : 1 - dow)
  return Array.from({ length: 42 }, (_, i) => addDaysIso(start, i))
}

/** 'September 2026'. Keeps MONTH_NAMES private, like the other formatters. */
export function formatMonthLabel(iso: string): string {
  const mo = Number(iso.slice(5, 7))
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return iso
  return `${MONTH_NAMES[mo - 1]} ${iso.slice(0, 4)}`
}

/** Is this date inside the month `iso` names? Used to dim the grid's edges. */
export function isSameMonth(iso: string, monthIso: string): boolean {
  return iso.slice(0, 7) === monthIso.slice(0, 7)
}
