import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery, getSnowflakeStatementStatus } from "@/lib/snowflake"
import { sqlStr } from "@/app/api/campaign-config/route"
import { CONFIGS_TABLE, CONFIG_SF, readConfigById } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST {handle} — remember the fire-and-forget sync's statement handle so it
// can be checked later (the browser doesn't wait on the 2-hour sync).
export async function POST(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  let body: { handle?: string }
  try { body = await request.json() } catch { body = {} }
  const handle = String(body.handle ?? "").trim()
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 })
  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIGS_TABLE} SET SYNC_LAST_HANDLE = ${sqlStr(handle)}, SYNC_LAST_AT = CURRENT_TIMESTAMP(),
              SYNC_LAST_STATUS = 'running' WHERE CONFIG_ID = ${id}`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/configs/[id]/sync POST] error:", e)
  }
  return NextResponse.json({ ok: true })
}

// GET — poll the last submitted sync's status (running | done | error | none).
export async function GET(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    const cfg = await readConfigById(id)
    const handle = cfg?.SYNC_LAST_HANDLE == null ? "" : String(cfg.SYNC_LAST_HANDLE).trim()
    const at = cfg?.SYNC_LAST_AT == null ? null : String(cfg.SYNC_LAST_AT)
    if (!handle) return NextResponse.json({ status: "none" })
    const res = await getSnowflakeStatementStatus(handle)
    // Persist a terminal status so a later view doesn't re-poll a gone handle.
    if (res.status === "done" || res.status === "error") {
      try {
        await executeSnowflakeQuery(
          `UPDATE ${CONFIGS_TABLE} SET SYNC_LAST_STATUS = ${sqlStr(res.status === "done" ? "done" : "error")} WHERE CONFIG_ID = ${id}`,
          CONFIG_SF
        )
      } catch { /* best-effort */ }
    }
    return NextResponse.json({ status: res.status, at, error: res.error })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}
