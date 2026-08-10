import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery, submitSnowflakeStatementAsync } from "@/lib/snowflake"
import {
  SYNC_RUNS_TABLE,
  CONFIG_SF,
  readConfigById,
  ensureSyncRunsTable,
  buildSyncBlock,
} from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST — fire the sync as a fire-and-forget Snowflake Scripting block that
// records its outcome in SYNC_RUNS. Returns immediately; Snowflake runs the
// (possibly multi-hour) sync server-side regardless of the browser.
export async function POST(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    const cfg = await readConfigById(id)
    if (!cfg) return NextResponse.json({ error: "Config not found." }, { status: 400 })
    const campaignId = Number(cfg.CAMPAIGNID)
    await ensureSyncRunsTable()
    const token = randomUUID()
    const { sql, database, schema } = await buildSyncBlock(cfg, id, Number.isFinite(campaignId) ? campaignId : 0, token)
    await submitSnowflakeStatementAsync(sql, { database, schema })
    return NextResponse.json({ ok: true, token })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }
}

type SyncRow = { STATUS: string | null; MESSAGE: string | null; STARTED_AT: string | null; FINISHED_AT: string | null }

// GET — the latest sync run's status for this config, straight from the marker
// table (the ground truth of whether the proc actually finished).
export async function GET(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    await ensureSyncRunsTable()
    const rows = await executeSnowflakeQuery<SyncRow>(
      `SELECT STATUS, MESSAGE,
              TO_VARCHAR(STARTED_AT, 'YYYY-MM-DD HH24:MI') AS STARTED_AT,
              TO_VARCHAR(FINISHED_AT, 'YYYY-MM-DD HH24:MI') AS FINISHED_AT
       FROM ${SYNC_RUNS_TABLE} WHERE CONFIG_ID = ${id} ORDER BY ID DESC LIMIT 1`,
      CONFIG_SF
    )
    const r = rows[0]
    if (!r) return NextResponse.json({ status: "none" })
    return NextResponse.json({ status: r.STATUS ?? "running", at: r.STARTED_AT, finishedAt: r.FINISHED_AT, error: r.MESSAGE })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}
