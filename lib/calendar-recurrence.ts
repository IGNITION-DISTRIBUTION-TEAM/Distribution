/**
 * Recurring calendar tasks: the rule, and where it lands next.
 *
 * ONE ROW PER SERIES, NOT ONE ROW PER OCCURRENCE. A recurring task is a single
 * TSK_CALENDAR_ITEMS row whose DUE_DATE is always its NEXT occurrence; when
 * that date passes, or somebody ticks it off, the row rolls forward. The
 * alternative — materialising the next N occurrences as real rows — needs a
 * generator that can double-generate (there are no transactions here, which is
 * the same reason the recipient override is a JSON column and not a join
 * table), and it turns "edit the rule" into "reconcile every unstarted child
 * row". A rolling row cannot drift out of sync with its own rule, because the
 * rule is the only thing that decides where it goes.
 *
 * WHAT THAT COSTS, stated plainly: there is no per-occurrence history. Ticking
 * off this week's standup does not leave a record that this week's standup
 * happened — it moves the task to next week. If completion history is ever
 * wanted, that is a second table and a real feature, not a tweak to this one.
 *
 * The reminder marker needs no change to work with this. REMINDER_SENT_FOR
 * already holds the DUE_DATE a reminder was sent for rather than a flag, so the
 * moment a series rolls forward its reminder re-arms by itself.
 *
 * PURE FUNCTIONS, NO I/O. Everything is string and integer arithmetic on wall
 * dates, so the whole engine is testable from literals — see
 * scripts/calendar/calendar-tests.ts.
 */
import { daysInMonth } from "@/lib/cron-schedule"
import { addDaysIso, dayOfWeek, daysBetween, isValidIsoDate } from "@/lib/calendar-dates"

export const RECUR_KINDS = ["none", "daily", "weekly", "monthly"] as const
export type RecurKind = (typeof RECUR_KINDS)[number]

export type Recurrence = {
  kind: RecurKind
  /** Every N days / weeks / months. 1..99. */
  interval: number
  /** Weekly only: 0 = Sunday … 6 = Saturday. Empty means "the start date's day". */
  weekdays: number[]
  /**
   * Monthly only: the day of the month the series is anchored to, 1..31.
   *
   * The ANCHOR, not the last date used. A series on the 31st must fall on the
   * 28th in February and then go back to the 31st in March — computing each
   * occurrence from the anchor is what makes that happen; computing it from the
   * previous occurrence would leave the series stuck on the 28th forever.
   */
  dayOfMonth: number | null
  /** Inclusive last date, or null for "until somebody stops it". */
  until: string | null
}

export const NO_RECURRENCE: Recurrence = {
  kind: "none",
  interval: 1,
  weekdays: [],
  dayOfMonth: null,
  until: null,
}

export function isRecurring(rule: Recurrence): boolean {
  return rule.kind !== "none"
}

/* ---------------------------------------------------------------- parsing */

const MAX_INTERVAL = 99

function clampInterval(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, MAX_INTERVAL)
}

function parseWeekdays(value: unknown): number[] {
  const raw: unknown[] =
    typeof value === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
      : Array.isArray(value)
        ? value
        : []
  const seen = new Set<number>()
  for (const v of raw) {
    const n = Math.trunc(Number(v))
    if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * Coerce anything — a request body, a Snowflake row — into a usable rule.
 *
 * Never throws and never rejects: an unreadable rule becomes "does not
 * repeat", which is the safe direction. A row written before these columns
 * existed reads as NULL and lands here too.
 */
export function normalizeRecurrence(raw: unknown, startDate?: string): Recurrence {
  const src = (raw ?? {}) as Record<string, unknown>
  const kindRaw = String(src.kind ?? "none").toLowerCase()
  const kind = (RECUR_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as RecurKind)
    : "none"
  if (kind === "none") return NO_RECURRENCE

  const until = isValidIsoDate(src.until) ? src.until : null
  const interval = clampInterval(src.interval)

  if (kind === "weekly") {
    let weekdays = parseWeekdays(src.weekdays)
    // No day chosen means "the same weekday the task starts on" — the reading
    // somebody gets when they pick Weekly and touch nothing else.
    if (weekdays.length === 0 && startDate && isValidIsoDate(startDate)) {
      weekdays = [dayOfWeek(startDate)]
    }
    return { kind, interval, weekdays, dayOfMonth: null, until }
  }

  if (kind === "monthly") {
    const d = Math.trunc(Number(src.dayOfMonth))
    const anchor =
      Number.isInteger(d) && d >= 1 && d <= 31
        ? d
        : startDate && isValidIsoDate(startDate)
          ? Number(startDate.slice(8, 10))
          : 1
    return { kind, interval, weekdays: [], dayOfMonth: anchor, until }
  }

  return { kind: "daily", interval, weekdays: [], dayOfMonth: null, until }
}

/* -------------------------------------------------------------- the maths */

const iso = (y: number, mo: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`

/**
 * The monthly anchor day, with ONE fallback.
 *
 * `normalizeRecurrence` always sets `dayOfMonth` for a monthly rule, so this
 * only fires on a malformed rule — but it used to fire three different ways in
 * this file (the previous occurrence's day here, a bare `1` in the describer),
 * and `occursOn` would have been a fourth. Two readers disagreeing about the
 * fallback would put a series on the grid on days it never fires, so they now
 * share this.
 */
export function monthAnchorDay(rule: Recurrence, fallbackIso: string): number {
  if (rule.dayOfMonth != null) return rule.dayOfMonth
  const d = Number(fallbackIso.slice(8, 10))
  return Number.isInteger(d) && d >= 1 && d <= 31 ? d : 1
}

/** The Monday of the week containing `date`. Weeks start Monday here. */
export function mondayOf(date: string): string {
  const dow = dayOfWeek(date) // 0 = Sunday
  return addDaysIso(date, dow === 0 ? -6 : 1 - dow)
}

/** Runaway guard. A monthly series stepping by 1 needs 12 steps a year. */
const MAX_STEPS = 500

/**
 * Day-at-a-time scans are bounded by the widest gap a rule can leave: 99
 * months, the interval cap. Generous, and still finite.
 */
const MAX_SCAN_DAYS = 3200

/**
 * Modulo that is never negative.
 *
 * JavaScript's `%` keeps the sign of the dividend, so `-3 % 7` is `-3`, not
 * `4`. Every predicate below compares a date against an anchor it may fall
 * BEFORE — which is the whole point of a grid you can page backwards — so a
 * bare `%` would silently mis-answer every past cell.
 */
const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * The first occurrence strictly after `after`, and no earlier than `notBefore`.
 *
 * `notBefore` is what makes catching up safe. When the cron rolls a series that
 * has been overdue for three weeks it asks for the next occurrence that is also
 * today or later, so the row lands on the real next one — not three weeks ago,
 * and not three separate advances. That also makes the advance idempotent: once
 * DUE_DATE is today or later, the query that selects overdue series no longer
 * matches it, so running the cron twice cannot double-step.
 *
 * Returns null when the rule does not repeat, or when the series has run past
 * its `until` date.
 */
export function nextOccurrence(
  rule: Recurrence,
  after: string,
  notBefore?: string
): string | null {
  if (rule.kind === "none" || !isValidIsoDate(after)) return null
  const floor = notBefore && isValidIsoDate(notBefore) ? notBefore : after

  let candidate: string | null = null

  if (rule.kind === "daily") {
    let d = after
    for (let i = 0; i < MAX_STEPS; i++) {
      d = addDaysIso(d, rule.interval)
      if (d > after && d >= floor) {
        candidate = d
        break
      }
    }
  } else if (rule.kind === "weekly") {
    const days = rule.weekdays.length > 0 ? rule.weekdays : [dayOfWeek(after)]
    // Anchored to the week, not to the date: "every 2 weeks on Mon and Wed"
    // means both days of the same week, then skip a week — not two separate
    // fortnightly cycles that drift apart.
    let weekStart = mondayOf(after)
    for (let i = 0; i < MAX_STEPS && candidate === null; i++) {
      for (let offset = 0; offset < 7; offset++) {
        const day = addDaysIso(weekStart, offset)
        if (!days.includes(dayOfWeek(day))) continue
        if (day > after && day >= floor) {
          candidate = day
          break
        }
      }
      weekStart = addDaysIso(weekStart, 7 * rule.interval)
    }
  } else {
    const anchorDay = monthAnchorDay(rule, after)
    let y = Number(after.slice(0, 4))
    let mo = Number(after.slice(5, 7))
    for (let i = 0; i < MAX_STEPS; i++) {
      // Clamp per month, from the anchor — February gets the 28th, March gets
      // the 31st back again.
      const day = Math.min(anchorDay, daysInMonth(y, mo))
      const cand = iso(y, mo, day)
      if (cand > after && cand >= floor) {
        candidate = cand
        break
      }
      mo += rule.interval
      while (mo > 12) {
        mo -= 12
        y += 1
      }
    }
  }

  if (candidate === null) return null
  if (rule.until && candidate > rule.until) return null
  return candidate
}

/* ------------------------------------------- expanding a series to a window */

/**
 * Is `iso` an occurrence of this rule, anchored at `anchor`?
 *
 * THE COUNTERPART TO `nextOccurrence`, AND THE REASON THE GRID WORKS.
 * `nextOccurrence` walks forward from the previous occurrence, which is all a
 * rolling row ever needs. A month grid asks the opposite question — "is the
 * 14th one of these?" — of 42 arbitrary dates, most of which the row has
 * already passed or not yet reached.
 *
 * The two are two implementations of one rule, so they must agree. They do
 * because every step `nextOccurrence` takes is a whole multiple of the rule's
 * period, which is exactly the congruence tested here; see the invariant test
 * in scripts/calendar/calendar-tests.ts, which is what stops them drifting
 * apart in some later edit.
 *
 * `anchor` is the series' START, not its current due date. Anchoring on a date
 * that rolls would still be arithmetically congruent, but it would also draw a
 * weekly standup on every Monday back to 1970.
 */
export function occursOn(rule: Recurrence, anchor: string, iso: string): boolean {
  if (rule.kind === "none") return false
  if (!isValidIsoDate(anchor) || !isValidIsoDate(iso)) return false
  // A series does not exist before it started, and stops after its end date.
  if (iso < anchor) return false
  if (rule.until && iso > rule.until) return false

  const n = rule.interval
  if (rule.kind === "daily") {
    return mod(daysBetween(anchor, iso), n) === 0
  }

  if (rule.kind === "weekly") {
    const days = rule.weekdays.length > 0 ? rule.weekdays : [dayOfWeek(anchor)]
    if (!days.includes(dayOfWeek(iso))) return false
    // Whole weeks between the two Mondays. Both are Mondays, so this divides
    // exactly — matching nextOccurrence, which steps weekStart by 7 * interval.
    const weeks = daysBetween(mondayOf(anchor), mondayOf(iso)) / 7
    return mod(weeks, n) === 0
  }

  const y = Number(iso.slice(0, 4))
  const mo = Number(iso.slice(5, 7))
  const anchorDay = monthAnchorDay(rule, anchor)
  // The same clamp nextOccurrence applies, so 28 February IS an occurrence of
  // a series anchored on the 31st — and March goes back to the 31st.
  if (Number(iso.slice(8, 10)) !== Math.min(anchorDay, daysInMonth(y, mo))) return false
  const months = (y - Number(anchor.slice(0, 4))) * 12 + (mo - Number(anchor.slice(5, 7)))
  return mod(months, n) === 0
}

/**
 * The first occurrence on or after `from`.
 *
 * This is what keeps DUE_DATE honest when the RULE changes but the date does
 * not. Switch a series from Mondays to Tuesdays and its stored date is
 * suddenly not a date the rule produces — the grid would then draw the series
 * everywhere except on its own due date. The PATCH handler re-seats DUE_DATE
 * through here so that cannot happen.
 */
export function firstOccurrenceFrom(
  rule: Recurrence,
  anchor: string,
  from: string
): string | null {
  if (rule.kind === "none" || !isValidIsoDate(anchor) || !isValidIsoDate(from)) return null
  let cursor = from < anchor ? anchor : from
  // Bounded: the widest gap any supported rule can leave is 99 months, and the
  // day-by-day walk only has to cross one period.
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (rule.until && cursor > rule.until) return null
    if (occursOn(rule, anchor, cursor)) return cursor
    cursor = addDaysIso(cursor, 1)
  }
  return null
}

/**
 * Every occurrence of this rule between `from` and `to`, inclusive.
 *
 * Scans the window a day at a time rather than stepping the rule. The grid's
 * window is 42 days, so the cost is nothing, and stepping backwards through a
 * monthly clamp — where February's 28th has to know it stands in for the 31st
 * — is exactly the kind of arithmetic that goes wrong quietly. A predicate
 * asked once per visible day cannot.
 */
export function occurrencesInRange(
  rule: Recurrence,
  anchor: string,
  from: string,
  to: string
): string[] {
  if (rule.kind === "none" || !isValidIsoDate(from) || !isValidIsoDate(to)) return []
  const out: string[] = []
  let cursor = from
  for (let i = 0; i < MAX_SCAN_DAYS && cursor <= to; i++) {
    if (occursOn(rule, anchor, cursor)) out.push(cursor)
    cursor = addDaysIso(cursor, 1)
  }
  return out
}

/** The next `count` occurrences after `after` — the form's "next few dates" preview. */
export function upcomingOccurrences(rule: Recurrence, after: string, count: number): string[] {
  const out: string[] = []
  let cursor = after
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(rule, cursor)
    if (!next) break
    out.push(next)
    cursor = next
  }
  return out
}

/* ------------------------------------------------------------- describing */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
/** Monday first, so "Mon and Wed" does not read as "Wed and Mon". */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

function joinWords(words: string[]): string {
  if (words.length === 0) return ""
  if (words.length === 1) return words[0]
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

function ordinal(n: number): string {
  // 11th, 12th, 13th are the exceptions the last-digit rule gets wrong.
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/** A plain-English rule, for the form, the list and the email. */
export function describeRecurrence(rule: Recurrence): string {
  if (rule.kind === "none") return "Does not repeat"

  let base: string
  if (rule.kind === "daily") {
    base = rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`
  } else if (rule.kind === "weekly") {
    const names = WEEK_ORDER.filter((d) => rule.weekdays.includes(d)).map((d) => DAY_NAMES[d])
    const on = names.length > 0 ? ` on ${joinWords(names)}` : ""
    base = rule.interval === 1 ? `Every week${on}` : `Every ${rule.interval} weeks${on}`
  } else {
    const day = monthAnchorDay(rule, "")
    const on = ` on the ${ordinal(day)}`
    base = rule.interval === 1 ? `Every month${on}` : `Every ${rule.interval} months${on}`
    // Say what happens in February rather than letting somebody find out.
    if (day > 28) base += " (or the last day, in shorter months)"
  }

  return rule.until ? `${base}, until ${rule.until}` : base
}
