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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
