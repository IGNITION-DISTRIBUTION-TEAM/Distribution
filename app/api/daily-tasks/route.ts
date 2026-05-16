import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_DAILY_TASKS"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export type DailyTaskRow = {
  TASK_INDEX: number | string
  TASK_NAME: string
  CREATED_AT: string | null
}

export function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

export function validateTaskName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "taskName must be a string" }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { error: "taskName is required" }
  if (trimmed.length > 200) return { error: "taskName is too long (max 200 chars)" }
  return trimmed
}

export function validateTaskIndex(raw: unknown): number | { error: string } {
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10)
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    return { error: "taskIndex must be a non-negative integer" }
  }
  return n
}

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<DailyTaskRow>(
      `SELECT TASK_INDEX, TASK_NAME, CREATED_AT FROM ${TABLE} ORDER BY TASK_INDEX`,
      SF_OPTS
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: { taskIndex?: unknown; taskName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const idx = validateTaskIndex(body.taskIndex)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  const name = validateTaskName(body.taskName)
  if (typeof name !== "string") return NextResponse.json(name, { status: 400 })

  try {
    await executeSnowflakeQuery(
      `INSERT INTO ${TABLE} (TASK_INDEX, TASK_NAME) VALUES (${idx}, '${escapeSqlString(name)}')`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true, taskIndex: idx, taskName: name })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
