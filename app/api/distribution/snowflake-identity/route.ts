import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * What Snowflake session does the APP run as, and can it see a given object?
 *
 * Snowflake answers "Unknown user-defined function" both when a procedure is
 * absent and when the role simply has no USAGE on it — deliberately, so a
 * missing grant cannot be used to probe for objects. That makes a statement that
 * works in a worksheet and fails in the app almost impossible to explain from
 * the error alone: the two sessions run as different roles, and only one of them
 * is visible to the person debugging.
 *
 * This runs the lookup THROUGH the app's own connection, so the answer is about
 * the session that actually failed.
 *
 *   GET /api/distribution/snowflake-identity
 *   GET /api/distribution/snowflake-identity?object=DB.SCHEMA.PROC_NAME
 *
 * Only role/user/warehouse names and object metadata are returned — never
 * credentials, and never the key.
 */

// DATABASE.SCHEMA.NAME, letters/digits/underscore. Any argument list is
// stripped before use: SHOW PROCEDURES matches on the bare name.
const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

/** Read a column from a SHOW result, which returns lower-case names. */
function pick(row: Record<string, unknown>, name: string): string | null {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase())
  const v = hit ? row[hit] : undefined
  return v == null ? null : String(v)
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const out: Record<string, unknown> = {}

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT CURRENT_ROLE() AS ROLE, CURRENT_USER() AS USR,
              CURRENT_WAREHOUSE() AS WH, CURRENT_DATABASE() AS DB, CURRENT_SCHEMA() AS SCH`
    )
    const r = rows[0] ?? {}
    out.session = {
      role: pick(r, "ROLE"),
      user: pick(r, "USR"),
      warehouse: pick(r, "WH"),
      database: pick(r, "DB"),
      schema: pick(r, "SCH"),
    }
  } catch (error) {
    out.session = { error: error instanceof Error ? error.message : String(error) }
  }

  const raw = (request.nextUrl.searchParams.get("object") ?? "").trim()
  if (!raw) return NextResponse.json(out)

  // Accept the value straight from the config field, argument list and all.
  const ref = raw.split("(")[0].trim()
  if (!QUALIFIED.test(ref)) {
    return NextResponse.json({ ...out, object: { error: `Not a DATABASE.SCHEMA.NAME: ${raw}` } })
  }
  const [db, schema, name] = ref.split(".")

  try {
    // SHOW, not INFORMATION_SCHEMA: this returns only what the app's role can
    // reach, which is precisely the question. An empty result with the object
    // present in the account IS the grants answer.
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SHOW PROCEDURES LIKE '${name.replace(/'/g, "''")}' IN SCHEMA ${db}.${schema}`,
      { database: db, schema }
    )
    const found = rows.map((r) => ({
      name: pick(r, "name"),
      schema: pick(r, "schema_name"),
      // "(NUMBER) RETURN VARCHAR" — the part before RETURN is the signature the
      // CALL has to match, argument for argument.
      arguments: pick(r, "arguments"),
    }))
    out.object = {
      ref,
      visibleToApp: found.length > 0,
      found,
      note:
        found.length > 0
          ? "The app's role can see it. Check the argument list against `arguments` above."
          : "The app's role cannot see it. Either it does not exist, or the role has no USAGE on it — run the same SHOW as ACCOUNTADMIN to tell those apart.",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    out.object = { ref, visibleToApp: false, error: message }
  }

  return NextResponse.json(out)
}
