import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_DIALER_AUTOMATION_TABLES"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export type DiallerTableRow = {
  TABLE_INDEX: number | string
  TABLE_NAME: string
  CREATED_AT: string | null
}

export function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

export function validateTableName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "tableName must be a string" }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { error: "tableName is required" }
  if (trimmed.length > 500) return { error: "tableName is too long (max 500 chars)" }
  return trimmed
}

export function validateTableIndex(raw: unknown): number | { error: string } {
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10)
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    return { error: "tableIndex must be a non-negative integer" }
  }
  return n
}

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<DiallerTableRow>(
      `SELECT TABLE_INDEX, TABLE_NAME, CREATED_AT FROM ${TABLE} ORDER BY TABLE_INDEX`,
      SF_OPTS
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler-tables GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: { tableIndex?: unknown; tableName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const idx = validateTableIndex(body.tableIndex)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  const name = validateTableName(body.tableName)
  if (typeof name !== "string") return NextResponse.json(name, { status: 400 })

  try {
    await executeSnowflakeQuery(
      `INSERT INTO ${TABLE} (TABLE_INDEX, TABLE_NAME) VALUES (${idx}, '${escapeSqlString(name)}')`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true, tableIndex: idx, tableName: name })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler-tables POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
