import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildSyncScript, objectNames, type SyncConfig } from "@/lib/sftp-sync-codegen"
import { recordDeploy, getSync } from "@/lib/sftp-sync-registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Generate a sync's Snowflake objects, and optionally create them.
 *
 *   POST { config, execute?: boolean }
 *
 * `execute: false` (the default) only builds, so the statements and warnings
 * can be shown before anything is created. Nothing is deployed by accident.
 *
 * Statements run IN ORDER and stop at the first failure, reporting which one.
 * A half-built sync is recoverable — every statement is IF NOT EXISTS or OR
 * REPLACE, so fixing the cause and re-deploying completes it rather than
 * needing a manual clean-up.
 */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: { config?: SyncConfig; execute?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.config) return NextResponse.json({ error: "config required" }, { status: 400 })

  // Generation validates. An identifier that is not a plain identifier, or a
  // target schema off the allow-list, throws here and never reaches Snowflake.
  let built
  try {
    built = buildSyncScript(body.config)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    )
  }

  if (!body.execute) {
    return NextResponse.json({ deployed: false, ...built })
  }

  const [db, schema] = [body.config.targetDb, body.config.targetSchema]
  const target = `${db}.${schema}.${body.config.targetTable}`
  const results: { label: string; ok: boolean; error?: string }[] = []

  /**
   * Was this job's schedule already armed?
   *
   * The last statement of every script is ALTER TASK … SUSPEND, which is right
   * for a FIRST deploy — §10 of the standards document wants a human to look
   * before anything runs on a schedule — and wrong for redeploying something
   * already reviewed and live: the sync would just stop, and the only sign
   * would be a task state nobody is watching.
   *
   * So the prior state is captured here and restored at the end. A first deploy
   * has no prior state, lands suspended, and the review gate is intact.
   */
  /**
   * Did this deploy change how the data is loaded?
   *
   * If so it will not take effect until the source file changes, because change
   * detection returns NO_CHANGE before reaching any load logic. Comparing
   * against the registry row we are about to replace is the only place that is
   * knowable, and saying nothing is how a mode switch gets deployed, run, and
   * quietly not applied.
   */
  let changedLoadLogic = false
  try {
    const before = await getSync(body.config.syncName)
    if (before) {
      const shape = (c: SyncConfig) =>
        JSON.stringify([c.loadMode, c.mergeKeys, c.columns, c.delimiter, c.skipHeader])
      changedLoadLogic = shape(before.config) !== shape(body.config)
    }
  } catch {
    changedLoadLogic = false
  }

  let wasStarted = false
  const taskRef = `${db}.${schema}.${objectNames(body.config.syncName).task}`
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SHOW TASKS LIKE '${objectNames(body.config.syncName).task}' IN SCHEMA ${db}.${schema}`,
      { database: db, schema }
    )
    const r = rows[0]
    const k = r && Object.keys(r).find((c) => c.toLowerCase() === "state")
    wasStarted = Boolean(k && r && String(r[k]).toLowerCase() === "started")
  } catch {
    // No task yet, or not visible. Either way there is no state to preserve.
    wasStarted = false
  }

  // PRE-FLIGHT. Nothing in the script creates the target when the job was
  // configured against an existing table, so without this the deploy succeeds,
  // the task is armed, and the first anyone hears of a missing table is a
  // failure at whatever hour the schedule fires.
  if (!body.config.createTable) {
    try {
      await executeSnowflakeQuery(`SELECT * FROM ${target} LIMIT 0`, { database: db, schema })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json(
        {
          deployed: false,
          error:
            `${target} cannot be read, so this sync would deploy cleanly and then fail on its ` +
            `schedule. Snowflake reports a missing object and a missing privilege the same way, ` +
            `so it either does not exist or this app's role cannot see it. Nothing was created.\n\n` +
            `If the table should be created, go back to Destination and choose "Create a new ` +
            `table".\n\nDetail: ${message}`,
        },
        { status: 400 }
      )
    }
  }

  for (const st of built.statements) {
    try {
      await executeSnowflakeQuery(st.sql, { database: db, schema })
      results.push({ label: st.label, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ label: st.label, ok: false, error: message })
      // Stop here. Later statements assume the earlier ones exist — the
      // procedure references the staging table, the task references the
      // procedure — so carrying on would pile confusing errors on top of the
      // real one.
      return NextResponse.json(
        {
          deployed: false,
          failedAt: st.label,
          results,
          statements: built.statements,
          warnings: built.warnings,
          error:
            `Stopped at "${st.label}": ${message}\n\n` +
            `Everything before it succeeded. Fix the cause and deploy again — every ` +
            `statement is IF NOT EXISTS or OR REPLACE, so a re-run completes the sync ` +
            `rather than leaving a half-built one behind.`,
        },
        { status: 500 }
      )
    }
  }

  // Put the schedule back the way it was found.
  let rearmed = false
  let rearmError: string | null = null
  if (wasStarted) {
    try {
      await executeSnowflakeQuery(`ALTER TASK ${taskRef} RESUME`, { database: db, schema })
      rearmed = true
    } catch (error) {
      rearmError = error instanceof Error ? error.message : String(error)
    }
  }

  // POST-FLIGHT. Every statement reported success; confirm the thing they were
  // all for actually exists. This catches routes to a missing target that the
  // pre-flight cannot — including a CREATE that succeeded against a name other
  // than the one the procedure references.
  try {
    await executeSnowflakeQuery(`SELECT * FROM ${target} LIMIT 0`, { database: db, schema })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        deployed: false,
        results,
        statements: built.statements,
        warnings: built.warnings,
        error:
          `Every statement ran, but ${target} still cannot be read afterwards — so this sync ` +
          `would fail on its first run. The objects that were created are still there and a ` +
          `re-deploy is safe.\n\nDetail: ${message}`,
      },
      { status: 500 }
    )
  }

  // Record what was deployed, so the job can be reopened and edited later.
  // Best-effort: the objects exist in Snowflake either way, and failing the
  // whole deploy because the bookkeeping failed would be the wrong trade.
  let registered = true
  let registryError: string | null = null
  try {
    await recordDeploy(body.config, {
      deployedBy: guard.email,
      deployedSql: built.statements.map((s) => `-- ${s.label}\n${s.sql}`).join("\n\n"),
    })
  } catch (error) {
    registered = false
    registryError = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/deploy] registry write failed:", registryError)
  }

  return NextResponse.json({
    deployed: true,
    results,
    statements: built.statements,
    warnings: built.warnings,
    deployedBy: guard.email,
    deployedAt: new Date().toISOString(),
    taskWasStarted: wasStarted,
    changedLoadLogic,
    loadLogicNote: changedLoadLogic
      ? "The mapping or load mode changed. Change detection means this will not take effect " +
        "until the source file changes — use Force reload to apply it to the current file now."
      : null,
    rearmed,
    taskNote: wasStarted
      ? rearmed
        ? "The schedule was running before this, so it has been resumed."
        : `The schedule was running before this and could NOT be resumed — it is suspended now. ${rearmError}`
      : "Created suspended. Resume it from Tasks once you are happy with it.",
    registered,
    registryError:
      registered
        ? null
        : `The sync was created, but it could not be saved to the job list, so it will not ` +
          `appear under Current jobs: ${registryError}`,
  })
}
