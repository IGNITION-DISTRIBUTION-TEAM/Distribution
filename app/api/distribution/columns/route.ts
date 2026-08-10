import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
export const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

// GET ?object=DB.SCHEMA.NAME (table or view) → its columns, from
// INFORMATION_SCHEMA (metadata only — never reads the object's rows). Pass
// object=hll for the fixed HLL target. Powers the mapping UI.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  let object = (request.nextUrl.searchParams.get("object") ?? "").trim()
  if (object.toLowerCase() === "hll") object = HLL_TABLE
  if (!QUALIFIED.test(object)) {
    return NextResponse.json({ error: "object must be DATABASE.SCHEMA.NAME" }, { status: 400 })
  }
  const [db, schema, name] = object.split(".")
  try {
    const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}' AND TABLE_NAME = '${name.replace(/'/g, "''")}'
       ORDER BY ORDINAL_POSITION`,
      { database: db, schema }
    )
    return NextResponse.json({ object, columns: rows.map((r) => ({ name: r.COLUMN_NAME, type: r.DATA_TYPE })) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }
}
