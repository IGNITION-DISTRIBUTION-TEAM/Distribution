/**
 * Turn calendar tasks into an iCalendar (.ics) file.
 *
 * PURE, NO I/O — so the whole format is testable from literals, which matters
 * because the consumer is Outlook and the failure mode is a file it refuses to
 * open with no useful reason given.
 *
 * WHAT THIS IS NOT: a subscription. The file is a snapshot of the tasks at the
 * moment it was downloaded. Importing it copies them into Outlook once; later
 * edits in the portal will not appear there, and nothing here pretends
 * otherwise. A live feed would need a URL Outlook can poll without a session —
 * a bearer token in a query string, readable by anyone who gets the link — and
 * that is deliberately out of scope for this app.
 *
 * Three details are load bearing:
 *
 *  1. A recurring series' DTSTART is its SERIES_START, not its DUE_DATE. The
 *     stored due date is only where the series has rolled to; anchoring RRULE
 *     there would import a series that begins late and drops its own history.
 *  2. Africa/Johannesburg is a fixed +02:00 with no DST, so the VTIMEZONE
 *     below is six lines and exactly correct. This is the one place in the
 *     codebase where the no-DST fact pays off directly rather than just
 *     simplifying an argument.
 *  3. RFC 5545 wants CRLF, and lines folded at 75 octets — octets, not
 *     characters, so folding counts UTF-8 bytes.
 */
import type { CalendarTask } from "@/lib/calendar-store"
import { monthAnchorDay } from "@/lib/calendar-recurrence"

export const ICS_TZID = "Africa/Johannesburg"

/** Fixed +02:00, no DST — hence no DAYLIGHT component and no rules. */
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${ICS_TZID}`,
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0200",
  "TZNAME:SAST",
  "END:STANDARD",
  "END:VTIMEZONE",
]

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newlines are special. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
}

/**
 * Fold one content line to 75 octets, continuations prefixed with a space.
 *
 * Counts BYTES, not characters: a task titled with an emoji or an accented
 * name would otherwise produce a line Outlook reads as over-long, and folding
 * mid-codepoint would corrupt it. So the split point walks whole characters
 * and measures their encoded length.
 */
export function foldLine(line: string): string[] {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return [line]

  const out: string[] = []
  let current = ""
  let bytes = 0
  // 75 for the first line; continuations lose one octet to the leading space.
  let limit = 75
  for (const ch of line) {
    const size = enc.encode(ch).length
    if (bytes + size > limit) {
      out.push(current)
      current = ""
      bytes = 0
      limit = 74
    }
    current += ch
    bytes += size
  }
  if (current) out.push(current)
  return out.map((part, i) => (i === 0 ? part : ` ${part}`))
}

const compactDate = (iso: string) => iso.replace(/-/g, "")
const compactTime = (time: string) => `${time.replace(":", "")}00`

/** ICS weekday codes, indexed 0 = Sunday to match `dayOfWeek`. */
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

/**
 * The RRULE for a task's recurrence, or null when it does not repeat.
 *
 * UNTIL is emitted as a DATE, matching an all-day DTSTART. For a timed event
 * RFC 5545 wants UNTIL in UTC; the rule's `until` is a wall date with no time,
 * so it is emitted as a date there too — every client we care about accepts it,
 * and inventing a time to make it a UTC instant would move the boundary.
 */
export function rruleFor(task: CalendarTask): string | null {
  const rule = task.recurrence
  if (rule.kind === "none") return null

  const parts: string[] = []
  if (rule.kind === "daily") parts.push("FREQ=DAILY")
  else if (rule.kind === "weekly") {
    parts.push("FREQ=WEEKLY")
    const days = rule.weekdays.length > 0 ? rule.weekdays : []
    if (days.length > 0) {
      // Monday first, so the property reads the way the UI shows it.
      const order = [1, 2, 3, 4, 5, 6, 0]
      parts.push(`BYDAY=${order.filter((d) => days.includes(d)).map((d) => BYDAY[d]).join(",")}`)
    }
  } else {
    parts.push("FREQ=MONTHLY")
    parts.push(`BYMONTHDAY=${monthAnchorDay(rule, task.seriesStart)}`)
  }
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.until) parts.push(`UNTIL=${compactDate(rule.until)}`)
  return parts.join(";")
}

/**
 * One VEVENT per task — per SERIES, for a recurring one.
 *
 * A cancelled task is still emitted, with STATUS:CANCELLED, so importing twice
 * does not resurrect something that was called off.
 */
function vevent(task: CalendarTask, stamp: string, domain: string): string[] {
  const rrule = rruleFor(task)
  // The series' origin for a repeating event; its own date otherwise.
  const start = rrule ? task.seriesStart || task.dueDate : task.dueDate

  const lines = [
    "BEGIN:VEVENT",
    `UID:calendar-${task.id}@${domain}`,
    `DTSTAMP:${stamp}`,
  ]

  if (task.dueTime) {
    lines.push(`DTSTART;TZID=${ICS_TZID}:${compactDate(start)}T${compactTime(task.dueTime)}`)
    // A task is a moment, not a span. A 30-minute default is a guess, so the
    // event is zero-length and clients show it as a point in the day.
    lines.push(`DTEND;TZID=${ICS_TZID}:${compactDate(start)}T${compactTime(task.dueTime)}`)
  } else {
    // All-day. DTEND is exclusive in ICS, so it is the following day.
    lines.push(`DTSTART;VALUE=DATE:${compactDate(start)}`)
    lines.push(`DTEND;VALUE=DATE:${compactDate(addOneDay(start))}`)
  }

  if (rrule) lines.push(`RRULE:${rrule}`)
  lines.push(`SUMMARY:${escapeText(task.title)}`)

  const description: string[] = []
  if (task.description) description.push(task.description)
  if (task.assignee) description.push(`Assigned to: ${task.assignee}`)
  if (task.createdBy) description.push(`Added by: ${task.createdBy}`)
  description.push("Snapshot from the Ignition Distribution portal — this copy does not update.")
  lines.push(`DESCRIPTION:${escapeText(description.join("\n"))}`)

  if (task.status === "cancelled") lines.push("STATUS:CANCELLED")
  else if (task.status === "done") lines.push("STATUS:CONFIRMED")

  lines.push("END:VEVENT")
  return lines
}

/** Day arithmetic on the compact string, via UTC so no local offset leaks in. */
function addOneDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The whole file. `now` is injectable so a test can pin DTSTAMP.
 */
export function buildIcs(
  tasks: CalendarTask[],
  options: { name: string; now?: Date; domain?: string } = { name: "Calendar" }
): string {
  const stamp = `${(options.now ?? new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
  const domain = options.domain ?? "ignitiongroup.co.za"

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ignition Group//Distribution Portal Calendar//EN",
    "CALSCALE:GREGORIAN",
    // A snapshot, so PUBLISH rather than REQUEST — nobody is being invited.
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.name)}`,
    `X-WR-TIMEZONE:${ICS_TZID}`,
    ...VTIMEZONE,
    ...tasks.flatMap((task) => vevent(task, stamp, domain)),
    "END:VCALENDAR",
  ]

  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`
}
