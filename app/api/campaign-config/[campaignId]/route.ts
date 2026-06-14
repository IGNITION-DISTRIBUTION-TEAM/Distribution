import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE, SF_OPTS } from "../route"

export const dynamic = "force-dynamic"

function parseCampaignId(raw: string): number | { error: string } {
  if (!/^[0-9]+$/.test(raw)) return { error: "campaignId must be a positive integer" }
  return Number(raw)
}

export async function GET(_request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params
  const id = parseCampaignId(campaignId)
  if (typeof id !== "number") return NextResponse.json(id, { status: 400 })

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT * FROM ${TABLE} WHERE CAMPAIGNID = ${id}`,
      SF_OPTS
    )
    return NextResponse.json({ config: rows[0] ?? null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config/[campaignId] GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params
  const id = parseCampaignId(campaignId)
  if (typeof id !== "number") return NextResponse.json(id, { status: 400 })

  try {
    await executeSnowflakeQuery(`DELETE FROM ${TABLE} WHERE CAMPAIGNID = ${id}`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config/[campaignId] DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
