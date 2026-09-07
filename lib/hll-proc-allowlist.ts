/**
 * The update-HLL procedure allowlist check, as SQL.
 *
 * PURE, NO I/O — the table name and the escaper are passed in, so this module
 * imports nothing from a route and a test can load it without pulling in
 * `next/server`. Same split as the other SQL builders in lib/.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 *
 * TSK_HLL_UPDATE_PROCEDURES is checked on ONE path: the free-text override box
 * on Tools → Update HLL, which is the only place a procedure name arrives from
 * the browser. A procedure that came from the campaign's saved config is not
 * checked against it, because:
 *
 *   - saving that config already validates every entry with the same regex
 *     (RUN_PROC_IDENT in app/api/campaign-configs/route.ts) behind the same
 *     Distribution-access guard, and
 *   - the campaign's own step 4 runs it through buildStepSql
 *     (lib/distribution-steps.ts), which has never consulted this table.
 *
 * So requiring a row for a configured procedure gated the WEAKER path and
 * nothing else. It is what rejected SP_MTN_SAVE_POST_LOAD() from a screen while
 * step 4 would have run the identical procedure unchecked.
 *
 * -----------------------------------------------------------------------------
 * WHY IDENTITY AND NOT THE WHOLE CALL STRING
 *
 * The check used to be `WHERE PROC_NAME = '<proc>'` — exact. Config entries
 * carry their arguments, so `SP_AUTORANK(11204,20)` did not match a row reading
 * `SP_AUTORANK`, and a second campaign needed a second row for
 * `SP_AUTORANK(11058,20)`. The table filled up with the same few procedures
 * under different arguments, and every new campaign hit the same wall.
 *
 * Matching on the identity — everything before the "(" — means one row per
 * PROCEDURE covers every campaign. Nothing is lost: the arguments were never
 * really vetted here. QUALIFIED_PROC restricts them to
 * `[A-Za-z0-9_,\s]` before this check runs, so they cannot carry a quote or a
 * semicolon, and the campaign id in the call is the caller's own request
 * parameter either way.
 */

/** Everything before the argument list. `A.B.SP_X(1,2)` → `A.B.SP_X`. */
export function procIdentity(proc: string): string {
  return proc.split("(")[0].trim()
}

/**
 * Count the allowlist rows naming this procedure, whatever arguments either
 * side carries.
 *
 * Two details do the work:
 *
 *  - SPLIT_PART returns the WHOLE string when the delimiter is absent, so a row
 *    stored bare and a row stored with arguments both reduce to the same
 *    identity. Exact equality becomes a special case rather than a separate
 *    branch.
 *  - UPPER on both sides, because an unquoted Snowflake identifier is
 *    case-insensitive. A lowercase override used to be refused against an
 *    uppercase row even though the CALL it was refused for would have worked.
 *
 * `proc` must already have passed QUALIFIED_PROC. `escape` is the caller's
 * quote-doubling escaper — passed in rather than reimplemented, since this
 * repo already carries some 45 copies of that one-liner.
 */
export function buildAllowlistCheckSql(
  table: string,
  proc: string,
  escape: (s: string) => string
): string {
  return (
    `SELECT COUNT(1) AS CNT FROM ${table}\n` +
    ` WHERE UPPER(TRIM(SPLIT_PART(PROC_NAME, '(', 1))) = UPPER('${escape(procIdentity(proc))}')`
  )
}
