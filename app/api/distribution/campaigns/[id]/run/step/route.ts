import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { submitSnowflakeStatementAsync, getSnowflakeStatementStatus } from "@/lib/snowflake"
import { readRunConfig, buildStepSql } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST — submit one step's statement to Snowflake asynchronously; returns a
// handle immediately (no long-held request). Client polls GET ?handle=… .
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  let body: { key?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const key = String(body.key ?? "").trim()
  if (!key) return NextResponse.json({ error: "step key required" }, { status: 400 })

  try {
    const config = await readRunConfig(campaignId)
    if (!config) return NextResponse.json({ error: "No campaign config found for this campaign." }, { status: 400 })
    const { sql, database, schema } = await buildStepSql(config, campaignId, key)
    const handle = await submitSnowflakeStatementAsync(sql, { database, schema })
    return NextResponse.json({ handle })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }
}

// GET ?handle=… — poll a submitted step's status (running | done | error).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  await params // id not needed for the poll, but keep the signature consistent
  const handle = request.nextUrl.searchParams.get("handle")
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 })
  try {
    const status = await getSnowflakeStatementStatus(handle)
    return NextResponse.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}
