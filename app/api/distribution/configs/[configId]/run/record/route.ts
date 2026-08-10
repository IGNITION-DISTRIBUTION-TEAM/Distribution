import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { sqlStr, getActorEmail } from "@/app/api/campaign-config/route"
import { CONFIGS_TABLE, CONFIG_SF, RUN_HISTORY_TABLE, ensureRunHistoryTable, readConfigById } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST {ok, summary, ran, steps} — append a run-history row for this config and
// update the config's LAST_RUN snapshot. Best-effort.
export async function POST(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  let body: { ok?: boolean; summary?: string; ran?: number; steps?: unknown }
  try { body = await request.json() } catch { body = {} }
  const status = body.ok ? "Success" : "Error"
  const summary = String(body.summary ?? "").slice(0, 4000)
  const ran = Number.isInteger(body.ran) ? Number(body.ran) : 0
  const actor = getActorEmail(request)
  let stepsJson = "[]"
  try { stepsJson = JSON.stringify(body.steps ?? []).slice(0, 8000) } catch { stepsJson = "[]" }

  // Look up campaign id / title / config name for the history row.
  let campaignId = "NULL", title = "", cfgName = ""
  try {
    const cfg = await readConfigById(id)
    if (cfg) {
      const c = Number(cfg.CAMPAIGNID)
      if (Number.isFinite(c)) campaignId = String(c)
      title = cfg.CAMPAIGN_TITLE == null ? "" : String(cfg.CAMPAIGN_TITLE)
      cfgName = cfg.CONFIG_NAME == null ? "" : String(cfg.CONFIG_NAME)
    }
  } catch { /* best-effort */ }

  try {
    await ensureRunHistoryTable()
    await executeSnowflakeQuery(
      `INSERT INTO ${RUN_HISTORY_TABLE} (CAMPAIGNID, CONFIG_ID, CONFIG_NAME, CAMPAIGN_TITLE, STATUS, RAN, SUMMARY, STEPS_JSON, CREATED_BY)
       VALUES (${campaignId}, ${id}, ${sqlStr(cfgName)}, ${sqlStr(title)}, ${sqlStr(status)}, ${ran}, ${sqlStr(summary)}, ${sqlStr(stepsJson)}, ${sqlStr(actor)})`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/configs/[configId]/run/record] history insert error:", e)
  }

  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIGS_TABLE} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(summary)}
       WHERE CONFIG_ID = ${id}`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/configs/[configId]/run/record] config update error:", e)
  }

  return NextResponse.json({ ok: true })
}
