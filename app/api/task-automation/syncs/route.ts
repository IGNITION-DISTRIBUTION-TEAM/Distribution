import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  listSyncs,
  forgetSync,
  checkTargets,
  statusBlamesMissingTarget,
  type TargetHealth,
  consecutiveFailures,
  CONFIGS_TABLE,
  REGISTRY_SF,
} from "@/lib/sftp-sync-registry"
import { objectNames } from "@/lib/sftp-sync-codegen"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * The syncs this app knows about, with their live state.
 *
 *   GET                    -> { syncs: [...] }
 *   DELETE ?name=SYNC_NAME -> forget the registry row
 *
 * Three sources, deliberately kept distinguishable rather than merged into one
 * confident-looking list:
 *
 *   the registry            what the app deployed, and its configuration
 *   SHOW TASKS              whether a schedule exists and whether it is armed
 *   SFTP_SYNC_CONTROL       what the last run did — including for syncs the app
 *                           did not create, which is the only way Justin's
 *                           hand-built ones appear at all
 *
 * SHOW TASKS returns only tasks the app's role owns, so a sync of someone
 * else's shows up from its control row with no schedule. That is reported as
 * "not visible to this app", not as "suspended".
 */
const TASK_SCHEMA = { database: "SPOT_DW", schema: "SPOT_SFTP" } as const
const CONTROL = "DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL"
const IDENT = /^[A-Za-z0-9_]+$/

/** SHOW returns lower-case column names; find one case-insensitively. */
function pick(row: Record<string, unknown>, key: string): string | null {
  const k = Object.keys(row).find((c) => c.toLowerCase() === key.toLowerCase())
  return k && row[k] != null ? String(row[k]) : null
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  // ?names=1 returns just the registry's sync names. The wizard uses it to say
  // whether pressing the button will update a job or make a second one, so it
  // has to be cheap — one column, one table, no SHOW TASKS, no target checks.
  if (request.nextUrl.searchParams.get("names")) {
    try {
      const rows = await executeSnowflakeQuery<{ SYNC_NAME: unknown }>(
        `SELECT SYNC_NAME FROM ${CONFIGS_TABLE} ORDER BY SYNC_NAME`,
        REGISTRY_SF
      )
      return NextResponse.json({ names: rows.map((r) => String(r.SYNC_NAME ?? "")).filter(Boolean) })
    } catch (error) {
      // Not fatal: the wizard degrades to not knowing, and says so.
      return NextResponse.json(
        { names: [], error: error instanceof Error ? error.message : String(error) },
        { status: 200 }
      )
    }
  }

  // ?sql=NAME returns one job's deployed SQL, on demand. It is up to 60KB per
  // job, so it is deliberately not part of the list payload.
  const wantSql = (request.nextUrl.searchParams.get("sql") ?? "").trim().toUpperCase()
  if (wantSql) {
    if (!IDENT.test(wantSql)) {
      return NextResponse.json({ error: `Invalid sync name: ${JSON.stringify(wantSql)}` }, { status: 400 })
    }
    try {
      const rows = await executeSnowflakeQuery<{ DEPLOYED_SQL: unknown }>(
        `SELECT DEPLOYED_SQL FROM ${CONFIGS_TABLE} WHERE SYNC_NAME = '${wantSql}' LIMIT 1`,
        REGISTRY_SF
      )
      return NextResponse.json({ syncName: wantSql, sql: rows[0]?.DEPLOYED_SQL ?? null })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      )
    }
  }

  try {
    const registry = await listSyncs()

    // Both of these are informational: a failure must not blank the list.
    let tasks: Record<string, unknown>[] = []
    try {
      tasks = await executeSnowflakeQuery<Record<string, unknown>>(
        `SHOW TASKS LIKE 'TSK_SFTP_SYNC_%' IN SCHEMA SPOT_DW.SPOT_SFTP`,
        TASK_SCHEMA
      )
    } catch {
      tasks = []
    }
    let control: Record<string, unknown>[] = []
    try {
      control = await executeSnowflakeQuery<Record<string, unknown>>(
        // TO_VARCHAR so timestamps arrive readable rather than as Snowflake's
        // "<seconds>.<nanos>" wire form — executeSnowflakeQuery does not format.
        `SELECT SOURCE_NAME,
                TO_VARCHAR(LAST_MODIFIED, 'YYYY-MM-DD HH24:MI:SS') AS LAST_MODIFIED,
                TO_VARCHAR(LAST_SYNCED,   'YYYY-MM-DD HH24:MI:SS') AS LAST_SYNCED,
                ROW_COUNT, STATUS
           FROM ${CONTROL}`,
        { database: "DATAWAREHOUSE", schema: "DW" }
      )
    } catch {
      control = []
    }

    // Does each target table still exist? One query for the whole schema.
    // A sync whose table has been dropped deploys clean and then fails at its
    // scheduled hour, which is the least useful moment to find out.
    let health = new Map<string, TargetHealth>()
    try {
      health = await checkTargets(
        registry.map((r) => ({
          db: r.config.targetDb,
          schema: r.config.targetSchema,
          table: r.config.targetTable,
        }))
      )
    } catch {
      health = new Map()
    }
    // Live row count per distinct target, so a control row claiming rows into
    // an empty table is visible rather than inferred.
    const counts = new Map<string, number>()
    await Promise.all(
      [...new Set(registry.map((r) =>
        `${r.config.targetDb}.${r.config.targetSchema}.${r.config.targetTable}`.toUpperCase()
      ))].map(async (t) => {
        if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(t)) return
        const [db, sch] = t.split(".")
        try {
          const rows = await executeSnowflakeQuery<Record<string, unknown>>(
            `SELECT COUNT(*) AS N FROM ${t}`,
            { database: db, schema: sch }
          )
          counts.set(t, Number(Object.values(rows[0] ?? {})[0] ?? 0))
        } catch {
          // Missing or unreadable — targetHealth already says so.
        }
      })
    )

    let failures = new Map<string, number>()
    try {
      failures = await consecutiveFailures()
    } catch {
      failures = new Map()
    }

    const taskByName = new Map<string, { state: string | null; schedule: string | null }>()
    for (const t of tasks) {
      const name = pick(t, "name")
      if (name) taskByName.set(name.toUpperCase(), { state: pick(t, "state"), schedule: pick(t, "schedule") })
    }
    const controlByName = new Map<string, Record<string, unknown>>()
    for (const c of control) {
      const n = c.SOURCE_NAME == null ? null : String(c.SOURCE_NAME).toUpperCase()
      if (n) controlByName.set(n, c)
    }

    const syncs = registry.map((r) => {
      const name = r.config.syncName.toUpperCase()
      const task = taskByName.get(objectNames(name).task.toUpperCase()) ?? null
      const target = `${r.config.targetDb}.${r.config.targetSchema}.${r.config.targetTable}`
      const control = controlByName.get(name) ?? null
      const looked = health.get(target.toUpperCase()) ?? "unknown"

      // Two independent signals. The catalogue lookup needs a privilege and can
      // fail; the recorded failure needs nothing and is Snowflake's own words.
      // Either one is enough to call the target missing.
      const blamed = statusBlamesMissingTarget(
        control?.STATUS == null ? null : String(control.STATUS),
        target
      )
      const targetHealth: TargetHealth = blamed ? "missing" : looked
      const targetMissing = targetHealth === "missing"

      // Two syncs writing to one table is a data-loss pattern, not a preference
      // — whichever runs last wins, and with truncate-and-insert the loser's
      // rows are simply gone. Nothing looked for this before.
      const sharesTargetWith = registry
        .filter(
          (o) =>
            o.config.syncName !== r.config.syncName &&
            `${o.config.targetDb}.${o.config.targetSchema}.${o.config.targetTable}`.toUpperCase() ===
              target.toUpperCase()
        )
        .map((o) => ({ syncName: o.config.syncName, loadMode: o.config.loadMode }))

      return {
        ...r,
        source: "registry" as const,
        taskState: task?.state ?? null,
        taskSchedule: task?.schedule ?? null,
        control,
        target,
        targetHealth,
        targetMissing,
        sharesTargetWith,
        targetRowCount: counts.get(target.toUpperCase()) ?? null,
        // Only offer to build it when the stored types are real ones. A job
        // configured against an existing table carries VARCHAR(1000)
        // placeholders, and creating a wrongly-typed table out of a typo would
        // be worse than the failure it replaces.
        canCreateTarget: targetMissing && r.config.createTable,
        consecutiveFailures: failures.get(name) ?? null,
      }
    })

    // Anything reporting into the shared control table that this app did not
    // deploy. Listed separately so nobody reads it as an app-managed sync.
    const known = new Set(syncs.map((s) => s.config.syncName.toUpperCase()))
    const foreign = [...controlByName.entries()]
      .filter(([n]) => !known.has(n))
      .map(([n, c]) => ({ syncName: n, control: c }))

    return NextResponse.json({ syncs, foreign })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/syncs] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  const name = (request.nextUrl.searchParams.get("name") ?? "").trim().toUpperCase()
  if (!IDENT.test(name)) {
    return NextResponse.json({ error: `Invalid sync name: ${JSON.stringify(name)}` }, { status: 400 })
  }
  try {
    await forgetSync(name)
    // The Snowflake objects are deliberately left in place. Dropping a table
    // that holds loaded data on a button press is not this app's call, and a
    // re-deploy of the same name picks the existing objects back up.
    return NextResponse.json({
      ok: true,
      forgotten: name,
      note:
        `Removed from the job list. The Snowflake objects (table, stage, procedure, task) are ` +
        `still there — drop them in Snowflake if you want them gone. Suspend the task first, ` +
        `or it will keep running on its schedule.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
