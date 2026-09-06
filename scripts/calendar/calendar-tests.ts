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
} from "../../lib/calendar-dates"
import { dueWording, resolveRecipients } from "../../lib/calendar-notify"
import {
  NO_RECURRENCE,
  describeRecurrence,
  nextOccurrence,
  normalizeRecurrence,
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
