import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE as CONFIG_TABLE, SF_OPTS as CONFIG_SF_OPTS } from "@/app/api/campaign-config/route"
import {
  TABLE as PROC_TABLE,
  SF_OPTS as PROC_SF_OPTS,
  QUALIFIED_PROC,
  escapeSqlString,
} from "@/app/api/hll-procedures/route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

// Run the "update HLL" procedure for a campaign: CALL <proc>(<campaignId>).
// The proc is either the campaign's assigned UPDATE_HLL_PROCEDURE or an
// override passed in the body — but either way it MUST exist in the
// TSK_HLL_UPDATE_PROCEDURES master list, so we never CALL an arbitrary proc.
export async function POST(request: Request) {
  let body: { campaignId?: unknown; procOverride?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const id = Number(body.campaignId)

  // Resolve the proc: explicit override, else the campaign's assigned proc.
  let proc: string | null = null
  const override = typeof body.procOverride === "string" ? body.procOverride.trim() : ""
  if (override) {
    proc = override
  } else {
    try {
      const rows = await executeSnowflakeQuery<{ UPDATE_HLL_PROCEDURE: string | null }>(
        `SELECT UPDATE_HLL_PROCEDURE FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${id}`,
        CONFIG_SF_OPTS
      )
      proc = rows[0]?.UPDATE_HLL_PROCEDURE ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[/api/leads/update-hll] config read error:", message)
      return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
    }
  }

  if (!proc || !proc.trim()) {
    return NextResponse.json(
      { error: "No update-HLL procedure assigned to this campaign, and no override given." },
      { status: 400 }
    )
  }
  proc = proc.trim()
  if (!QUALIFIED_PROC.test(proc)) {
    return NextResponse.json(
      { error: `Procedure is not a valid DATABASE.SCHEMA.PROC: ${proc}` },
      { status: 400 }
    )
  }

  // Whitelist check — the proc must be in the master list.
  try {
    const allowed = await executeSnowflakeQuery<{ CNT: number | string }>(
      `SELECT COUNT(1) AS CNT FROM ${PROC_TABLE} WHERE PROC_NAME = '${escapeSqlString(proc)}'`,
      PROC_SF_OPTS
    )
    const cnt = allowed[0]?.CNT
    const n = typeof cnt === "number" ? cnt : parseInt(String(cnt ?? "0"), 10) || 0
    if (n === 0) {
      return NextResponse.json(
        { error: `Procedure "${proc}" is not in the approved list (TSK_HLL_UPDATE_PROCEDURES).` },
        { status: 400 }
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/update-hll] whitelist check error:", message)
    return NextResponse.json({ error: `Failed to verify procedure: ${message}` }, { status: 500 })
  }

  const [database, schema] = proc.split(".")
  try {
    const result = await executeSnowflakeQuery<Record<string, unknown>>(
      `CALL ${proc}(${id})`,
      { database, schema }
    )
    return NextResponse.json({ ok: true, proc, campaignId: id, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/update-hll] call error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
