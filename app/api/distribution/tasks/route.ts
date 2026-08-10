import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Automation / distribution tasks, persisted in Snowflake. Backs the Automation
// tab's create / track / edit UI.
export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_AUTOMATION_TASKS"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export const TASK_TYPES = ["CRM", "Dialling", "Custom"] as const
export const TASK_STATUSES = ["Draft", "Active", "Paused", "Completed"] as const

export type TaskRow = {
  ID: number | string
  NAME: string
  DESCRIPTION: string | null
  TASK_TYPE: string
  TARGET: string | null
  STATUS: string
  SCHEDULE: string | null
  CREATED_BY: string | null
  CREATED_AT: string | null
  UPDATED_AT: string | null
}

export function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}
export function sqlNullable(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : ""
  return s ? sqlStr(s) : "NULL"
}

export function validateName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "name must be a string" }
  const t = raw.trim()
  if (!t) return { error: "name is required" }
  if (t.length > 200) return { error: "name is too long (max 200)" }
  return t
}
export function normType(raw: unknown): string {
  const s = String(raw ?? "").trim()
  return (TASK_TYPES as readonly string[]).includes(s) ? s : "Custom"
}
export function normStatus(raw: unknown): string {
  const s = String(raw ?? "").trim()
  return (TASK_STATUSES as readonly string[]).includes(s) ? s : "Draft"
}

export async function ensureTable(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       ID NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       NAME VARCHAR, DESCRIPTION VARCHAR, TASK_TYPE VARCHAR, TARGET VARCHAR,
       STATUS VARCHAR, SCHEDULE VARCHAR,
       CREATED_BY VARCHAR,
       CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
       UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
     )`,
    SF_OPTS
  )
}

// GET — list all tasks, newest first.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  try {
    await ensureTable()
    const rows = await executeSnowflakeQuery<TaskRow>(
      `SELECT ID, NAME, DESCRIPTION, TASK_TYPE, TARGET, STATUS, SCHEDULE, CREATED_BY,
              TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI') AS CREATED_AT,
              TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD HH24:MI') AS UPDATED_AT
       FROM ${TABLE} ORDER BY ID DESC`,
      SF_OPTS
    )
    return NextResponse.json({ rows, types: TASK_TYPES, statuses: TASK_STATUSES })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/tasks GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST — create a task.
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const name = validateName(body.name)
  if (typeof name !== "string") return NextResponse.json(name, { status: 400 })

  try {
    await ensureTable()
    await executeSnowflakeQuery(
      `INSERT INTO ${TABLE} (NAME, DESCRIPTION, TASK_TYPE, TARGET, STATUS, SCHEDULE, CREATED_BY)
       VALUES (${sqlStr(name)}, ${sqlNullable(body.description)}, ${sqlStr(normType(body.type))},
               ${sqlNullable(body.target)}, ${sqlStr(normStatus(body.status))}, ${sqlNullable(body.schedule)},
               ${sqlStr(guard.email)})`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/tasks POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
