/**
 * Offline tests for the Calendar department's pure logic.
 *
 *   npx tsx scripts/calendar/calendar-tests.ts
 *
 * No warehouse, no network, no mail. Two things are covered, because they are
 * the two places a bug would be silent rather than loud:
 *
 *   1. What "today" is, and which bucket a date falls in. Get this wrong and
 *      a task shows under Tomorrow for a user in one timezone while the cron
 *      has already treated it as due — and nobody would notice until a
 *      reminder arrived a day early.
 *   2. resolveRecipients. Get this wrong and either the wrong people are
 *      emailed or nobody is, and "nobody" looks exactly like "email is off".
 *   3. nextOccurrence. A recurring task is a single row that rolls forward, so
 *      this function IS the series — there is no list of dates anywhere to
 *      check it against. Month-end clamping and the weekly anchor are the two
 *      places it would go wrong quietly.
 *   4. occursOn, and its AGREEMENT with nextOccurrence. The month grid draws
 *      from one and the reminder cron rolls from the other; if they ever
 *      disagree, a task is drawn on days it never fires on, or fires on a day
 *      it was never drawn. The invariant test at the end is the only thing
 *      standing between those two implementations and silent drift.
 *
 * Everything else here is SQL and Graph calls, which no offline test can
 * exercise: nothing in this repo executes SQL or sends mail.
 */
import {
  addDaysIso,
  dayOfWeek,
  daysBetween,
  formatDateLabel,
  formatDateShort,
  formatWhen,
  groupFor,
  isValidIsoDate,
  isValidTime,
  sastTodayIso,
  addMonthsIso,
  formatMonthLabel,
  isSameMonth,
  monthGridDays,
  startOfMonthIso,
} from "../../lib/calendar-dates"
import { dueWording, resolveRecipients } from "../../lib/calendar-notify"
import { buildIcs, escapeText, foldLine, rruleFor } from "../../lib/calendar-ics"
import type { CalendarTask } from "../../lib/calendar-store"
import {
  NO_RECURRENCE,
  describeRecurrence,
  firstOccurrenceFrom,
  nextOccurrence,
  normalizeRecurrence,
  occursOn,
  occurrencesInRange,
  upcomingOccurrences,
  type Recurrence,
} from "../../lib/calendar-recurrence"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

/* ---- 1. "Today" is Johannesburg's today, not the machine's --------------- */

console.log("sastTodayIso")
{
  // 2026-03-10 22:30 UTC is already the 11th in SAST (UTC+2). A helper built on
  // browser-local time would answer "the 10th" on a UTC machine, which is the
  // exact bug this function exists to avoid.
  check(
    "22:30 UTC is already the next day in SAST",
    sastTodayIso(new Date("2026-03-10T22:30:00Z")) === "2026-03-11",
    sastTodayIso(new Date("2026-03-10T22:30:00Z"))
  )
  check(
    "21:59 UTC is still the same day",
    sastTodayIso(new Date("2026-03-10T21:59:00Z")) === "2026-03-10"
  )
  // No DST in Africa/Johannesburg, so the same offset holds in July.
  check(
    "the offset does not move in the southern winter",
    sastTodayIso(new Date("2026-07-10T22:30:00Z")) === "2026-07-11"
  )
  check("the format is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(sastTodayIso()))
}

/* ---- 2. Date validation ------------------------------------------------- */

console.log("\nisValidIsoDate")
{
  check("accepts a real date", isValidIsoDate("2026-09-12"))
  check("accepts a leap day in a leap year", isValidIsoDate("2024-02-29"))
  // The shape regex alone would pass all three of these.
  check("rejects 2026-02-31", !isValidIsoDate("2026-02-31"))
  check("rejects 2026-02-30", !isValidIsoDate("2026-02-30"))
  check("rejects 2026-13-01", !isValidIsoDate("2026-13-01"))
  check("rejects a leap day in a common year", !isValidIsoDate("2026-02-29"))
  check("rejects the wrong shape", !isValidIsoDate("12/09/2026"))
  check("rejects a non-string", !isValidIsoDate(20260912))
  check("rejects empty", !isValidIsoDate(""))
}

console.log("\nisValidTime")
{
  check("accepts 00:00", isValidTime("00:00"))
  check("accepts 23:59", isValidTime("23:59"))
  check("rejects 24:00", !isValidTime("24:00"))
  check("rejects 07:60", !isValidTime("07:60"))
  check("rejects 7:30 without the leading zero", !isValidTime("7:30"))
}

/* ---- 3. Arithmetic ------------------------------------------------------ */

console.log("\naddDaysIso / daysBetween / dayOfWeek")
{
  check("crosses a month end", addDaysIso("2026-01-31", 1) === "2026-02-01")
  check("crosses a year end", addDaysIso("2026-12-31", 1) === "2027-01-01")
  check("goes backwards", addDaysIso("2026-03-01", -1) === "2026-02-28")
  check("handles a leap year", addDaysIso("2024-02-28", 1) === "2024-02-29")
  check("daysBetween counts forwards", daysBetween("2026-09-10", "2026-09-13") === 3)
  check("daysBetween is negative backwards", daysBetween("2026-09-13", "2026-09-10") === -3)
  check("daysBetween is zero for the same day", daysBetween("2026-09-10", "2026-09-10") === 0)
  // 2026-09-11 is a Friday.
  check("dayOfWeek: Friday is 5", dayOfWeek("2026-09-11") === 5)
  check("dayOfWeek: Sunday is 0", dayOfWeek("2026-09-13") === 0)
}

/* ---- 4. Grouping -------------------------------------------------------- */

console.log("\ngroupFor")
{
  // Wednesday 2026-09-09. The coming Sunday is the 13th.
  const wed = "2026-09-09"
  check("yesterday is overdue", groupFor("2026-09-08", wed) === "overdue")
  check("today is today", groupFor(wed, wed) === "today")
  check("tomorrow is tomorrow", groupFor("2026-09-10", wed) === "tomorrow")
  check("the day after is this week", groupFor("2026-09-11", wed) === "week")
  check("the coming Sunday is the last day of this week", groupFor("2026-09-13", wed) === "week")
  check("the following Monday is later", groupFor("2026-09-14", wed) === "later")

  // On a Sunday the week has nothing left in it — everything past tomorrow is
  // "Later". That is the intended reading of "this week", not an off-by-one.
  const sun = "2026-09-13"
  check("on a Sunday, Monday is tomorrow", groupFor("2026-09-14", sun) === "tomorrow")
  check("on a Sunday, Tuesday is already later", groupFor("2026-09-15", sun) === "later")

  // On a Monday the whole week is ahead.
  const mon = "2026-09-14"
  check("on a Monday, the coming Sunday is still this week", groupFor("2026-09-20", mon) === "week")
  check("on a Monday, the Monday after is later", groupFor("2026-09-21", mon) === "later")
}

/* ---- 5. Formatting ------------------------------------------------------ */

console.log("\nformatting")
{
  check("long label", formatDateLabel("2026-09-11") === "Friday 11 September", formatDateLabel("2026-09-11"))
  check("long label with a year", formatDateLabel("2026-09-11", true) === "Friday 11 September 2026")
  check("short label", formatDateShort("2026-09-11") === "Fri 11 Sep", formatDateShort("2026-09-11"))
  check(
    "when, with a time",
    formatWhen("2026-09-11", "14:30") === "Friday 11 September 2026, 14:30"
  )
  check(
    "when, all day",
    formatWhen("2026-09-11", null) === "Friday 11 September 2026 (all day)"
  )
  // A malformed date must fall through rather than render "Invalid Date".
  check("a bad date is passed through unchanged", formatDateLabel("nonsense") === "nonsense")
}

/* ---- 6. Who gets the mail ----------------------------------------------- */

console.log("\nresolveRecipients")
{
  const team = ["ann@x.co", "bob@x.co"]
  const t = (mode: "team" | "custom" | "both", recipients: string[]) => ({
    recipientsMode: mode,
    recipients,
  })

  check(
    "team mode uses the team list",
    JSON.stringify(resolveRecipients(t("team", ["zoe@x.co"]), team)) === JSON.stringify(team)
  )
  check(
    "custom mode ignores the team list entirely",
    JSON.stringify(resolveRecipients(t("custom", ["zoe@x.co"]), team)) === '["zoe@x.co"]'
  )
  check(
    "both mode is the union, team first",
    JSON.stringify(resolveRecipients(t("both", ["zoe@x.co"]), team)) ===
      '["ann@x.co","bob@x.co","zoe@x.co"]'
  )

  // The case that makes lower-casing-before-dedupe load bearing: Exchange
  // treats these as one person, a Set does not.
  check(
    "case-folds before deduping, so Ann is not mailed twice",
    JSON.stringify(resolveRecipients(t("both", ["ANN@x.co"]), team)) ===
      '["ann@x.co","bob@x.co"]',
    JSON.stringify(resolveRecipients(t("both", ["ANN@x.co"]), team))
  )
  check(
    "trims whitespace",
    JSON.stringify(resolveRecipients(t("custom", ["  zoe@x.co  "]), [])) === '["zoe@x.co"]'
  )
  check(
    "drops entries that are not addresses",
    JSON.stringify(resolveRecipients(t("custom", ["", "nope", "zoe@x.co"]), [])) === '["zoe@x.co"]'
  )
  check(
    "an empty team in team mode means nobody",
    resolveRecipients(t("team", ["zoe@x.co"]), []).length === 0
  )
  check(
    "an empty override in custom mode means nobody, even with a team",
    resolveRecipients(t("custom", []), team).length === 0
  )
  check(
    "caps a runaway list at 100",
    resolveRecipients(
      t("custom", Array.from({ length: 150 }, (_, i) => `p${i}@x.co`)),
      []
    ).length === 100
  )
  // The stored value could be anything if a row predates a validator change.
  check(
    "survives junk in the stored array",
    JSON.stringify(
      resolveRecipients(
        { recipientsMode: "custom", recipients: [null, undefined, 42, "zoe@x.co"] as never },
        []
      )
    ) === '["zoe@x.co"]'
  )
}

/* ---- 7. Reminder wording ------------------------------------------------ */

console.log("\ndueWording")
{
  check("0 days is today", dueWording(0) === "Due today")
  check("1 day is tomorrow", dueWording(1) === "Due tomorrow")
  check("3 days counts", dueWording(3) === "Due in 3 days")
  // A reminder for something already past should still read sensibly rather
  // than "Due in -2 days" — the cron will not select it, but nothing else
  // guarantees that.
  check("a negative reads as today, not a negative count", dueWording(-2) === "Due today")
}

/* ---- 8. Recurrence rules ------------------------------------------------ */

const rule = (r: Partial<Recurrence>): Recurrence => ({ ...NO_RECURRENCE, ...r })

console.log("\nnormalizeRecurrence")
{
  check("junk becomes 'does not repeat'", normalizeRecurrence(undefined).kind === "none")
  check("an unknown kind becomes 'none'", normalizeRecurrence({ kind: "hourly" }).kind === "none")
  check(
    "weekly with no days picked uses the start date's weekday",
    // 2026-09-11 is a Friday (5).
    JSON.stringify(normalizeRecurrence({ kind: "weekly" }, "2026-09-11").weekdays) === "[5]"
  )
  check(
    "monthly with no day picked uses the start date's day",
    normalizeRecurrence({ kind: "monthly" }, "2026-09-11").dayOfMonth === 11
  )
  check("interval floors at 1", normalizeRecurrence({ kind: "daily", interval: 0 }).interval === 1)
  check("interval caps at 99", normalizeRecurrence({ kind: "daily", interval: 5000 }).interval === 99)
  check(
    "weekdays arrive as a JSON string from Snowflake",
    JSON.stringify(normalizeRecurrence({ kind: "weekly", weekdays: "[1,3]" }).weekdays) === "[1,3]"
  )
  check(
    "out-of-range weekdays are dropped",
    JSON.stringify(normalizeRecurrence({ kind: "weekly", weekdays: [1, 9, -2, 3] }).weekdays) ===
      "[1,3]"
  )
  check(
    "a bad until date is dropped rather than ending the series",
    normalizeRecurrence({ kind: "daily", until: "2026-02-31" }).until === null
  )
}

console.log("\nnextOccurrence — daily")
{
  check(
    "every day",
    nextOccurrence(rule({ kind: "daily", interval: 1 }), "2026-09-11") === "2026-09-12"
  )
  check(
    "every 3 days",
    nextOccurrence(rule({ kind: "daily", interval: 3 }), "2026-09-11") === "2026-09-14"
  )
  check(
    "crosses a month end",
    nextOccurrence(rule({ kind: "daily", interval: 1 }), "2026-09-30") === "2026-10-01"
  )
  // The catch-up case: three weeks overdue, one step, lands on or after today.
  const caught = nextOccurrence(rule({ kind: "daily", interval: 1 }), "2026-08-20", "2026-09-11")
  check("a stale series catches up to today in one step", caught === "2026-09-11", String(caught))
  check(
    "a stale series with an interval lands on the cycle, not on today",
    nextOccurrence(rule({ kind: "daily", interval: 7 }), "2026-08-20", "2026-09-11") === "2026-09-17"
  )
  check(
    "'none' never has a next occurrence",
    nextOccurrence(NO_RECURRENCE, "2026-09-11") === null
  )
}

console.log("\nnextOccurrence — weekly")
{
  // 2026-09-14 is a Monday, 2026-09-16 a Wednesday, 2026-09-11 a Friday.
  const monWed = rule({ kind: "weekly", interval: 1, weekdays: [1, 3] })
  check("from Monday, the next is Wednesday", nextOccurrence(monWed, "2026-09-14") === "2026-09-16")
  check(
    "from Wednesday, the next is the following Monday",
    nextOccurrence(monWed, "2026-09-16") === "2026-09-21"
  )
  const everyFri = rule({ kind: "weekly", interval: 1, weekdays: [5] })
  check("a single weekday steps a week", nextOccurrence(everyFri, "2026-09-11") === "2026-09-18")

  // Fortnightly is anchored to the WEEK: both days of one week, then skip one.
  const fortnight = rule({ kind: "weekly", interval: 2, weekdays: [1, 3] })
  check(
    "fortnightly keeps both days inside the same week",
    nextOccurrence(fortnight, "2026-09-14") === "2026-09-16"
  )
  check(
    "then skips a whole week rather than drifting",
    nextOccurrence(fortnight, "2026-09-16") === "2026-09-28",
    String(nextOccurrence(fortnight, "2026-09-16"))
  )
  // Sunday is 0 but the week starts Monday, so a Sunday-only rule must not
  // jump backwards into the week just gone.
  const sundays = rule({ kind: "weekly", interval: 1, weekdays: [0] })
  check("Sunday-only moves forward", nextOccurrence(sundays, "2026-09-13") === "2026-09-20")
}

console.log("\nnextOccurrence — monthly")
{
  const the12th = rule({ kind: "monthly", interval: 1, dayOfMonth: 12 })
  check("the 12th, next month", nextOccurrence(the12th, "2026-09-12") === "2026-10-12")
  check(
    "every 3 months",
    nextOccurrence(rule({ kind: "monthly", interval: 3, dayOfMonth: 12 }), "2026-09-12") ===
      "2026-12-12"
  )
  check(
    "crosses a year end",
    nextOccurrence(the12th, "2026-12-12") === "2027-01-12"
  )

  // The clamp, and the reason the ANCHOR is stored rather than the last date
  // used: a series on the 31st must come BACK to the 31st after February.
  const the31st = rule({ kind: "monthly", interval: 1, dayOfMonth: 31 })
  check("January 31 → February 28 in a common year", nextOccurrence(the31st, "2026-01-31") === "2026-02-28")
  check("February 28 → March 31, not March 28", nextOccurrence(the31st, "2026-02-28") === "2026-03-31")
  check("March 31 → April 30", nextOccurrence(the31st, "2026-03-31") === "2026-04-30")
  check("April 30 → May 31", nextOccurrence(the31st, "2026-04-30") === "2026-05-31")
  check("and February 29 in a leap year", nextOccurrence(the31st, "2024-01-31") === "2024-02-29")

  const the30th = rule({ kind: "monthly", interval: 1, dayOfMonth: 30 })
  check("the 30th also clamps in February", nextOccurrence(the30th, "2026-01-30") === "2026-02-28")
  check("and comes back to the 30th", nextOccurrence(the30th, "2026-02-28") === "2026-03-30")
}

console.log("\nnextOccurrence — until")
{
  const ends = rule({ kind: "daily", interval: 1, until: "2026-09-13" })
  check("inside the window", nextOccurrence(ends, "2026-09-11") === "2026-09-12")
  check("the last day is included", nextOccurrence(ends, "2026-09-12") === "2026-09-13")
  check("past it there is nothing", nextOccurrence(ends, "2026-09-13") === null)
}

console.log("\nupcomingOccurrences")
{
  check(
    "three weekly dates",
    JSON.stringify(
      upcomingOccurrences(rule({ kind: "weekly", interval: 1, weekdays: [5] }), "2026-09-11", 3)
    ) === '["2026-09-18","2026-09-25","2026-10-02"]'
  )
  check(
    "stops at the until date rather than padding",
    upcomingOccurrences(
      rule({ kind: "daily", interval: 1, until: "2026-09-13" }),
      "2026-09-11",
      5
    ).length === 2
  )
  check("a non-repeating rule yields nothing", upcomingOccurrences(NO_RECURRENCE, "2026-09-11", 3).length === 0)
}

console.log("\ndescribeRecurrence")
{
  check("none", describeRecurrence(NO_RECURRENCE) === "Does not repeat")
  check("daily", describeRecurrence(rule({ kind: "daily", interval: 1 })) === "Every day")
  check("every 3 days", describeRecurrence(rule({ kind: "daily", interval: 3 })) === "Every 3 days")
  check(
    "weekly on two days, Monday first",
    describeRecurrence(rule({ kind: "weekly", interval: 1, weekdays: [3, 1] })) ===
      "Every week on Monday and Wednesday",
    describeRecurrence(rule({ kind: "weekly", interval: 1, weekdays: [3, 1] }))
  )
  check(
    "Sunday sorts last, not first",
    describeRecurrence(rule({ kind: "weekly", interval: 1, weekdays: [0, 1] })) ===
      "Every week on Monday and Sunday"
  )
  check(
    "fortnightly",
    describeRecurrence(rule({ kind: "weekly", interval: 2, weekdays: [5] })) ===
      "Every 2 weeks on Friday"
  )
  check(
    "monthly ordinal",
    describeRecurrence(rule({ kind: "monthly", interval: 1, dayOfMonth: 12 })) ===
      "Every month on the 12th"
  )
  check(
    "1st, 2nd, 3rd",
    ["1st", "2nd", "3rd"].every((suffix, i) =>
      describeRecurrence(rule({ kind: "monthly", interval: 1, dayOfMonth: i + 1 })).endsWith(suffix)
    )
  )
  check(
    "11th, 12th, 13th are not 11st/12nd/13rd",
    [11, 12, 13].every((d) =>
      describeRecurrence(rule({ kind: "monthly", interval: 1, dayOfMonth: d })).endsWith(`the ${d}th`)
    )
  )
  check(
    "a late day says what happens in February",
    describeRecurrence(rule({ kind: "monthly", interval: 1, dayOfMonth: 31 })).includes(
      "or the last day"
    )
  )
  check(
    "until is appended",
    describeRecurrence(rule({ kind: "daily", interval: 1, until: "2026-12-31" })) ===
      "Every day, until 2026-12-31"
  )
}

/* ---- 9. Month arithmetic for the grid ----------------------------------- */

console.log("\nmonth arithmetic")
{
  check("startOfMonthIso", startOfMonthIso("2026-09-23") === "2026-09-01")
  check("addMonthsIso forward", addMonthsIso("2026-09-12", 1) === "2026-10-12")
  check("addMonthsIso back", addMonthsIso("2026-09-12", -1) === "2026-08-12")
  check("addMonthsIso across a year end", addMonthsIso("2026-12-15", 1) === "2027-01-15")
  check("addMonthsIso back across a year start", addMonthsIso("2026-01-15", -1) === "2025-12-15")
  check("addMonthsIso by 12", addMonthsIso("2026-02-28", 12) === "2027-02-28")
  // The bug this function exists to avoid: Date.setMonth on 31 August plus one
  // lands on 1 October, and minus six lands in March.
  check("31 Aug + 1 month clamps to 30 Sep", addMonthsIso("2026-08-31", 1) === "2026-09-30")
  check("31 Jan + 1 month clamps to 28 Feb", addMonthsIso("2026-01-31", 1) === "2026-02-28")
  check("31 Jan + 1 month in a leap year", addMonthsIso("2024-01-31", 1) === "2024-02-29")
  check("31 Aug - 6 months is 28 Feb, not March", addMonthsIso("2026-08-31", -6) === "2026-02-28")
  check("formatMonthLabel", formatMonthLabel("2026-09-01") === "September 2026")
  check("isSameMonth", isSameMonth("2026-09-30", "2026-09-01"))
  check("isSameMonth rejects the next month", !isSameMonth("2026-10-01", "2026-09-01"))
}

console.log("\nmonthGridDays")
{
  // September 2026: the 1st is a Tuesday, so the grid opens on Monday 31 Aug.
  const sep = monthGridDays("2026-09-01")
  check("always 42 cells", sep.length === 42, String(sep.length))
  check("starts on the Monday before the 1st", sep[0] === "2026-08-31", sep[0])
  check("every cell is a Monday-started week", dayOfWeek(sep[0]) === 1)
  check("the last cell is a Sunday", dayOfWeek(sep[41]) === 0)
  check("cells are consecutive", sep.every((d, i) => i === 0 || d === addDaysIso(sep[i - 1], 1)))
  check("contains the whole month", sep.includes("2026-09-01") && sep.includes("2026-09-30"))

  // A month starting ON a Monday must not drop a leading week.
  const jun = monthGridDays("2026-06-01")
  check("a month starting on Monday starts on the 1st", jun[0] === "2026-06-01", jun[0])
  check("and still has 42 cells", jun.length === 42)

  // February 2026 is 28 days starting Sunday — the tightest case, and the one
  // that would be 5 rows if the count were not fixed.
  const feb = monthGridDays("2026-02-01")
  check("a short month is still 42 cells", feb.length === 42)
  check("a Sunday 1st opens the week before", feb[0] === "2026-01-26", feb[0])
  check("and still contains the whole month", feb.includes("2026-02-28"))

  check("the day of the month does not matter", monthGridDays("2026-09-23")[0] === sep[0])
}

/* ---- 10. occursOn -------------------------------------------------------- */

console.log("\noccursOn")
{
  const anchor = "2026-09-14" // a Monday
  const daily = rule({ kind: "daily", interval: 1 })
  check("the anchor itself occurs", occursOn(daily, anchor, anchor))
  check("the day after occurs", occursOn(daily, anchor, "2026-09-15"))
  // The lower bound: a series does not exist before it started.
  check("nothing before the anchor occurs", !occursOn(daily, anchor, "2026-09-13"))
  check("'none' never occurs", !occursOn(NO_RECURRENCE, anchor, anchor))

  const every3 = rule({ kind: "daily", interval: 3 })
  check("every 3 days: +3 occurs", occursOn(every3, anchor, "2026-09-17"))
  check("every 3 days: +2 does not", !occursOn(every3, anchor, "2026-09-16"))
  check("every 3 days: +30 occurs", occursOn(every3, anchor, "2026-10-14"))

  const mondays = rule({ kind: "weekly", interval: 1, weekdays: [1] })
  check("weekly: a later Monday occurs", occursOn(mondays, anchor, "2026-09-28"))
  check("weekly: a Tuesday does not", !occursOn(mondays, anchor, "2026-09-29"))

  const fortnight = rule({ kind: "weekly", interval: 2, weekdays: [1, 3] })
  check("fortnightly: the anchor week's Wednesday occurs", occursOn(fortnight, anchor, "2026-09-16"))
  check("fortnightly: the NEXT week's Monday does not", !occursOn(fortnight, anchor, "2026-09-21"))
  check("fortnightly: the week after that does", occursOn(fortnight, anchor, "2026-09-28"))

  const the31st = rule({ kind: "monthly", interval: 1, dayOfMonth: 31 })
  check("monthly 31: January occurs", occursOn(the31st, "2026-01-31", "2026-01-31"))
  // The clamp has to work in BOTH directions or the grid and the roll disagree.
  check("monthly 31: 28 Feb stands in for it", occursOn(the31st, "2026-01-31", "2026-02-28"))
  check("monthly 31: 27 Feb does not", !occursOn(the31st, "2026-01-31", "2026-02-27"))
  check("monthly 31: March is back to the 31st", occursOn(the31st, "2026-01-31", "2026-03-31"))
  check("monthly 31: 30 Mar does not", !occursOn(the31st, "2026-01-31", "2026-03-30"))
  check("monthly 31: 30 Apr stands in", occursOn(the31st, "2026-01-31", "2026-04-30"))

  const untilRule = rule({ kind: "daily", interval: 1, until: "2026-09-20" })
  check("until: the last day occurs", occursOn(untilRule, anchor, "2026-09-20"))
  check("until: the day after does not", !occursOn(untilRule, anchor, "2026-09-21"))

  check("a malformed date never occurs", !occursOn(daily, anchor, "2026-02-31"))
}

/* ---- 11. firstOccurrenceFrom and occurrencesInRange --------------------- */

console.log("\nfirstOccurrenceFrom")
{
  const mondays = rule({ kind: "weekly", interval: 1, weekdays: [1] })
  check(
    "from a Wednesday, the next Monday",
    firstOccurrenceFrom(mondays, "2026-09-14", "2026-09-16") === "2026-09-21"
  )
  check(
    "from an occurrence, that same day",
    firstOccurrenceFrom(mondays, "2026-09-14", "2026-09-21") === "2026-09-21"
  )
  check(
    "a `from` before the anchor is pulled up to it",
    firstOccurrenceFrom(mondays, "2026-09-14", "2026-01-01") === "2026-09-14"
  )
  check(
    "past the until date there is nothing",
    firstOccurrenceFrom(
      rule({ kind: "daily", interval: 1, until: "2026-09-20" }),
      "2026-09-14",
      "2026-09-25"
    ) === null
  )
  // The reason this function exists: the rule changed, the stored date did not.
  const tuesdays = rule({ kind: "weekly", interval: 1, weekdays: [2] })
  check(
    "re-seats a date the new rule no longer produces",
    firstOccurrenceFrom(tuesdays, "2026-09-14", "2026-09-14") === "2026-09-15",
    String(firstOccurrenceFrom(tuesdays, "2026-09-14", "2026-09-14"))
  )
}

console.log("\noccurrencesInRange")
{
  const mondays = rule({ kind: "weekly", interval: 1, weekdays: [1] })
  const sep = occurrencesInRange(mondays, "2026-09-07", "2026-09-01", "2026-09-30")
  check(
    "every Monday of September from the 7th",
    JSON.stringify(sep) === '["2026-09-07","2026-09-14","2026-09-21","2026-09-28"]',
    JSON.stringify(sep)
  )
  check(
    "nothing before the anchor, even inside the window",
    !occurrencesInRange(mondays, "2026-09-07", "2026-09-01", "2026-09-30").includes("2026-08-31")
  )
  check(
    "daily fills the window",
    occurrencesInRange(rule({ kind: "daily", interval: 1 }), "2026-09-01", "2026-09-01", "2026-09-30")
      .length === 30
  )
  check(
    "a non-repeating rule yields nothing",
    occurrencesInRange(NO_RECURRENCE, "2026-09-01", "2026-09-01", "2026-09-30").length === 0
  )
  check(
    "an inverted window yields nothing",
    occurrencesInRange(mondays, "2026-09-07", "2026-09-30", "2026-09-01").length === 0
  )
  // The grid's real call: 42 cells, a fortnightly two-day rule.
  const grid = monthGridDays("2026-09-01")
  const got = occurrencesInRange(
    rule({ kind: "weekly", interval: 2, weekdays: [1, 3] }),
    "2026-09-14",
    grid[0],
    grid[41]
  )
  check(
    "a fortnightly pair across a whole grid window",
    JSON.stringify(got) === '["2026-09-14","2026-09-16","2026-09-28","2026-09-30"]',
    JSON.stringify(got)
  )
}

/* ---- 12. THE INVARIANT: occursOn and nextOccurrence must agree ---------- */

console.log("\ncongruence invariant (the grid and the cron must agree)")
{
  const cases: { name: string; rule: Recurrence; start: string }[] = [
    { name: "every day", rule: rule({ kind: "daily", interval: 1 }), start: "2026-09-14" },
    { name: "every 5 days", rule: rule({ kind: "daily", interval: 5 }), start: "2026-09-14" },
    { name: "weekly on Mon", rule: rule({ kind: "weekly", interval: 1, weekdays: [1] }), start: "2026-09-14" },
    { name: "fortnightly Mon+Wed", rule: rule({ kind: "weekly", interval: 2, weekdays: [1, 3] }), start: "2026-09-14" },
    { name: "every 3 weeks Fri+Sun", rule: rule({ kind: "weekly", interval: 3, weekdays: [5, 0] }), start: "2026-09-13" },
    { name: "monthly on the 12th", rule: rule({ kind: "monthly", interval: 1, dayOfMonth: 12 }), start: "2026-09-12" },
    { name: "monthly on the 31st", rule: rule({ kind: "monthly", interval: 1, dayOfMonth: 31 }), start: "2026-01-31" },
    { name: "every 2 months on the 30th", rule: rule({ kind: "monthly", interval: 2, dayOfMonth: 30 }), start: "2026-01-30" },
    { name: "quarterly on the 29th", rule: rule({ kind: "monthly", interval: 3, dayOfMonth: 29 }), start: "2026-01-29" },
  ]

  for (const c of cases) {
    // Roll the series forward the way the cron and the tick-off do, and assert
    // every landing is a date the GRID would have drawn.
    let cursor = c.start
    let steps = 0
    let bad: string | null = null
    for (let i = 0; i < 40; i++) {
      const next = nextOccurrence(c.rule, cursor)
      if (!next) break
      if (!occursOn(c.rule, c.start, next)) {
        bad = next
        break
      }
      cursor = next
      steps++
    }
    check(
      `${c.name}: 40 rolls all land on drawn dates`,
      bad === null && steps === 40,
      bad ? `nextOccurrence produced ${bad}, which occursOn rejects` : `only ${steps} steps`
    )

    // And the converse: every date the grid draws in a wide window is one the
    // roll would actually reach. This is the direction that catches occursOn
    // being too GENEROUS.
    const window = occurrencesInRange(c.rule, c.start, c.start, addMonthsIso(c.start, 14))
    const reachable = new Set<string>([c.start])
    let walk: string | null = c.start
    for (let i = 0; i < 500 && walk; i++) {
      walk = nextOccurrence(c.rule, walk)
      if (walk) reachable.add(walk)
    }
    const orphan = window.find((d) => !reachable.has(d))
    check(
      `${c.name}: every drawn date is reachable by rolling`,
      orphan === undefined,
      orphan ? `occursOn draws ${orphan}, which nextOccurrence never reaches` : ""
    )
  }
}

/* ---- 13. The .ics export ------------------------------------------------ */

/** A task, with only the fields a given check cares about spelled out. */
const task = (over: Partial<CalendarTask>): CalendarTask => ({
  id: 1,
  title: "Standup",
  description: null,
  dueDate: "2026-09-14",
  dueTime: null,
  status: "open",
  assignee: null,
  recipientsMode: "team",
  recipients: [],
  remindEnabled: true,
  remindDaysBefore: 0,
  reminderSentFor: null,
  recurrence: NO_RECURRENCE,
  seriesStart: "2026-09-14",
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
  ...over,
})

console.log("\nescapeText")
{
  // Each of these would break the line grammar if it went through raw. The
  // semicolon case is a regression guard: "\;" in TypeScript is just ";", so
  // the obvious spelling of this function silently escapes nothing.
  check("escapes a semicolon", escapeText("a;b") === "a\\;b", escapeText("a;b"))
  check("escapes a comma", escapeText("a,b") === "a\\,b", escapeText("a,b"))
  check("escapes a backslash", escapeText("a\\b") === "a\\\\b", escapeText("a\\b"))
  check("turns a newline into \\n", escapeText("a\nb") === "a\\nb", escapeText("a\nb"))
  check("turns CRLF into one \\n", escapeText("a\r\nb") === "a\\nb", escapeText("a\r\nb"))
  // Order matters: escaping the backslash last would double-escape the others.
  check("a backslash before a comma survives once", escapeText("a\\,b") === "a\\\\\\,b", escapeText("a\\,b"))
  check("leaves ordinary text alone", escapeText("Q3 review") === "Q3 review")
}

console.log("\nfoldLine")
{
  check("a short line is untouched", JSON.stringify(foldLine("SUMMARY:hi")) === '["SUMMARY:hi"]')
  const long = `SUMMARY:${"x".repeat(200)}`
  const folded = foldLine(long)
  check("a long line is split", folded.length > 1, String(folded.length))
  check("the first part is at most 75 octets", Buffer.byteLength(folded[0]) <= 75)
  check(
    "continuations start with a space and fit",
    folded.slice(1).every((l) => l.startsWith(" ") && Buffer.byteLength(l) <= 75)
  )
  check(
    "unfolding restores the original",
    folded.map((l, i) => (i === 0 ? l : l.slice(1))).join("") === long
  )
  // Folding counts BYTES. An emoji is 4 octets, so a naive character count
  // would emit lines Outlook reads as over-long.
  const emoji = `SUMMARY:${"\u{1F600}".repeat(40)}`
  const eFolded = foldLine(emoji)
  check(
    "multi-byte characters are measured in octets",
    eFolded.every((l) => Buffer.byteLength(l) <= 75),
    JSON.stringify(eFolded.map((l) => Buffer.byteLength(l)))
  )
  check(
    "and are never split mid-character",
    eFolded.map((l, i) => (i === 0 ? l : l.slice(1))).join("") === emoji
  )
}

console.log("\nrruleFor")
{
  check("a one-off has no rule", rruleFor(task({})) === null)
  check(
    "daily",
    rruleFor(task({ recurrence: rule({ kind: "daily", interval: 1 }) })) === "FREQ=DAILY"
  )
  check(
    "every 3 days",
    rruleFor(task({ recurrence: rule({ kind: "daily", interval: 3 }) })) === "FREQ=DAILY;INTERVAL=3"
  )
  check(
    "weekly on Mon and Wed, Monday first",
    rruleFor(task({ recurrence: rule({ kind: "weekly", interval: 1, weekdays: [3, 1] }) })) ===
      "FREQ=WEEKLY;BYDAY=MO,WE",
    String(rruleFor(task({ recurrence: rule({ kind: "weekly", interval: 1, weekdays: [3, 1] }) })))
  )
  check(
    "Sunday is SU and sorts last",
    rruleFor(task({ recurrence: rule({ kind: "weekly", interval: 1, weekdays: [0, 1] }) })) ===
      "FREQ=WEEKLY;BYDAY=MO,SU"
  )
  check(
    "fortnightly",
    rruleFor(task({ recurrence: rule({ kind: "weekly", interval: 2, weekdays: [5] }) })) ===
      "FREQ=WEEKLY;BYDAY=FR;INTERVAL=2"
  )
  check(
    "monthly carries BYMONTHDAY",
    rruleFor(task({ recurrence: rule({ kind: "monthly", interval: 1, dayOfMonth: 12 }) })) ===
      "FREQ=MONTHLY;BYMONTHDAY=12"
  )
  check(
    "until is appended",
    rruleFor(task({ recurrence: rule({ kind: "daily", interval: 1, until: "2026-12-31" }) })) ===
      "FREQ=DAILY;UNTIL=20261231"
  )
}

console.log("\nbuildIcs")
{
  const now = new Date("2026-09-06T10:30:00Z")

  /**
   * Undo the 75-octet folding, the way any real consumer does before reading
   * a property. Asserting against the raw text would make every check below
   * depend on where a line happens to wrap.
   */
  const unfold = (ics: string) => ics.replace(/\r\n /g, "")

  const one = unfold(buildIcs([task({})], { name: "Team", now }))

  check("CRLF line endings", one.includes("\r\n") && !/[^\r]\n/.test(one))
  check("ends with CRLF", one.endsWith("\r\n"))
  check("opens and closes the calendar", one.startsWith("BEGIN:VCALENDAR") && one.includes("END:VCALENDAR"))
  check("declares the version", one.includes("VERSION:2.0"))
  check("carries a VTIMEZONE for SAST", one.includes("TZID:Africa/Johannesburg"))
  check("the zone is a flat +02:00 with no DAYLIGHT rule", one.includes("TZOFFSETTO:+0200") && !one.includes("BEGIN:DAYLIGHT"))
  check("pins DTSTAMP from the injected clock", one.includes("DTSTAMP:20260906T103000Z"))
  check("the UID is stable and per task", one.includes("UID:calendar-1@ignitiongroup.co.za"))
  check("says it is a snapshot in the description", one.includes("does not update"))

  // All-day: a DATE value, and DTEND is the EXCLUSIVE next day.
  check("all-day uses VALUE=DATE", one.includes("DTSTART;VALUE=DATE:20260914"))
  check("and an exclusive DTEND", one.includes("DTEND;VALUE=DATE:20260915"), "DTEND missing or wrong")

  const timed = unfold(buildIcs([task({ dueTime: "14:30" })], { name: "Team", now }))
  check(
    "a timed task carries the zone",
    timed.includes("DTSTART;TZID=Africa/Johannesburg:20260914T143000"),
    "DTSTART wrong"
  )
  check("and is zero-length rather than a guessed span", timed.includes("DTEND;TZID=Africa/Johannesburg:20260914T143000"))

  // The detail that needs SERIES_START: a rolled series must import from its
  // ORIGIN, or Outlook shows a series that started late and lost its history.
  const rolled = unfold(buildIcs(
    [task({
      dueDate: "2026-11-02",
      seriesStart: "2026-09-14",
      recurrence: rule({ kind: "weekly", interval: 1, weekdays: [1] }),
    })],
    { name: "Team", now }
  ))
  check("a recurring series starts at its series start", rolled.includes("DTSTART;VALUE=DATE:20260914"))
  check("not at the date it has rolled to", !rolled.includes("DTSTART;VALUE=DATE:20261102"))
  check("and carries the RRULE", rolled.includes("RRULE:FREQ=WEEKLY;BYDAY=MO"))

  // A title full of the reserved characters must survive intact.
  const nasty = unfold(buildIcs(
    [task({ title: "Review: A, B; C\\D", description: "line one\nline two" })],
    { name: "Team", now }
  ))
  check("a reserved-character title is escaped", nasty.includes("SUMMARY:Review: A\\, B\\; C\\\\D"), "SUMMARY wrong")
  check("a multi-line description becomes one folded line", nasty.includes("line one\\nline two"))

  check("cancelled tasks say so", unfold(buildIcs([task({ status: "cancelled" })], { name: "T", now })).includes("STATUS:CANCELLED"))
  check("one VEVENT per task", (buildIcs([task({ id: 1 }), task({ id: 2 })], { name: "T", now }).match(/BEGIN:VEVENT/g) ?? []).length === 2)
  check("an empty calendar is still valid", buildIcs([], { name: "T", now }).includes("END:VCALENDAR"))
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
