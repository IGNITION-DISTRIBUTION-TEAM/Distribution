/**
 * Checks for lib/cron-schedule.ts. No Snowflake, no network, no clock.
 *
 *   npx tsx scripts/task-automation/cron-schedule-tests.ts
 *
 * Every time-dependent case pins `now` as a literal WallClock, so these are
 * deterministic wherever they run — which is the whole reason the module keeps
 * its single Intl call at the boundary.
 */
import {
  SCHEDULE_TZ,
  SCHEDULE_PRESETS,
  buildCron,
  checkSchedule,
  cronToSpec,
  daysInMonth,
  describeCron,
  dowOf,
  formatCron,
  formatWallClock,
  nextRuns,
  parseCron,
  specToCron,
  zonedNow,
  type ScheduleSpec,
  type WallClock,
} from "../../lib/cron-schedule"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const canonical = (expr: string) => {
  const r = parseCron(expr)
  return r.ok ? r.canonical : `ERROR: ${r.error}`
}

/* ---- 1. Grammar: accepted, and canonicalised to exactly this ------------- */

console.log("Canonicalisation")
for (const [input, want] of [
  ["0 7 * * *", "0 7 * * *"],
  ["00 07 * * *", "0 7 * * *"],
  ["0  7   *  *  *", "0 7 * * *"],
  ["  0 7 * * *  ", "0 7 * * *"],
  ["0 6-18 * * *", "0 6-18 * * *"],
  ["0 6-18/2 * * *", "0 6-18/2 * * *"],
  ["0 */2 * * *", "0 0-22/2 * * *"],
  ["0 7 * * 0-6", "0 7 * * *"],
  ["0 7 * * */1", "0 7 * * *"],
  ["0 7-7 * * *", "0 7 * * *"],
  ["0 6-18/1 * * *", "0 6-18 * * *"],
  ["0 9,6,6 * * *", "0 6,9 * * *"],
  ["0 5 * * 1-5", "0 5 * * 1-5"],
  ["30 6,14 1 * *", "30 6,14 1 * *"],
  ["0 7,19 * * *", "0 7,19 * * *"],
] as const) {
  check(`${JSON.stringify(input)} -> ${want}`, canonical(input) === want, `got ${canonical(input)}`)
}

/* ---- 2. Grammar: rejected ------------------------------------------------ */

console.log("Rejection")
for (const [expr, because] of [
  ["*/15 * * * *", "minute"],
  ["* * * * *", "minute"],
  ["0,30 * * * *", "minute"],
  ["0-30/10 * * * *", "minute"],
  ["0 7 * * MON", "not allowed"],
  ["0 7 * JAN *", "not allowed"],
  ["0 7 ? * *", "not allowed"],
  ["0 7 L * *", "not allowed"],
  ["0 7 * * 5#2", "not allowed"],
  ["@daily", "Shorthand"],
  ["0 0 * * * *", "seconds"],
  ["0 0 * *", "5 fields"],
  ["", "Enter a schedule"],
  ["0 7 * * 7", "0 = Sunday"],
  ["0 24 * * *", "between 0 and 23"],
  ["0 7 32 * *", "between 1 and 31"],
  ["0 7 * 13 *", "between 1 and 12"],
  ["60 7 * * *", "between 0 and 59"],
  ["0 22-2 * * *", "backwards"],
  ["0 6-18/0 * * *", "1 or more"],
  ["0 5/2 * * *", "ambiguous"],
  ["0 6 1 * 1", "both day-of-month and day-of-week"],
  ["0 0 30 2 *", "never run"],
  ["0 0 31 4 *", "never run"],
  ["0 7 * * *; DROP TABLE X", "not allowed"],
  ["0 7 * * * Africa/Johannesburg' AS CALL EVIL() --", "not allowed"],
  [`0 7 * * ${"1,".repeat(80)}1`, "characters"],
] as const) {
  const r = parseCron(expr)
  check(
    `refuses ${JSON.stringify(expr.slice(0, 44))}`,
    !r.ok && r.error.includes(because),
    r.ok ? `accepted as ${r.canonical}` : `message was: ${r.error}`
  )
}

/* ---- 3. Round trip ------------------------------------------------------- */

console.log("Round trip")
{
  const specs: ScheduleSpec[] = []
  for (const minute of [0, 7, 30, 59]) {
    for (const hour of [0, 7, 23]) {
      specs.push({ kind: "daily", minute, hour })
      for (const dows of [[1], [0, 6], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]]) {
        specs.push({ kind: "weekly", minute, hour, dows })
      }
      for (const dayOfMonth of [1, 15, 28, 31]) {
        specs.push({ kind: "monthly", minute, hour, dayOfMonth })
      }
    }
    for (const everyHours of [1, 2, 6]) {
      for (const dows of [[], [1, 2, 3, 4, 5]]) {
        specs.push({ kind: "hourly", minute, fromHour: 6, toHour: 18, everyHours, dows })
      }
    }
  }

  let parseFails = 0
  let idempotenceFails = 0
  let specFails = 0
  let bothRestricted = 0
  for (const spec of specs) {
    const wire = buildCron(spec)
    const r = parseCron(wire)
    if (!r.ok) {
      parseFails++
      continue
    }
    // The law that matters: canonicalising a builder expression through the
    // spec round trip must land on the same string. NOT deep-equality of the
    // spec — canonicalisation legitimately turns all-seven-days into daily.
    const back = cronToSpec(r.cron)
    if (!back) {
      specFails++
      continue
    }
    if (formatCron(specToCron(back)) !== r.canonical) idempotenceFails++
    const domAny = r.canonical.split(" ")[2] === "*"
    const dowAny = r.canonical.split(" ")[4] === "*"
    if (!domAny && !dowAny) bothRestricted++
  }
  check(`all ${specs.length} builder specs parse`, parseFails === 0, `${parseFails} failed`)
  check("every builder expression is representable as a spec", specFails === 0, `${specFails} were not`)
  check("spec round trip is idempotent", idempotenceFails === 0, `${idempotenceFails} drifted`)
  check("no builder expression restricts both DOM and DOW", bothRestricted === 0, `${bothRestricted} did`)
}

console.log("Presets")
for (const p of SCHEDULE_PRESETS) {
  const r = parseCron(p.cron)
  check(`${p.label} (${p.cron})`, r.ok && r.canonical === p.cron, r.ok ? `canonical ${r.canonical}` : r.error)
}

/* ---- 4. nextRuns, with a pinned now -------------------------------------- */

console.log("Next runs")
{
  // 4 September 2026 is a Friday.
  const now: WallClock = { y: 2026, mo: 9, d: 4, h: 7, mi: 0 }
  const runs = (expr: string, count = 5, maxDays?: number) => {
    const r = parseCron(expr)
    if (!r.ok) return { text: [`ERROR: ${r.error}`], exhausted: true }
    const out = nextRuns(r.cron, now, count, maxDays ? { maxDays } : {})
    return { text: out.runs.map(formatWallClock), exhausted: out.exhausted }
  }

  check(
    "strictly after: 07:00 today is not a next run",
    runs("0 7 * * *", 1).text[0] === "Sat 05 Sep 2026, 07:00",
    runs("0 7 * * *", 1).text[0]
  )
  check(
    "same day, later hour is",
    runs("0 8 * * *", 1).text[0] === "Fri 04 Sep 2026, 08:00",
    runs("0 8 * * *", 1).text[0]
  )
  check(
    "weekdays skips the weekend",
    runs("0 5 * * 1-5").text.join(" | ") ===
      ["Mon 07 Sep 2026, 05:00", "Tue 08 Sep 2026, 05:00", "Wed 09 Sep 2026, 05:00", "Thu 10 Sep 2026, 05:00", "Fri 11 Sep 2026, 05:00"].join(" | "),
    runs("0 5 * * 1-5").text.join(" | ")
  )
  check(
    "step anchors at the range start, not at 0",
    runs("0 6-18/2 * * *").text.join(" | ") ===
      ["Fri 04 Sep 2026, 08:00", "Fri 04 Sep 2026, 10:00", "Fri 04 Sep 2026, 12:00", "Fri 04 Sep 2026, 14:00", "Fri 04 Sep 2026, 16:00"].join(" | "),
    runs("0 6-18/2 * * *").text.join(" | ")
  )
  check(
    "month and year rollover",
    runs("0 0 1 * *").text.join(" | ") ===
      ["Thu 01 Oct 2026, 00:00", "Sun 01 Nov 2026, 00:00", "Tue 01 Dec 2026, 00:00", "Fri 01 Jan 2027, 00:00", "Mon 01 Feb 2027, 00:00"].join(" | "),
    runs("0 0 1 * *").text.join(" | ")
  )
  check(
    "day 31 skips short months",
    runs("0 0 31 * *").text.join(" | ") ===
      ["Sat 31 Oct 2026, 00:00", "Thu 31 Dec 2026, 00:00", "Sun 31 Jan 2027, 00:00", "Wed 31 Mar 2027, 00:00", "Mon 31 May 2027, 00:00"].join(" | "),
    runs("0 0 31 * *").text.join(" | ")
  )
  check(
    "29 February finds five leap years inside the horizon",
    runs("0 0 29 2 *").text.join(" | ") ===
      ["Tue 29 Feb 2028, 00:00", "Sun 29 Feb 2032, 00:00", "Fri 29 Feb 2036, 00:00", "Wed 29 Feb 2040, 00:00", "Mon 29 Feb 2044, 00:00"].join(" | "),
    runs("0 0 29 2 *").text.join(" | ")
  )
  check("...and does not report itself exhausted", runs("0 0 29 2 *").exhausted === false)
  {
    const short = runs("0 0 29 2 *", 5, 365)
    check("a short horizon reports exhausted rather than hanging", short.text.length === 0 && short.exhausted)
  }
  {
    const r = parseCron("0 0 * * *")
    const out = r.ok ? nextRuns(r.cron, { y: 2026, mo: 12, d: 31, h: 23, mi: 30 }, 1) : null
    check(
      "year boundary",
      out !== null && formatWallClock(out.runs[0]) === "Fri 01 Jan 2027, 00:00",
      out ? formatWallClock(out.runs[0]) : "parse failed"
    )
  }
  {
    // Europe switches off DST on this date; SAST does not move. Guards against
    // anyone "fixing" this module with Date-based arithmetic later.
    const r = parseCron("0 2 * * *")
    const out = r.ok ? nextRuns(r.cron, { y: 2026, mo: 10, d: 25, h: 1, mi: 30 }, 1) : null
    check(
      "no DST wobble in SAST",
      out !== null && formatWallClock(out.runs[0]) === "Sun 25 Oct 2026, 02:00",
      out ? formatWallClock(out.runs[0]) : "parse failed"
    )
  }
  {
    let monotonic = true
    for (const p of SCHEDULE_PRESETS) {
      const r = parseCron(p.cron)
      if (!r.ok) continue
      const out = nextRuns(r.cron, now, 8)
      for (let i = 1; i < out.runs.length; i++) {
        const a = out.runs[i - 1]
        const b = out.runs[i]
        const key = (w: WallClock) => w.y * 1e8 + w.mo * 1e6 + w.d * 1e4 + w.h * 100 + w.mi
        if (key(b) <= key(a)) monotonic = false
      }
    }
    check("every preset yields strictly increasing runs", monotonic)
  }
}

/* ---- 5. Calendar primitives ---------------------------------------------- */

console.log("Calendar")
for (const [y, mo, d, want] of [
  [2026, 9, 4, 5],
  [2000, 1, 1, 6],
  [1970, 1, 1, 4],
  [2100, 3, 1, 1],
] as const) {
  check(`dowOf(${y}-${mo}-${d}) = ${want}`, dowOf(y, mo, d) === want, `got ${dowOf(y, mo, d)}`)
}
for (const [y, mo, want] of [
  [2024, 2, 29],
  [2023, 2, 28],
  [2000, 2, 29],
  [1900, 2, 28],
  [2100, 2, 28],
  [2026, 4, 30],
] as const) {
  check(`daysInMonth(${y}, ${mo}) = ${want}`, daysInMonth(y, mo) === want, `got ${daysInMonth(y, mo)}`)
}

console.log("zonedNow")
{
  // 22:30 UTC is 00:30 the NEXT day in SAST. This is the case hour12:false gets
  // wrong on some ICU builds by reporting hour 24.
  const w = zonedNow(new Date("2026-09-04T22:30:00Z"), SCHEDULE_TZ)
  check(
    "midnight rollover reads as hour 0 of the next day",
    w.y === 2026 && w.mo === 9 && w.d === 5 && w.h === 0 && w.mi === 30,
    JSON.stringify(w)
  )
  const noon = zonedNow(new Date("2026-09-04T10:00:00Z"), SCHEDULE_TZ)
  check("SAST is UTC+2", noon.h === 12 && noon.d === 4, JSON.stringify(noon))
}

/* ---- 6. describeCron ----------------------------------------------------- */

console.log("Descriptions")
for (const [expr, want] of [
  ["0 7 * * *", "At 07:00, every day."],
  ["30 5 * * 1-5", "At 05:30, on weekdays."],
  ["0 7 * * 0,6", "At 07:00, at weekends."],
  ["0 6-18/2 * * *", "Every 2 hours from 06:00 to 18:00, every day."],
  ["20 * * * *", "Every hour at :20, every day."],
  ["0 3 1 * *", "At 03:00, on the 1st of the month."],
] as const) {
  const r = parseCron(expr)
  const got = r.ok ? describeCron(r.cron) : `ERROR: ${r.error}`
  check(`${expr} -> ${want}`, got === want, `got ${got}`)
}

/* ---- 7. checkSchedule: the generator's chokepoint ------------------------ */

console.log("checkSchedule")
{
  const threw = (cron: string, tz: string) => {
    try {
      checkSchedule(cron, tz)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  check("accepts a good schedule", threw("0 7 * * *", SCHEDULE_TZ) === null)
  check(
    "emits the canonical form, not the input",
    checkSchedule("0  7   * * *", SCHEDULE_TZ).canonical === "0 7 * * *"
  )
  for (const tz of ["UTC", "utc", "Africa/Johannesburg ", "", "Africa/Johannesburg' AS CALL EVIL() --"]) {
    check(`refuses timezone ${JSON.stringify(tz)}`, (threw("0 7 * * *", tz) ?? "").includes("timezone"))
  }
  check("refuses a bad cron", (threw("*/5 * * * *", SCHEDULE_TZ) ?? "").includes("Schedule:"))
  check(
    "warns about every-hour-every-day",
    checkSchedule("0 * * * *", SCHEDULE_TZ).warnings.some((w) => w.includes("730"))
  )
  check(
    "warns about day 31",
    checkSchedule("0 7 31 * *", SCHEDULE_TZ).warnings.some((w) => w.includes("February"))
  )
  check("no warnings on a plain daily", checkSchedule("0 7 * * *", SCHEDULE_TZ).warnings.length === 0)
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
