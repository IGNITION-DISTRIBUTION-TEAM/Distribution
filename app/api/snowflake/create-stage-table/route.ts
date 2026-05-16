import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const SAFE_IDENT = /^[A-Z0-9_]+$/i
const ALLOWED_TYPES = new Set([
  "VARCHAR",
  "VARCHAR(500)",
  "VARCHAR(1000)",
  "VARCHAR(4000)",
  "TEXT",
  "STRING",
  "NUMBER",
  "NUMBER(38,0)",
  "FLOAT",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP_NTZ",
  "TIMESTAMP_LTZ",
])

type ColumnSpec = { name: string; type: string; nullable?: boolean }
type Body = { table?: unknown; columns?: unknown }

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const tableRaw = typeof body.table === "string" ? body.table.trim() : ""
  const parts = tableRaw.split(".")
  if (parts.length !== 3 || parts.some((p) => !SAFE_IDENT.test(p))) {
    return NextResponse.json(
      { error: 'table must be "DATABASE.SCHEMA.NAME" using A-Z, 0-9, _ only' },
      { status: 400 }
    )
  }
  const [database, schema, name] = parts.map((p) => p.toUpperCase())

  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return NextResponse.json({ error: "columns must be a non-empty array" }, { status: 400 })
  }
  if (body.columns.length > 200) {
    return NextResponse.json({ error: "Max 200 columns" }, { status: 400 })
  }

  const seen = new Set<string>()
  const cleanCols: ColumnSpec[] = []
  for (const raw of body.columns as unknown[]) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "Each column must be an object" }, { status: 400 })
    }
    const c = raw as Record<string, unknown>
    const colName = typeof c.name === "string" ? c.name.trim().toUpperCase() : ""
    const colType = typeof c.type === "string" ? c.type.trim().toUpperCase() : ""
    if (!SAFE_IDENT.test(colName)) {
      return NextResponse.json(
        { error: `Invalid column name "${colName}" — use A-Z, 0-9, _` },
        { status: 400 }
      )
    }
    if (!ALLOWED_TYPES.has(colType)) {
      return NextResponse.json(
        {
          error: `Type "${colType}" not allowed. Allowed: ${Array.from(ALLOWED_TYPES).join(", ")}`,
        },
        { status: 400 }
      )
    }
    if (seen.has(colName)) {
      return NextResponse.json(
        { error: `Duplicate column name: ${colName}` },
        { status: 400 }
      )
    }
    seen.add(colName)
    cleanCols.push({ name: colName, type: colType, nullable: c.nullable !== false })
  }

  const colDefs = cleanCols
    .map((c) => `${c.name} ${c.type}${c.nullable === false ? " NOT NULL" : ""}`)
    .join(",\n  ")

  const sql = `CREATE TABLE ${database}.${schema}.${name} (\n  ${colDefs},\n  CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()\n)`

  try {
    await executeSnowflakeQuery(sql, { database, schema })
    return NextResponse.json({
      ok: true,
      table: `${database}.${schema}.${name}`,
      columns: cleanCols.length,
      sql,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/snowflake/create-stage-table] error:", message)
    return NextResponse.json({ error: message, sql }, { status: 500 })
  }
}
