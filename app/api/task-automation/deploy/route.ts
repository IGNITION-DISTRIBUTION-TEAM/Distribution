import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildSyncScript, type SyncConfig } from "@/lib/sftp-sync-codegen"

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
  const results: { label: string; ok: boolean; error?: string }[] = []

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

  return NextResponse.json({
    deployed: true,
    results,
    statements: built.statements,
    warnings: built.warnings,
    deployedBy: guard.email,
    deployedAt: new Date().toISOString(),
  })
}
