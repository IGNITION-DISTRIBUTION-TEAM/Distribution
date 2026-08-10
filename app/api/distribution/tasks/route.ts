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
// Which campaign procedure(s) a task runs. "full" runs every configured proc in
// order (load history → update HLL → sync). Maps to columns on the campaign
// config table (TSK_CAMPAIGN_AUTOMATION_CONFIG).
export const PROC_KINDS = ["none", "load_history", "update_hll", "sync", "full"] as const
export function normProcKind(raw: unknown): string {
  const s = String(raw ?? "").trim()
  return (PROC_KINDS as readonly string[]).includes(s) ? s : "none"
}

// Lead-source → HLL model: a task's source is either a stored proc (which fills
// a table we then read) or a view (read directly), mapped into the HLL table.
export const SOURCE_KINDS = ["none", "proc", "view"] as const
export function normSourceKind(raw: unknown): string {
  const s = String(raw ?? "").trim()
  return (SOURCE_KINDS as readonly string[]).includes(s) ? s : "none"
}
export const IDENT_COL = /^[A-Za-z0-9_]+$/
// A standalone procedure reference: DATABASE.SCHEMA.PROC with optional (args).
export const STANDALONE_PROC_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\s*\([A-Za-z0-9_,\s']*\))?$/
export function validateStandaloneProc(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) return null
  return STANDALONE_PROC_IDENT.test(s) ? s : null
}
// Validate a { hllColumn: sourceColumn } mapping; returns a JSON string or null.
export function validateMapping(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object") return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const src = typeof v === "string" ? v.trim() : ""
    if (!src) continue
    if (!IDENT_COL.test(k) || !IDENT_COL.test(src)) continue
    out[k] = src
  }
  const keys = Object.keys(out)
  if (keys.length === 0) return null
  if (keys.length > 500) return null
  return JSON.stringify(out)
}

export type TaskRow = {
  ID: number | string
  NAME: string
  DESCRIPTION: string | null
  TASK_TYPE: string
  TARGET: string | null
  STATUS: string
  SCHEDULE: string | null
  CAMPAIGN_ID: string | null
  CAMPAIGN_TITLE: string | null
  PROC_KIND: string | null
  SOURCE_KIND: string | null
  SOURCE_OBJECT: string | null
  SOURCE_TABLE: string | null
  MAPPING_JSON: string | null
  STANDALONE_PROC: string | null
  LAST_RUN_AT: string | null
  LAST_RUN_STATUS: string | null
  LAST_RUN_MESSAGE: string | null
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
       CAMPAIGN_ID VARCHAR, CAMPAIGN_TITLE VARCHAR, PROC_KIND VARCHAR,
       SOURCE_KIND VARCHAR, SOURCE_OBJECT VARCHAR, SOURCE_TABLE VARCHAR, MAPPING_JSON VARCHAR,
       STANDALONE_PROC VARCHAR,
       LAST_RUN_AT TIMESTAMP_NTZ, LAST_RUN_STATUS VARCHAR, LAST_RUN_MESSAGE VARCHAR,
       CREATED_BY VARCHAR,
       CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
       UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
     )`,
    SF_OPTS
  )
  // Upgrade tables created before the campaign/run columns existed.
  const addCols = [
    "CAMPAIGN_ID VARCHAR", "CAMPAIGN_TITLE VARCHAR", "PROC_KIND VARCHAR",
    "SOURCE_KIND VARCHAR", "SOURCE_OBJECT VARCHAR", "SOURCE_TABLE VARCHAR", "MAPPING_JSON VARCHAR",
    "STANDALONE_PROC VARCHAR",
    "LAST_RUN_AT TIMESTAMP_NTZ", "LAST_RUN_STATUS VARCHAR", "LAST_RUN_MESSAGE VARCHAR",
  ]
  for (const col of addCols) {
    try {
      await executeSnowflakeQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${col}`, SF_OPTS)
    } catch {
      /* column already present on older Snowflake without IF NOT EXISTS support */
    }
  }
}

// GET — list all tasks, newest first.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  try {
    await ensureTable()
    const rows = await executeSnowflakeQuery<TaskRow>(
      `SELECT ID, NAME, DESCRIPTION, TASK_TYPE, TARGET, STATUS, SCHEDULE,
              CAMPAIGN_ID, CAMPAIGN_TITLE, PROC_KIND,
              SOURCE_KIND, SOURCE_OBJECT, SOURCE_TABLE, MAPPING_JSON, STANDALONE_PROC,
              TO_VARCHAR(LAST_RUN_AT, 'YYYY-MM-DD HH24:MI') AS LAST_RUN_AT,
              LAST_RUN_STATUS, LAST_RUN_MESSAGE, CREATED_BY,
              TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI') AS CREATED_AT,
              TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD HH24:MI') AS UPDATED_AT
       FROM ${TABLE} ORDER BY ID DESC`,
      SF_OPTS
    )
    return NextResponse.json({ rows, types: TASK_TYPES, statuses: TASK_STATUSES, procKinds: PROC_KINDS })
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

  const standaloneProc = validateStandaloneProc(body.standaloneProc)
  if (body.standaloneProc && !standaloneProc) {
    return NextResponse.json({ error: 'Standalone procedure must be "DATABASE.SCHEMA.PROC" with optional (args)' }, { status: 400 })
  }

  try {
    await ensureTable()
    const mapping = validateMapping(body.mapping)
    await executeSnowflakeQuery(
      `INSERT INTO ${TABLE} (NAME, DESCRIPTION, TASK_TYPE, TARGET, STATUS, SCHEDULE, CAMPAIGN_ID, CAMPAIGN_TITLE, PROC_KIND,
                             SOURCE_KIND, SOURCE_OBJECT, SOURCE_TABLE, MAPPING_JSON, STANDALONE_PROC, CREATED_BY)
       VALUES (${sqlStr(name)}, ${sqlNullable(body.description)}, ${sqlStr(normType(body.type))},
               ${sqlNullable(body.target)}, ${sqlStr(normStatus(body.status))}, ${sqlNullable(body.schedule)},
               ${sqlNullable(body.campaignId)}, ${sqlNullable(body.campaignTitle)}, ${sqlStr(normProcKind(body.procKind))},
               ${sqlStr(normSourceKind(body.sourceKind))}, ${sqlNullable(body.sourceObject)}, ${sqlNullable(body.sourceTable)},
               ${mapping ? sqlStr(mapping) : "NULL"}, ${standaloneProc ? sqlStr(standaloneProc) : "NULL"}, ${sqlStr(guard.email)})`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/tasks POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
