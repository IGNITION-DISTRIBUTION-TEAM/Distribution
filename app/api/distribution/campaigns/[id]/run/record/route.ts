import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { sqlStr, getActorEmail } from "@/app/api/campaign-config/route"
import { CONFIG_TABLE_REF, CONFIG_SF, RUN_HISTORY_TABLE, ensureRunHistoryTable } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST {ok, summary, ran, steps, campaignTitle} — record the run: append a row
// to the run-history table and update the config's LAST_RUN_* snapshot. Both
// are best-effort so recording never fails the run itself.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  let body: { ok?: boolean; summary?: string; ran?: number; steps?: unknown; campaignTitle?: string }
  try { body = await request.json() } catch { body = {} }
  const status = body.ok ? "Success" : "Error"
  const summary = String(body.summary ?? "").slice(0, 4000)
  const ran = Number.isInteger(body.ran) ? Number(body.ran) : 0
  const title = typeof body.campaignTitle === "string" ? body.campaignTitle : ""
  const actor = getActorEmail(request)
  let stepsJson = "[]"
  try { stepsJson = JSON.stringify(body.steps ?? []).slice(0, 8000) } catch { stepsJson = "[]" }

  // 1. Append to run history (app-owned table — always creatable).
  try {
    await ensureRunHistoryTable()
    await executeSnowflakeQuery(
      `INSERT INTO ${RUN_HISTORY_TABLE} (CAMPAIGNID, CAMPAIGN_TITLE, STATUS, RAN, SUMMARY, STEPS_JSON, CREATED_BY)
       VALUES (${campaignId}, ${sqlStr(title)}, ${sqlStr(status)}, ${ran}, ${sqlStr(summary)}, ${sqlStr(stepsJson)}, ${sqlStr(actor)})`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/campaigns/[id]/run/record] history insert error:", e)
  }

  // 2. Update the config's last-run snapshot (best-effort; columns may be absent).
  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIG_TABLE_REF} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(summary)}
       WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/campaigns/[id]/run/record] config update error:", e)
  }

  return NextResponse.json({ ok: true })
}
