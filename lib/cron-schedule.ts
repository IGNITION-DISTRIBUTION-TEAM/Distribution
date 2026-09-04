/**
 * Cron schedules for Snowflake tasks: parse, canonicalise, describe, preview.
 *
 * PURE FUNCTIONS, NO I/O, NO REACT. One `Intl` call, at the boundary
 * (`zonedNow`). Everything downstream is integer arithmetic on wall-clock
 * fields, which is both what cron semantics actually are and what makes the
 * whole engine testable from a pinned literal with no timezone dependency.
 *
 * Two things about this module are deliberately narrow, and both are load
 * bearing rather than fussiness:
 *
 * 1. THE GRAMMAR IS THE SECURITY BOUNDARY. These strings are interpolated into
 *    a CREATE TASK executed by a privileged Snowflake role. Every expression is
 *    validated and REJECTED if it does not fit — never escaped, never quoted —
 *    which is the same stance `ident()` takes in lib/sftp-sync-codegen.ts. The
 *    generator emits `formatCron()`'s output, not the caller's input, so what
 *    reaches Snowflake is a string this module built out of integers.
 *
 * 2. THE MINUTE FIELD IS A SINGLE NUMBER, BY TYPE. That one rule is the hourly
 *    floor: it rejects `*`, `*\/15`, `0,30` and `0-30/10` together, with one
 *    message. It also means a matching day has at most 24 candidate times,
 *    which is what lets `nextRuns` step days instead of minutes.
 *
 * WHAT IS NOT VERIFIED: Snowflake's exact `USING CRON` dialect. docs.snowflake
 * .com is unreachable from the environment this was written in, and nothing in
 * this repository pins it. The grammar below is therefore the intersection of
 * every cron implementation I know of — digits, `*`, `-`, `,`, `/` and nothing
 * else. If Snowflake rejects something this accepts, it says so at CREATE TASK
 * time, which is loud and safe. The dangerous direction is the opposite one —
 * an expression Snowflake reads differently from the preview — and that is what
 * DOM_DOW_COMBINATION below is about.
 */

export const SCHEDULE_TZ = "Africa/Johannesburg"

/**
 * The timezone allow-list. One entry, because the standards document fixes it.
 *
 * This is a security control, not tidiness: `scheduleTz` is interpolated into
 * the CREATE TASK immediately before the generated `AS`, so a value containing
 * a quote closes the literal and the rest of the task body becomes whatever the
 * caller wrote. It needs no semicolon to work. An exact allow-list is the fix.
 */
export const ALLOWED_SCHEDULE_TZS: readonly string[] = [SCHEDULE_TZ]

/**
 * How Snowflake combines day-of-month and day-of-week when BOTH are restricted.
 *
 * UNVERIFIED, and deliberately encoded as a constant rather than a guess in the
 * matching code. Unix cron ORs the two; Quartz forbids the combination
 * outright; I could not confirm which Snowflake does. While this reads
 * "unverified", `parseCron` REFUSES such an expression.
 *
 * Refusing rather than warning is the point. If we accepted `0 6 1 * 1`, the
 * preview would still have to render five timestamps, and to do that it would
 * have to pick AND or OR — so one of those two readings would be shown to the
 * operator as fact. A warning next to five confident-looking wrong timestamps
 * is the worst of both: people read the timestamps, not the amber box.
 *
 * To settle it, run scripts/task-automation/cron-probe.sql and change this to
 * "and" or "or"; `dayMatches` already reads it.
 */
const DOM_DOW_COMBINATION: "and" | "or" | "unverified" = "unverified"

/* --------------------------------------------------------------------- types */

/** Civil (wall-clock) time. Never an instant — there is no offset in here. */
export type WallClock = { y: number; mo: number; d: number; h: number; mi: number }

/** One `a`, `a-b` or `a-b/n` term. `*` is stored as the full domain. */
type CronTerm = { from: number; to: number; step: number }

/**
 * A parsed field. `terms` is kept for formatting so `6-18/2` survives a round
 * trip; `values` is the expanded set and is what matching and `isAny` use.
 * Keeping both is what lets `isAny` be semantic — `0-6` in day-of-week means
 * "every day" and must not count as a restriction.
 */
export type CronField = { terms: CronTerm[]; values: number[] }

/** A validated 5-field expression. Only ever produced by `parseCron`. */
export type Cron = {
  minute: number
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

/**
 * Builder state. Every variant leaves day-of-month or day-of-week unrestricted
 * — never both — so nothing the builder produces can hit the ambiguity above.
 */
export type ScheduleSpec =
  | { kind: "hourly"; minute: number; fromHour: number; toHour: number; everyHours: number; dows: number[] }
  | { kind: "daily"; minute: number; hour: number }
  | { kind: "weekly"; minute: number; hour: number; dows: number[] }
  | { kind: "monthly"; minute: number; hour: number; dayOfMonth: number }

export type ParseResult =
  | { ok: true; cron: Cron; canonical: string }
  | { ok: false; error: string }

const DOMAINS = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const

/** Sunday-first, because cron day-of-week is 0 = Sunday. */
export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
/** Monday-first display order, as every roster in this app shows it. */
export const DOW_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Longest expression we will look at. A list long enough to need more is wrong. */
const MAX_EXPRESSION_LENGTH = 120

/* ------------------------------------------------------------------ calendar */

/** Days in a civil month. Full leap rule: /4, not /100, unless /400. */
export function daysInMonth(y: number, mo: number): number {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(mo) ? 30 : 31
}

/**
 * Day of week for a civil date, 0 = Sunday. Sakamoto's method.
 *
 * Deliberately NOT `new Date(y, mo-1, d).getDay()`: that builds an instant in
 * the browser's timezone, which is exactly the conversion this module exists to
 * avoid, and it silently shifts for anyone west of Johannesburg.
 */
export function dowOf(y: number, mo: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const yy = mo < 3 ? y - 1 : y
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[mo - 1] + d) % 7
}

function nextCivilDay(y: number, mo: number, d: number): { y: number; mo: number; d: number } {
  if (d < daysInMonth(y, mo)) return { y, mo, d: d + 1 }
  if (mo < 12) return { y, mo: mo + 1, d: 1 }
  return { y: y + 1, mo: 1, d: 1 }
}

/** Order two wall-clock times. Negative, zero or positive, like a comparator. */
function cmp(a: WallClock, b: WallClock): number {
  return (
    a.y - b.y || a.mo - b.mo || a.d - b.d || a.h - b.h || a.mi - b.mi
  )
}

/* -------------------------------------------------------------------- parsing */

function parseField(raw: string, name: keyof typeof DOMAINS): CronField {
  const [min, max] = DOMAINS[name]
  const terms: CronTerm[] = []

  if (raw === "") throw new Error(`The ${name} field is empty.`)

  for (const part of raw.split(",")) {
    if (part === "") throw new Error(`The ${name} field has an empty item — check the commas.`)

    const slash = part.split("/")
    if (slash.length > 2) throw new Error(`The ${name} field has more than one "/" in "${part}".`)
    const [rangeText, stepText] = slash

    let step = 1
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText)) throw new Error(`The ${name} step in "${part}" must be a number.`)
      step = Number(stepText)
      if (step < 1) throw new Error(`The ${name} step in "${part}" must be 1 or more.`)
    }

    let from: number
    let to: number
    if (rangeText === "*") {
      from = min
      to = max
    } else if (rangeText.includes("-")) {
      const bits = rangeText.split("-")
      if (bits.length !== 2 || !/^\d{1,2}$/.test(bits[0]) || !/^\d{1,2}$/.test(bits[1])) {
        throw new Error(`The ${name} range "${rangeText}" must be two numbers, like 6-18.`)
      }
      from = Number(bits[0])
      to = Number(bits[1])
      if (from > to) {
        throw new Error(
          `The ${name} range "${rangeText}" runs backwards. A wrapping range is not supported — ` +
            `write it as two parts, for example 22-23,0-2.`
        )
      }
    } else {
      if (!/^\d{1,2}$/.test(rangeText)) throw new Error(`"${rangeText}" is not a number in the ${name} field.`)
      if (stepText !== undefined) {
        throw new Error(
          `"${part}" applies a step to a single ${name} value, which is ambiguous. ` +
            `Give the range it should step through, like ${rangeText}-${max}/${step}.`
        )
      }
      from = to = Number(rangeText)
    }

    if (from < min || to > max) {
      throw new Error(`The ${name} field must be between ${min} and ${max} — got "${part}".`)
    }
    terms.push({ from, to, step })
  }

  const values = new Set<number>()
  for (const t of terms) for (let v = t.from; v <= t.to; v += t.step) values.add(v)
  return { terms, values: [...values].sort((a, b) => a - b) }
}

/** Does this field cover its whole domain? Semantic, so `0-6` counts as `*`. */
function isAny(field: CronField, name: keyof typeof DOMAINS): boolean {
  const [min, max] = DOMAINS[name]
  return field.values.length === max - min + 1
}

function formatField(field: CronField, name: keyof typeof DOMAINS): string {
  if (isAny(field, name)) return "*"
  const seen = new Set<string>()
  const parts: string[] = []
  for (const t of [...field.terms].sort((a, b) => a.from - b.from || a.to - b.to || a.step - b.step)) {
    // Trim the range down to the last value the step actually reaches, so
    // `*/2` on hours prints as 0-22/2 rather than 0-23/2. Same set, no lie.
    const last = t.from + Math.floor((t.to - t.from) / t.step) * t.step
    const text = last === t.from ? `${t.from}` : t.step === 1 ? `${t.from}-${last}` : `${t.from}-${last}/${t.step}`
    if (seen.has(text)) continue
    seen.add(text)
    parts.push(text)
  }
  return parts.join(",")
}

/** The wire form. This — never the caller's input — is what reaches Snowflake. */
export function formatCron(cron: Cron): string {
  return [
    String(cron.minute),
    formatField(cron.hour, "hour"),
    formatField(cron.dom, "dom"),
    formatField(cron.month, "month"),
    formatField(cron.dow, "dow"),
  ].join(" ")
}

export function parseCron(expr: string): ParseResult {
  try {
    const text = String(expr ?? "").trim()
    if (text === "") throw new Error("Enter a schedule.")
    if (text.length > MAX_EXPRESSION_LENGTH) {
      throw new Error(`That expression is ${text.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}.`)
    }
    if (text.startsWith("@")) {
      throw new Error(`Shorthands like "${text}" are not supported. Write the five fields, e.g. 0 7 * * *.`)
    }
    if (/[^0-9*/,\s-]/.test(text)) {
      const bad = [...text].find((c) => /[^0-9*/,\s-]/.test(c))
      throw new Error(
        `"${bad}" is not allowed in a schedule. Use digits, * - , / only — ` +
          `names like MON or JAN, and ? L W #, are not accepted.`
      )
    }

    const fields = text.split(/\s+/)
    if (fields.length === 6) {
      throw new Error("That looks like a 6-field expression. Snowflake CRON has no seconds field — use 5.")
    }
    if (fields.length !== 5) {
      throw new Error(`A schedule has 5 fields (minute hour day-of-month month day-of-week); this has ${fields.length}.`)
    }

    const [minuteText, hourText, domText, monthText, dowText] = fields

    // The hourly floor, as one rule. See the module header.
    if (!/^\d{1,2}$/.test(minuteText)) {
      throw new Error(
        `The minute must be a single number, so "${minuteText}" is not allowed. The finest schedule ` +
          `this tool creates is once an hour — every run resumes a warehouse and opens an SSH ` +
          `session to the source. Use the hour field to run at several hours of the day.`
      )
    }
    const minute = Number(minuteText)
    if (minute > 59) throw new Error(`The minute must be between 0 and 59 — got ${minute}.`)

    if (/^\d{1,2}$/.test(dowText) && Number(dowText) === 7) {
      throw new Error("Day-of-week is 0-6 with 0 = Sunday. Use 0, not 7.")
    }

    const cron: Cron = {
      minute,
      hour: parseField(hourText, "hour"),
      dom: parseField(domText, "dom"),
      month: parseField(monthText, "month"),
      dow: parseField(dowText, "dow"),
    }

    if (!isAny(cron.dom, "dom") && !isAny(cron.dow, "dow") && DOM_DOW_COMBINATION === "unverified") {
      throw new Error(
        "This restricts both day-of-month and day-of-week. Cron implementations disagree about " +
          "whether that means both must match or either may, and we have not confirmed which " +
          "Snowflake does — so the preview could not honestly tell you when it would run. " +
          "Restrict one and leave the other as *, or create two syncs."
      )
    }

    // A date that can never occur, e.g. 30 February. Caught here so the preview
    // never has to render "nothing found" for something knowably impossible.
    if (!isAny(cron.dom, "dom")) {
      const smallestDom = cron.dom.values[0]
      const longestMonth = Math.max(...cron.month.values.map((m) => daysInMonth(2024, m)))
      if (smallestDom > longestMonth) {
        const months = cron.month.values.map((m) => MONTH_LABELS[m - 1]).join(", ")
        throw new Error(`There is no day ${smallestDom} in ${months}, so this would never run.`)
      }
    }

    return { ok: true, cron, canonical: formatCron(cron) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------- builder */

function requireInt(v: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${what} must be a whole number between ${min} and ${max} — got ${v}.`)
  }
  return v
}

function fieldFromTerm(from: number, to: number, step: number): CronField {
  const values: number[] = []
  for (let v = from; v <= to; v += step) values.push(v)
  return { terms: [{ from, to, step }], values }
}

function fieldFromValues(list: number[]): CronField {
  const values = [...new Set(list)].sort((a, b) => a - b)
  return { terms: values.map((v) => ({ from: v, to: v, step: 1 })), values }
}

const ANY = (name: keyof typeof DOMAINS): CronField => fieldFromTerm(DOMAINS[name][0], DOMAINS[name][1], 1)

export function specToCron(spec: ScheduleSpec): Cron {
  const minute = requireInt(spec.minute, 0, 59, "Minute")
  if (spec.kind === "hourly") {
    requireInt(spec.fromHour, 0, 23, "Start hour")
    requireInt(spec.toHour, 0, 23, "End hour")
    requireInt(spec.everyHours, 1, 23, "Hour step")
    if (spec.fromHour > spec.toHour) throw new Error("The start hour must not be after the end hour.")
    return {
      minute,
      hour: fieldFromTerm(spec.fromHour, spec.toHour, spec.everyHours),
      dom: ANY("dom"),
      month: ANY("month"),
      dow: spec.dows.length === 0 || spec.dows.length === 7 ? ANY("dow") : fieldFromValues(spec.dows.map((d) => requireInt(d, 0, 6, "Day"))),
    }
  }
  const hour = fieldFromTerm(requireInt(spec.hour, 0, 23, "Hour"), requireInt(spec.hour, 0, 23, "Hour"), 1)
  if (spec.kind === "daily") {
    return { minute, hour, dom: ANY("dom"), month: ANY("month"), dow: ANY("dow") }
  }
  if (spec.kind === "weekly") {
    if (spec.dows.length === 0) throw new Error("Pick at least one day of the week.")
    return {
      minute,
      hour,
      dom: ANY("dom"),
      month: ANY("month"),
      dow: spec.dows.length === 7 ? ANY("dow") : fieldFromValues(spec.dows.map((d) => requireInt(d, 0, 6, "Day"))),
    }
  }
  return {
    minute,
    hour,
    dom: fieldFromValues([requireInt(spec.dayOfMonth, 1, 31, "Day of the month")]),
    month: ANY("month"),
    dow: ANY("dow"),
  }
}

/** Convenience: the wire string for a builder spec. */
export function buildCron(spec: ScheduleSpec): string {
  return formatCron(specToCron(spec))
}

/**
 * The builder spec that would produce this cron, or null if the builder cannot
 * express it. Prefers the simplest reading — daily before weekly before
 * hourly — so `0 7 * * *` comes back as daily rather than as weekly-on-all-days.
 */
export function cronToSpec(cron: Cron): ScheduleSpec | null {
  const anyDom = isAny(cron.dom, "dom")
  const anyMonth = isAny(cron.month, "month")
  const anyDow = isAny(cron.dow, "dow")
  if (!anyMonth) return null

  const singleHour = cron.hour.values.length === 1
  const evenStep = cron.hour.terms.length === 1 ? cron.hour.terms[0] : null

  if (anyDom && singleHour && anyDow) {
    return { kind: "daily", minute: cron.minute, hour: cron.hour.values[0] }
  }
  if (anyDom && singleHour && !anyDow) {
    return { kind: "weekly", minute: cron.minute, hour: cron.hour.values[0], dows: cron.dow.values }
  }
  if (!anyDom && singleHour && anyDow && cron.dom.values.length === 1) {
    return { kind: "monthly", minute: cron.minute, hour: cron.hour.values[0], dayOfMonth: cron.dom.values[0] }
  }
  if (anyDom && evenStep) {
    return {
      kind: "hourly",
      minute: cron.minute,
      fromHour: evenStep.from,
      toHour: evenStep.to,
      everyHours: evenStep.step,
      dows: anyDow ? [] : cron.dow.values,
    }
  }
  return null
}

/* ------------------------------------------------------------------ describe */

function listHours(cron: Cron): string {
  const t = cron.hour.terms.length === 1 ? cron.hour.terms[0] : null
  const at = (h: number) => `${String(h).padStart(2, "0")}:${String(cron.minute).padStart(2, "0")}`
  if (isAny(cron.hour, "hour")) return `every hour at :${String(cron.minute).padStart(2, "0")}`
  if (cron.hour.values.length === 1) return `at ${at(cron.hour.values[0])}`
  if (t && t.step > 1) return `every ${t.step} hours from ${at(t.from)} to ${at(t.to)}`
  if (t && t.step === 1) return `hourly from ${at(t.from)} to ${at(t.to)}`
  return `at ${cron.hour.values.map(at).join(", ")}`
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

/** One plain-English line. Shown beside the expression, never instead of it. */
export function describeCron(cron: Cron): string {
  const when = listHours(cron)
  const parts: string[] = []

  if (!isAny(cron.dow, "dow")) {
    const days = cron.dow.values
    const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
    const weekend = days.length === 2 && days.includes(0) && days.includes(6)
    parts.push(weekdays ? "on weekdays" : weekend ? "at weekends" : `on ${days.map((d) => DOW_LABELS[d]).join(", ")}`)
  }
  if (!isAny(cron.dom, "dom")) {
    parts.push(`on the ${cron.dom.values.map(ordinal).join(", ")} of the month`)
  }
  if (!isAny(cron.month, "month")) {
    parts.push(`in ${cron.month.values.map((m) => MONTH_LABELS[m - 1]).join(", ")}`)
  }

  const scope = parts.length > 0 ? parts.join(" ") : "every day"
  const lead = when.startsWith("at ") || when.startsWith("every") || when.startsWith("hourly") ? when : when
  return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}, ${scope}.`
}

/* -------------------------------------------------------------------- preview */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/**
 * "Now", as wall-clock parts in a timezone. THE ONLY `Intl` CALL IN THIS MODULE.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: some ICU builds return hour
 * "24" for midnight under the latter, which would shift a preview generated
 * between 00:00 and 00:59 by a whole day. Parts are read by name from
 * `formatToParts`, not by splitting a formatted string.
 */
export function zonedNow(now: Date, tz: string = SCHEDULE_TZ): WallClock {
  let f = FORMATTERS.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    FORMATTERS.set(tz, f)
  }
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(now)) p[part.type] = part.value
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute }
}

function dayMatches(cron: Cron, y: number, mo: number, d: number): boolean {
  if (!cron.month.values.includes(mo)) return false
  const anyDom = isAny(cron.dom, "dom")
  const anyDow = isAny(cron.dow, "dow")
  if (anyDom && anyDow) return true
  if (anyDom) return cron.dow.values.includes(dowOf(y, mo, d))
  if (anyDow) return cron.dom.values.includes(d)
  // Only reachable once DOM_DOW_COMBINATION is verified; parseCron refuses
  // these while it reads "unverified".
  const dom = cron.dom.values.includes(d)
  const dow = cron.dow.values.includes(dowOf(y, mo, d))
  if (DOM_DOW_COMBINATION === "and") return dom && dow
  if (DOM_DOW_COMBINATION === "or") return dom || dow
  throw new Error(
    "This schedule restricts both day-of-month and day-of-week, which cannot be previewed until " +
      "Snowflake's behaviour is confirmed. It should have been refused at parse time."
  )
}

/**
 * The next `count` fire times strictly after `after`, as wall-clock.
 *
 * Steps DAYS, not minutes — a matching day has at most 24 candidate times
 * because the minute is a single number.
 *
 * The horizon is 21 years because that is what a 29-February schedule needs to
 * show five runs: leap years are four apart, so eight years finds two, not
 * five. Worst case is ~7,700 cheap day checks and only on a sparse expression;
 * every ordinary schedule exits within a handful. `exhausted` reports running
 * out, so the UI can say "no runs found" rather than render a short list as if
 * it were complete.
 *
 * Returns WallClock, not Date: a Date is an instant, and building the right
 * instant needs the offset this module deliberately never touches. Handing one
 * out would invite a caller to render it in the browser's timezone.
 */
export function nextRuns(
  cron: Cron,
  after: WallClock,
  count: number,
  opts: { maxDays?: number } = {}
): { runs: WallClock[]; exhausted: boolean } {
  const maxDays = opts.maxDays ?? 366 * 21
  const runs: WallClock[] = []
  let { y, mo, d } = after

  for (let i = 0; i < maxDays && runs.length < count; i++) {
    if (dayMatches(cron, y, mo, d)) {
      for (const h of cron.hour.values) {
        const w: WallClock = { y, mo, d, h, mi: cron.minute }
        if (cmp(w, after) > 0) {
          runs.push(w)
          if (runs.length === count) break
        }
      }
    }
    ;({ y, mo, d } = nextCivilDay(y, mo, d))
  }
  return { runs, exhausted: runs.length < count }
}

export function formatWallClock(w: WallClock): string {
  const dd = String(w.d).padStart(2, "0")
  const hh = String(w.h).padStart(2, "0")
  const mi = String(w.mi).padStart(2, "0")
  return `${DOW_LABELS[dowOf(w.y, w.mo, w.d)]} ${dd} ${MONTH_LABELS[w.mo - 1]} ${w.y}, ${hh}:${mi}`
}

/* ------------------------------------------------------------------ presets */

export const SCHEDULE_PRESETS: readonly { label: string; cron: string }[] = [
  { label: "Daily, 07:00", cron: "0 7 * * *" },
  { label: "Daily, 05:30", cron: "30 5 * * *" },
  { label: "Weekdays, 05:00", cron: "0 5 * * 1-5" },
  { label: "Hourly, 06:00-18:00", cron: "0 6-18 * * *" },
  { label: "Every 2 hours, 06:00-18:00", cron: "0 6-18/2 * * *" },
  { label: "Twice daily, 07:00 and 19:00", cron: "0 7,19 * * *" },
  { label: "Monthly, 1st at 03:00", cron: "0 3 1 * *" },
]

/* --------------------------------------------------------------- the chokepoint */

/**
 * Validate a schedule and hand back what should actually be emitted.
 *
 * THROWS on anything rejectable, so it can be called at the point of use in the
 * generator exactly like `ident()`. Returns the CANONICAL expression, not the
 * input — checking alone would let `"0   7 * * *"` through and then interpolate
 * the double spaces into the DDL.
 */
export function checkSchedule(cron: string, tz: string): { canonical: string; warnings: string[] } {
  if (!ALLOWED_SCHEDULE_TZS.includes(tz)) {
    throw new Error(
      `Schedule timezone must be exactly ${ALLOWED_SCHEDULE_TZS.join(" or ")} — received ${JSON.stringify(tz)}. ` +
        `It is fixed by the standards document, and an exact allow-list is the control: this value is ` +
        `interpolated into a CREATE TASK run by a privileged role.`
    )
  }

  const parsed = parseCron(cron)
  if (!parsed.ok) throw new Error(`Schedule: ${parsed.error}`)

  const warnings: string[] = []
  const c = parsed.cron

  if (
    isAny(c.hour, "hour") &&
    isAny(c.dom, "dom") &&
    isAny(c.month, "month") &&
    isAny(c.dow, "dow")
  ) {
    warnings.push(
      "This runs every hour of every day — about 730 runs a month. Each one resumes the warehouse " +
        "and opens an SSH session to the source. Worth checking the file actually lands that often."
    )
  }

  const shortMonths = c.dom.values.filter((d) => d >= 29)
  if (!isAny(c.dom, "dom") && shortMonths.length > 0) {
    warnings.push(
      `Day ${shortMonths.join(", ")} of the month: this simply does not run in months that are ` +
        `shorter than that, so February is skipped every year.`
    )
  }

  return { canonical: parsed.canonical, warnings }
}
