import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE as CONFIG_TABLE, SF_OPTS as CONFIG_SF_OPTS } from "@/app/api/campaign-config/route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

// Run the campaign's configured "Load into history" procedure (stage -> HLL).
// The proc name is read from the campaign config rather than the request body,
// so a caller can't ask us to CALL an arbitrary procedure.
export async function POST(request: Request) {
  let body: { campaignId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const id = Number(body.campaignId)

  let proc: string | null
  try {
    const rows = await executeSnowflakeQuery<{ LOAD_HISTORY_PROCEDURE: string | null }>(
      `SELECT LOAD_HISTORY_PROCEDURE FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${id}`,
      CONFIG_SF_OPTS
    )
    proc = rows[0]?.LOAD_HISTORY_PROCEDURE ?? null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/load-history] config read error:", message)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  if (!proc || !proc.trim()) {
    return NextResponse.json(
      { error: "No 'Load into history procedure' is configured for this campaign. Set it in Settings." },
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
