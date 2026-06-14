import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// Fully-qualified DATABASE.SCHEMA.PROC.
export const QUALIFIED_PROC = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

export type HllProcRow = {
  PROC_INDEX: number | string
  PROC_NAME: string
  CREATED_AT: string | null
}

export function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

export function validateProcName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "procName must be a string" }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { error: "procName is required" }
  if (!QUALIFIED_PROC.test(trimmed)) {
    return { error: 'procName must be "DATABASE.SCHEMA.PROC" (A-Z, 0-9, _ only)' }
  }
  return trimmed
}

export function validateProcIndex(raw: unknown): number | { error: string } {
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10)
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    return { error: "procIndex must be a non-negative integer" }
  }
  return n
}

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<HllProcRow>(
      `SELECT PROC_INDEX, PROC_NAME, CREATED_AT FROM ${TABLE} ORDER BY PROC_INDEX`,
      SF_OPTS
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/hll-procedures GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: { procIndex?: unknown; procName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const idx = validateProcIndex(body.procIndex)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  const name = validateProcName(body.procName)
  if (typeof name !== "string") return NextResponse.json(name, { status: 400 })

  try {
    await executeSnowflakeQuery(
      `INSERT INTO ${TABLE} (PROC_INDEX, PROC_NAME) VALUES (${idx}, '${escapeSqlString(name)}')`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true, procIndex: idx, procName: name })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/hll-procedures POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
