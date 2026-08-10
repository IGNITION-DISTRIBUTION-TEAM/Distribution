import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
export const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

type Col = { name: string; type: string }

// Find a value in a row object by a case-insensitive key match (SHOW COLUMNS
// returns lower-cased column names; INFORMATION_SCHEMA selects come back upper).
function pick(row: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase())
  return hit ? row[hit] : undefined
}

// GET ?object=DB.SCHEMA.NAME (table or view) → its columns (metadata only —
// never reads the object's rows). Pass object=hll for the fixed HLL target.
// Powers the mapping UI.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  let object = (request.nextUrl.searchParams.get("object") ?? "").trim()
  if (object.toLowerCase() === "hll") object = HLL_TABLE
  if (!QUALIFIED.test(object)) {
    return NextResponse.json({ error: "object must be DATABASE.SCHEMA.NAME" }, { status: 400 })
  }
  const [db, schema, name] = object.split(".")

  // 1. Primary: INFORMATION_SCHEMA.COLUMNS (fast, purely metadata).
  try {
    const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}' AND TABLE_NAME = '${name.replace(/'/g, "''")}'
       ORDER BY ORDINAL_POSITION`,
      { database: db, schema }
    )
    if (rows.length) {
      return NextResponse.json({ object, columns: rows.map((r) => ({ name: r.COLUMN_NAME, type: r.DATA_TYPE })) })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }

  // 2. Empty from INFORMATION_SCHEMA — could be a missing grant, a name typo,
  //    or an object created lazily by a proc. SHOW COLUMNS distinguishes these:
  //    it lists the columns if visible, or errors "does not exist or not
  //    authorized" — a far clearer signal than a silent empty result.
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SHOW COLUMNS IN ${object}`,
      { database: db, schema }
    )
    const columns: Col[] = rows
      .map((r) => {
        const raw = pick(r, "data_type")
        let type = typeof raw === "string" ? raw : ""
        try {
          const parsed = JSON.parse(String(raw))
          if (parsed && typeof parsed.type === "string") type = parsed.type
        } catch { /* data_type wasn't JSON — keep the raw string */ }
        return { name: String(pick(r, "column_name") ?? ""), type }
      })
      .filter((c) => c.name)
    if (columns.length) return NextResponse.json({ object, columns })
    return NextResponse.json({ object, columns: [], note: "The object has no columns, or none are visible to this role." })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Surface the real Snowflake reason (typically "does not exist or not authorized").
    return NextResponse.json(
      { error: `Couldn't read columns for ${object}: ${message}. Check the name and that this app's Snowflake role has access.` },
      { status: 200 }
    )
  }
}
