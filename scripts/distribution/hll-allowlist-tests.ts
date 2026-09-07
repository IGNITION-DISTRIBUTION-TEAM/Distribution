/**
 * Offline tests for the update-HLL allowlist check.
 *
 *   npx tsx scripts/distribution/hll-allowlist-tests.ts
 *
 * No warehouse, no writes — lib/hll-proc-allowlist.ts is pure, which is why it
 * is a module rather than three lines inside the route.
 *
 * WHAT THIS GUARDS. The check used to be an exact string match on the whole
 * call string, so a campaign configured with SP_AUTORANK(11204,20) was refused
 * against a row reading SP_AUTORANK, and a second campaign needed a second row
 * for SP_AUTORANK(11058,20). Matching on the identity — everything before the
 * "(" — means one row per PROCEDURE covers every campaign.
 *
 * The case that matters most is the LAST one: identity is compared whole, so
 * SP_AUTORANK must not admit SP_AUTORANK_V2. A prefix match here would be a
 * real hole rather than an inconvenience.
 */
import { buildAllowlistCheckSql, procIdentity } from "../../lib/hll-proc-allowlist"
import { QUALIFIED_PROC } from "../../app/api/hll-procedures/route"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES"
const escape = (s: string) => s.replace(/'/g, "''")
const sql = (proc: string) => buildAllowlistCheckSql(TABLE, proc, escape)

/**
 * What Snowflake would answer, evaluated here instead.
 *
 * Mirrors UPPER(TRIM(SPLIT_PART(PROC_NAME, '(', 1))) = UPPER('<identity>')
 * against a set of stored rows — including SPLIT_PART's behaviour of returning
 * the whole string when the delimiter is absent, which is the property the bare
 * rows depend on.
 */
function matches(storedRows: string[], proc: string): boolean {
  const target = procIdentity(proc).toUpperCase()
  return storedRows.some((row) => row.split("(")[0].trim().toUpperCase() === target)
}

console.log("procIdentity")
{
  check("strips an argument list", procIdentity("A.B.SP_X(11204,20)") === "A.B.SP_X")
  check("strips an empty argument list", procIdentity("A.B.SP_X()") === "A.B.SP_X")
  check("leaves a bare name alone", procIdentity("A.B.SP_X") === "A.B.SP_X")
  check("trims the space before the parens", procIdentity("A.B.SP_X (1)") === "A.B.SP_X")
}

console.log("\nthe matches the old exact check got wrong")
{
  // The error that started this: an empty argument list against a bare row.
  const rows = ["DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD"]
  check("SP_MTN_SAVE_POST_LOAD() matches a bare row",
    matches(rows, "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()"))
}
{
  // The reason this recurred on every campaign.
  const rows = ["DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK"]
  check("SP_AUTORANK(11204,20) matches a bare row",
    matches(rows, "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11204,20)"))
}
{
  // One campaign's arguments must not shut another campaign out.
  const rows = ["DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11058,20)"]
  check("another campaign's stored arguments still match",
    matches(rows, "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11204,20)"))
}
{
  // Unquoted Snowflake identifiers are case-insensitive, so a lowercase
  // override was being refused for a CALL that would have worked.
  const rows = ["DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK"]
  check("a lowercase override matches an uppercase row",
    matches(rows, "datawarehouse.distribution_data_application.sp_autorank(11204,20)"))
}

console.log("\nand the matches it must still refuse")
{
  const rows = ["DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK"]
  // THE ONE THAT WOULD BE A REAL HOLE. Identity is compared whole, not by prefix.
  check("SP_AUTORANK does NOT admit SP_AUTORANK_V2",
    !matches(rows, "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK_V2(11204,20)"))
  check("nor a different schema",
    !matches(rows, "DATAWAREHOUSE.DISTRIBUTION.SP_AUTORANK(11204,20)"))
  check("nor a different database",
    !matches(rows, "OTHER.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11204,20)"))
  check("nor an unlisted procedure", !matches(rows, "DATAWAREHOUSE.DISTRIBUTION.SP_NOT_REAL"))
  check("nor anything at all when the table is empty",
    !matches([], "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK"))
}

console.log("\nthe generated SQL")
{
  const s = sql("DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()")
  check("names the allowlist table", s.includes(TABLE))
  check("counts rather than selects rows", /^\s*SELECT COUNT\(1\) AS CNT/.test(s))
  check("compares identity, not the call string",
    s.includes("SPLIT_PART(PROC_NAME, '(', 1)") && !s.includes("SP_MTN_SAVE_POST_LOAD()"), s)
  check("is case-insensitive on both sides",
    s.includes("UPPER(TRIM(SPLIT_PART") && s.includes("= UPPER('"), s)
  check("reads only — no INSERT, UPDATE, DELETE or CALL",
    !/\b(INSERT|UPDATE|DELETE|CALL|MERGE)\b/i.test(s), s)
}
{
  // Defence in depth. QUALIFIED_PROC rejects a quote long before this builder
  // is reached — but if that ever loosened, the escaping must still hold.
  const nasty = "A.B.SP_X'); DROP TABLE T; --"
  check("QUALIFIED_PROC rejects a quoted name outright", !QUALIFIED_PROC.test(nasty))
  const s = sql(nasty)
  check("and the builder doubles the quote anyway", s.includes("SP_X'')"), s)
  check("so no bare quote closes the literal early",
    (s.match(/'/g) || []).length % 2 === 0, s)
}
{
  // The four MTN Save procedures against the rows 02-hll-procedure-allowlist.sql
  // inserts. This is the end-to-end shape of the fix.
  const rows = [
    "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE",
  ]
  const configured = [
    "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE(11204)",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11204,20)",
    "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE(11204)",
  ]
  check("all four MTN Save procedures are accepted as overrides",
    configured.every((p) => matches(rows, p)),
    configured.filter((p) => !matches(rows, p)).join(", "))
  check("and all four pass QUALIFIED_PROC first",
    configured.every((p) => QUALIFIED_PROC.test(p)),
    configured.filter((p) => !QUALIFIED_PROC.test(p)).join(", "))
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
