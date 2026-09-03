import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { readCampaignSetting } from "@/lib/config-lookup"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

// Run the campaign's configured "Load into history" procedure (stage -> HLL).
// The proc name is read from the campaign config rather than the request body,
// so a caller can't ask us to CALL an arbitrary procedure.
export async function POST(request: Request) {
  let body: { campaignId?: unknown; configId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const id = Number(body.campaignId)
  const configId =
    body.configId != null && /^[0-9]+$/.test(String(body.configId)) ? Number(body.configId) : null

  let proc: string | null
  let configSource = ""
  try {
    const found = await readCampaignSetting(id, configId, ["LOAD_HISTORY_PROCEDURE"])
    proc = found.value
    configSource = found.source
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/load-history] config read error:", message)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  if (!proc) {
    return NextResponse.json(
      {
        error:
          `No 'Load into history procedure' is configured for campaign ${id}. Set it in ` +
          `Settings → Campaign automation, on the same config this panel is using — ` +
          `checked ${configSource}.`,
      },
      { status: 400 }
    )
  }
  proc = proc.trim()
  if (!QUALIFIED.test(proc)) {
    return NextResponse.json(
      { error: `Configured procedure is not a valid DATABASE.SCHEMA.PROC: ${proc}` },
      { status: 400 }
    )
  }
  const [database, schema] = proc.split(".")

  try {
    const result = await executeSnowflakeQuery<Record<string, unknown>>(`CALL ${proc}()`, {
      database,
      schema,
    })
    return NextResponse.json({ ok: true, proc, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/load-history] call error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
