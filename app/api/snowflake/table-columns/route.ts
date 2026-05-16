import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const SAFE_IDENT = /^[A-Z0-9_]+$/i

type Body = { table?: unknown }

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const tableRaw = typeof body.table === "string" ? body.table.trim() : ""
  if (!tableRaw) {
    return NextResponse.json({ error: "table required (DATABASE.SCHEMA.NAME)" }, { status: 400 })
  }

  const parts = tableRaw.split(".")
  if (parts.length !== 3 || parts.some((p) => !SAFE_IDENT.test(p))) {
    return NextResponse.json(
      { error: 'table must be "DATABASE.SCHEMA.NAME" using A-Z, 0-9, _ only' },
      { status: 400 }
    )
  }
  const [database, schema, name] = parts.map((p) => p.toUpperCase())

  try {
    const columns = await executeSnowflakeQuery<{
      COLUMN_NAME: string
      DATA_TYPE: string
      IS_NULLABLE: "YES" | "NO"
      COLUMN_DEFAULT: string | null
    }>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM ${database}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${name}'
       ORDER BY ORDINAL_POSITION`,
      { database, schema }
    )
    if (columns.length === 0) {
      return NextResponse.json(
        { error: `Table ${database}.${schema}.${name} not found or not visible to the role` },
        { status: 404 }
      )
    }
    return NextResponse.json({ table: `${database}.${schema}.${name}`, columns })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
