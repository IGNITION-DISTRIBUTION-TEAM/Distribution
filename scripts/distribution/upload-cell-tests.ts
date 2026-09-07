/**
 * Offline tests for the uploaded-spreadsheet cell decision.
 *
 *   npx tsx scripts/distribution/upload-cell-tests.ts
 *
 * No files, no warehouse, no writes — lib/upload-cell-text.ts is pure, which is
 * the reason it exists as a module rather than a closure inside a 9,500-line
 * component.
 *
 * WHAT THIS GUARDS. An MTN Save file arrived with 13-digit ID numbers, and the
 * upload turned each one into the string "6.31008E+12" — Excel's own on-screen
 * rendering, handed over by `sheet_to_json({ raw: false })` and quoted straight
 * into the INSERT. Nothing errored. The stage column is VARCHAR, so Snowflake
 * stored the text as given, and every downstream join on the ID number matched
 * nothing: the XDS contact-number enrichment, the credit-risk join via UDM17,
 * the INVALID ID check. Six of thirteen digits survived, so it was not even
 * repairable in SQL afterwards.
 *
 * The fix is narrow on purpose — keep Excel's formatted text EXCEPT where it is
 * exponential — so most of these tests assert that a cell is left ALONE. Those
 * are the ones that matter if anyone is later tempted to reach for `raw: true`:
 * it would fix the ID numbers and break the dates and the percentages.
 *
 * Every case is named after the failure it prevents, not after the input.
 */
import { cellText, isTrustworthy, plainNumber } from "../../lib/upload-cell-text"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

console.log("cellText — the bug this module exists for")
{
  // Exactly the cell from the MTN Save preview.
  const c = cellText("6.31008E+12", 6310084123456)
  check("a 13-digit ID number survives the upload", c.text === "6310084123456", JSON.stringify(c))
  check("and is reported as repaired", c.repaired === true)
  check("and is not flagged untrustworthy", c.untrusted === false)
}
{
  // The shortest exponential Excel emits — no fractional part at all.
  const c = cellText("6E+12", 6000000000000)
  check("a mantissa with no decimals still expands", c.text === "6000000000000", JSON.stringify(c))
}
{
  const c = cellText("1.2e-07", 0.00000012)
  check("a small exponential expands rather than reaching Snowflake as text",
    c.text === "0.00000012", JSON.stringify(c))
}

console.log("\ncellText — the cells that must be left exactly as they are")
{
  // 11 digits: Excel's General format shows all of them, which is why msisdn
  // looked fine in the same file that broke id_number.
  const c = cellText("27784599742", 27784599742)
  check("an 11-digit msisdn is untouched", c.text === "27784599742" && !c.repaired, JSON.stringify(c))
}
{
  // The formatted text is the ONLY safe source here: the raw double is
  // 338.19999999999999, and String() of it can print 338.20000000000002.
  const c = cellText("338.2", 338.20000000000002)
  check("a decimal keeps Excel's rendering, not the float's",
    c.text === "338.2" && !c.repaired, JSON.stringify(c))
}
{
  // The reason EXPONENTIAL is anchored at both ends.
  const c = cellText("MTN Mega Flex R135 TopUp", "MTN Mega Flex R135 TopUp")
  check("a tariff name containing 'e' is not mistaken for a number",
    c.text === "MTN Mega Flex R135 TopUp" && !c.repaired, JSON.stringify(c))
}
{
  const c = cellText("BA114056959", "BA114056959")
  check("an account number is not mistaken for a number", c.text === "BA114056959" && !c.repaired)
}
{
  // THE cellDates REGRESSION GUARD. The workbook is read with cellDates: true,
  // so the raw value is a Date object. Switching the parser to raw: true would
  // put "Sat Aug 15 2026 00:00:00 GMT+0200 (...)" into contract_end_date.
  const c = cellText("2026/08/15", new Date("2026-08-15T00:00:00Z"))
  check("a date cell keeps its formatted text", c.text === "2026/08/15" && !c.repaired, JSON.stringify(c))
}
{
  // app/api/upload/load/route.ts turns "" into NULL. If this returned
  // "undefined" or "null" as text, every blank cell would become a string.
  check("an empty cell stays empty so the route still writes NULL", cellText("", "").text === "")
  check("a missing cell stays empty", cellText(undefined, undefined).text === "")
  check("a null cell stays empty", cellText(null, null).text === "")
}
{
  // Exponential text with nothing usable behind it: the text has to stand,
  // because there is no better candidate to offer.
  const c = cellText("6.31008E+12", "6.31008E+12")
  check("exponential text with no number behind it is left alone",
    c.text === "6.31008E+12" && !c.repaired, JSON.stringify(c))
  const nan = cellText("6.31008E+12", Number.NaN)
  check("and a NaN raw value is not trusted either", nan.text === "6.31008E+12" && !nan.repaired)
}

console.log("\ncellText — the case the code cannot fix, only report")
{
  // 17 digits. Excel stores 15 significant digits, so the workbook had already
  // rounded this before we saw it. Emitting the expansion keeps the right
  // LENGTH for a downstream LEN() check; the flag is what makes that honest.
  const c = cellText("1.23457E+16", 12345678901234500)
  check("a 17-digit value is flagged untrustworthy", c.untrusted === true, JSON.stringify(c))
  check("and is still expanded, so its length stays checkable", c.text.length === 17, c.text)
  check("and counts as repaired so the preview mentions it", c.repaired === true)
}

console.log("\nisTrustworthy — Excel's 15 digits, not the double's 2^53")
{
  check("a 13-digit ID is trustworthy", isTrustworthy(6310084123456))
  check("999999999999999 is the last trustworthy integer", isTrustworthy(999999999999999))
  check("1e15 is not", !isTrustworthy(1e15))
  check("zero is trustworthy", isTrustworthy(0))
  check("a small decimal is trustworthy", isTrustworthy(-0.00024729))
  check("Infinity is not", !isTrustworthy(Number.POSITIVE_INFINITY))
  check("NaN is not", !isTrustworthy(Number.NaN))
}

console.log("\nplainNumber — never an exponent, whatever the magnitude")
{
  check("a 13-digit integer", plainNumber(6310084123456) === "6310084123456")
  check("zero", plainNumber(0) === "0")
  check("a negative integer", plainNumber(-27784599742) === "-27784599742")
  // The counterpart of scripts/spot/upload-sql-tests.ts:377, which guards the
  // same property from the other direction (String() of a small float).
  check("a small negative decimal does not go exponential",
    plainNumber(-0.00024729) === "-0.00024729", plainNumber(-0.00024729))
  check("below String()'s 1e-6 threshold", plainNumber(0.00000012) === "0.00000012",
    plainNumber(0.00000012))
  check("far below it", plainNumber(1.5e-9) === "0.0000000015", plainNumber(1.5e-9))
  // toFixed(0) itself returns "1e+21" here, which is why plainNumber guards
  // the integer fast path by magnitude rather than trusting toFixed.
  check("at and above 1e21, where toFixed(0) gives up",
    plainNumber(1e21) === "1000000000000000000000", plainNumber(1e21))
  check("a decimal is unchanged", plainNumber(338.2) === "338.2")
  check("no output contains an exponent",
    ![6310084123456, -0.00024729, 1.5e-9, 1e21, 0, 338.2].some((n) => /[eE]/.test(plainNumber(n))))
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
