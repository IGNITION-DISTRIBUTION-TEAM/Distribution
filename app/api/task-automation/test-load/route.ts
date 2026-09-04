import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  buildSyncScript,
  buildStageStatement,
  buildStagingStatement,
  buildCopyStatement,
  resolveSync,
  type SyncConfig,
} from "@/lib/sftp-sync-codegen"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Load one file into the staging table and show what came out — before any of
 * the permanent objects exist.
 *
 *   POST { config } -> { rowCount, columns, rows, ... }
 *
 * WHAT THIS CREATES: the stage and the transient staging table, and nothing
 * else. No target table, no procedure, no task. Both are the deploy's own
 * statements, `IF NOT EXISTS`, so deploying afterwards reuses them rather than
 * building a second set.
 *
 * WHY IT EXISTS: steps 1-4 only ever split raw text in the browser. Nothing
 * before this point exercises COPY INTO, so a wrong delimiter, an off-by-one
 * ordinal or a mis-set header row is invisible until the sync has been created
 * and scheduled. The sample this returns is the file parsed by Snowflake, with
 * the chosen file format and ordinals, under the column names it maps to.
 *
 * WHAT IT MUST NOT DO: touch DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL. The real sync
 * only fetches files newer than LAST_MODIFIED. If a test advanced that
 * watermark, the first real run would find nothing new and load zero rows — a
 * sync that looks like it works and silently never loads its first file. So the
 * watermark is neither read nor written here: SINCE_EPOCH is passed as a
 * literal 0.
 *
 * Two smaller consequences of the same care:
 *   - MAX_FILES = 1. A test pulls one file, not a backlog.
 *   - PURGE = FALSE on the COPY, unlike the generated procedure. Purging would
 *     delete the staged file the first real run is about to want.
 */

/** One file, from the beginning of time. Both are deliberate — see above. */
const TEST_MAX_FILES = 1
const TEST_SINCE_EPOCH = 0
const SAMPLE_ROWS = 20

const FETCH = "SPOT_DW.SFTP_ADMIN.SP_SFTP_FETCH"
const sqlLit = (s: string) => `'${String(s).replace(/'/g, "''")}'`

type FetchResult = {
  status?: string
  files_found?: number
  files_staged?: number
  bytes_staged?: number
  error_message?: string
  files?: { name?: string; size?: number; mtime_epoch?: number }[]
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: { config?: SyncConfig }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const config = body.config
  if (!config) return NextResponse.json({ error: "config required" }, { status: 400 })

  // Generation is what validates. An identifier that is not a plain identifier,
  // or a target schema off the allow-list, throws here and never reaches
  // Snowflake — the same gate the deploy goes through.
  let resolved: ReturnType<typeof resolveSync>
  let warnings: string[]
  try {
    resolved = resolveSync(config)
    warnings = buildSyncScript(config).warnings
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    )
  }

  const sf = { database: resolved.db, schema: resolved.schema }
  const colNames = resolved.cols.map((c) => c.target)
  const steps: { label: string; ok: boolean; detail?: string }[] = []

  const fail = (label: string, message: string, extra: Record<string, unknown> = {}) => {
    steps.push({ label, ok: false, detail: message })
    return NextResponse.json({ ok: false, failedAt: label, error: message, steps, warnings, ...extra }, { status: 200 })
  }

  try {
    /* 1 — the stage. The deploy's own statement. */
    const stageStmt = buildStageStatement(config)
    await executeSnowflakeQuery(stageStmt.sql, sf)
    steps.push({ label: stageStmt.label, ok: true })

    /* 2 — the staging table, likewise.
       Then check its shape. IF NOT EXISTS leaves an older table alone, so a
       mapping changed since the last test would meet a table without the new
       column and the COPY would fail on something that is not a file problem.
       The table is transient and truncated every run, so replacing it in that
       case costs nothing. */
    const stagingStmt = buildStagingStatement(config)
    await executeSnowflakeQuery(stagingStmt.sql, sf)
    let replaced = false
    try {
      const desc = await executeSnowflakeQuery<Record<string, unknown>>(
        `DESCRIBE TABLE ${resolved.staging}`,
        sf
      )
      const existing = desc
        .map((r) => String(r.name ?? r.NAME ?? "").toUpperCase())
        .filter((n) => n && !n.startsWith("_"))
      const wanted = colNames.map((c) => c.toUpperCase())
      if (existing.join("|") !== wanted.join("|")) {
        await executeSnowflakeQuery(buildStagingStatement(config, { replace: true }).sql, sf)
        replaced = true
      }
    } catch {
      // DESCRIBE failing is not fatal — the COPY below is the real test, and
      // its error will be more specific than anything guessed here.
    }
    steps.push({
      label: stagingStmt.label,
      ok: true,
      detail: replaced
        ? "Rebuilt: the existing staging table did not match the current column mapping."
        : undefined,
    })

    /* 3 — start empty, so the sample is this file and not the last one. */
    await executeSnowflakeQuery(`TRUNCATE TABLE ${resolved.staging}`, sf)

    /* 4 — fetch one file. SINCE_EPOCH is a literal 0: the control table is
       neither read nor written by a test. */
    const fetchSql =
      `CALL ${FETCH}(${sqlLit(config.endpoint)}, ${sqlLit(config.remoteDir)}, ` +
      `${sqlLit(config.filePattern)}, ${sqlLit(resolved.stage)}, ` +
      `${TEST_SINCE_EPOCH}, ${TEST_MAX_FILES})`
    const fetchRows = await executeSnowflakeQuery<Record<string, unknown>>(fetchSql, {
      database: "SPOT_DW",
      schema: "SFTP_ADMIN",
    })
    const rawFetch = Object.values(fetchRows[0] ?? {})[0]
    const fetched: FetchResult =
      typeof rawFetch === "string" ? JSON.parse(rawFetch) : ((rawFetch ?? {}) as FetchResult)

    if (fetched.status === "FAILED") {
      return fail("Fetch one file", String(fetched.error_message ?? "The fetch reported FAILED."), {
        fetched,
      })
    }
    if (!fetched.files_staged) {
      return fail(
        "Fetch one file",
        `Nothing matched ${config.filePattern} in ${config.remoteDir}. ` +
          `The pattern is matched against the filename only, and it is case-sensitive. ` +
          `${fetched.files_found ?? 0} file(s) were in the directory.`,
        { fetched }
      )
    }
    const staged = fetched.files?.[0]
    steps.push({
      label: "Fetch one file",
      ok: true,
      detail: `${staged?.name ?? "1 file"} (${fetched.bytes_staged ?? 0} bytes)`,
    })

    /* 5 — the COPY. Character-identical to the one in the generated procedure
       apart from PURGE; both come from buildCopyStatement. */
    const copySql = buildCopyStatement(config, { purge: false })
    await executeSnowflakeQuery(copySql, sf)
    const counted = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT COUNT(*) AS N FROM ${resolved.staging}`,
      sf
    )
    const rowCount = Number(Object.values(counted[0] ?? {})[0] ?? 0)
    steps.push({ label: "COPY INTO the staging table", ok: true, detail: `${rowCount} row(s)` })

    /* 6 — the sample, under the target column names. This is the thing worth
       looking at: a wrong delimiter collapses it to one column, and a wrong
       ordinal puts the values under the wrong heading. */
    const sample = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT ${colNames.join(", ")} FROM ${resolved.staging} LIMIT ${SAMPLE_ROWS}`,
      sf
    )

    return NextResponse.json({
      ok: true,
      steps,
      warnings,
      rowCount,
      columns: colNames,
      rows: sample.map((r) => colNames.map((c) => r[c] ?? r[c.toLowerCase()] ?? null)),
      file: staged ?? null,
      stage: resolved.stage,
      staging: resolved.staging,
      copySql,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/test-load] error:", message)
    return NextResponse.json({ ok: false, error: message, steps, warnings }, { status: 500 })
  }
}
