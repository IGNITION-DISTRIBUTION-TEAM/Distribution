import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { sqlStr } from "@/app/api/campaign-config/route"
import { CONFIG_TABLE_REF, CONFIG_SF } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST {ok, summary} — persist the run outcome on the config row. Best-effort:
// if the LAST_RUN_* columns don't exist, we just skip (don't fail the run).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  let body: { ok?: boolean; summary?: string }
  try { body = await request.json() } catch { body = {} }
  const status = body.ok ? "Success" : "Error"
  const summary = String(body.summary ?? "").slice(0, 4000)

  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIG_TABLE_REF} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(summary)}
       WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF
    )
  } catch (e) {
    console.error("[/api/distribution/campaigns/[id]/run/record] error:", e)
  }
  return NextResponse.json({ ok: true })
}
