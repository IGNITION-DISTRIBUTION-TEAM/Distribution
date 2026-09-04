import { NextRequest, NextResponse } from "next/server"
import {
  executeSnowflakeQuery,
  submitSnowflakeStatementAsync,
  getSnowflakeStatementStatus,
} from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { objectNames } from "@/lib/sftp-sync-codegen"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Run a generated sync, or change its task's state.
 *
 *   POST { action: "run",    db, schema, syncName }  -> { handle } , poll with GET
 *   POST { action: "resume" | "suspend" | "status", ... } -> immediate
 *
 * A run is SUBMITTED and polled rather than awaited: it downloads files, and a
 * backlog can outlast an HTTP request. The same submit-and-poll the Distribution
 * step runner uses.
 *
 * Resume is deliberately a separate action from deploy. The standards document
 * is explicit that a task is reviewed before it is allowed to run on a
 * schedule, so nothing here resumes anything as a side effect.
 */
const IDENT = /^[A-Za-z0-9_]+$/

function parts(body: { db?: unknown; schema?: unknown; syncName?: unknown }) {
  const db = String(body.db ?? "").trim().toUpperCase()
  const schema = String(body.schema ?? "").trim().toUpperCase()
  const sync = String(body.syncName ?? "").trim().toUpperCase()
  for (const [v, what] of [[db, "database"], [schema, "schema"], [sync, "sync name"]] as const) {
    if (!IDENT.test(v)) throw new Error(`Invalid ${what}: ${JSON.stringify(v)}`)
  }
  const o = objectNames(sync)
  return { db, schema, proc: `${db}.${schema}.${o.proc}`, task: `${db}.${schema}.${o.task}`, sourceName: o.sourceName }
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: { action?: unknown; db?: unknown; schema?: unknown; syncName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  let p: ReturnType<typeof parts>
  try {
    p = parts(body)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
  const action = String(body.action ?? "").trim().toLowerCase()
  const sf = { database: p.db, schema: p.schema }

  try {
    if (action === "run") {
      const handle = await submitSnowflakeStatementAsync(`CALL ${p.proc}()`, sf)
      return NextResponse.json({ handle, ran: `CALL ${p.proc}()` })
    }

    if (action === "resume" || action === "suspend") {
      const verb = action === "resume" ? "RESUME" : "SUSPEND"
      await executeSnowflakeQuery(`ALTER TASK ${p.task} ${verb}`, sf)
      return NextResponse.json({ ok: true, task: p.task, state: verb })
    }

    if (action === "status") {
      // SHOW TASKS, then the control row. Two different questions: is the
      // schedule armed, and did the last run do anything.
      let taskState: string | null = null
      try {
        const rows = await executeSnowflakeQuery<Record<string, unknown>>(
          `SHOW TASKS LIKE '${objectNames(String(body.syncName)).task}' IN SCHEMA ${p.db}.${p.schema}`,
          sf
        )
        const r = rows[0]
        const key = r && Object.keys(r).find((k) => k.toLowerCase() === "state")
        taskState = key && r ? String(r[key]) : null
      } catch {
        // A missing task is a legitimate answer here, not a failure: the sync
        // may simply not be deployed yet.
        taskState = null
      }

      const control = await executeSnowflakeQuery<Record<string, unknown>>(
        // TO_VARCHAR: executeSnowflakeQuery returns Snowflake's raw wire values,
        // so without this the wizard's "Last synced" tile shows an epoch.
        `SELECT SOURCE_NAME,
                TO_VARCHAR(LAST_MODIFIED, 'YYYY-MM-DD HH24:MI:SS') AS LAST_MODIFIED,
                TO_VARCHAR(LAST_SYNCED,   'YYYY-MM-DD HH24:MI:SS') AS LAST_SYNCED,
                ROW_COUNT, STATUS
           FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
          WHERE SOURCE_NAME = '${p.sourceName.replace(/'/g, "''")}'`,
        { database: "DATAWAREHOUSE", schema: "DW" }
      )
      return NextResponse.json({ taskState, control: control[0] ?? null })
    }

    return NextResponse.json({ error: `Unknown action: ${action || "(none)"}` }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/run] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Poll a submitted run. Returns the procedure's own message when it finishes. */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  const handle = request.nextUrl.searchParams.get("handle")
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 })
  try {
    // getSnowflakeStatementStatus returns `result` — the CALL's return value,
    // which for these procedures is the SUCCESS / NO_CHANGE / FAILED line.
    return NextResponse.json(await getSnowflakeStatementStatus(handle))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}
