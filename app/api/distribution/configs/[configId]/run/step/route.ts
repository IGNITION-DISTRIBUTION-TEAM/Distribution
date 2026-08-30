import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { submitSnowflakeStatementAsync, getSnowflakeStatementStatus } from "@/lib/snowflake"
import { readConfigById, buildStepSql, procRefForStep, callHint } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// POST {key} — submit one step's statement to Snowflake async; returns a handle.
export async function POST(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  let body: { key?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const key = String(body.key ?? "").trim()
  if (!key) return NextResponse.json({ error: "step key required" }, { status: 400 })

  try {
    const config = await readConfigById(id)
    if (!config) return NextResponse.json({ error: "Config not found." }, { status: 400 })
    const campaignId = Number(config.CAMPAIGNID)
    const { sql, database, schema } = await buildStepSql(config, campaignId, key)
    const handle = await submitSnowflakeStatementAsync(sql, { database, schema })
    // Hand the statement back so a failure can show what actually ran. Reading
    // the CALL is the fastest way to tell a bad procedure from a config edit
    // that was never saved.
    return NextResponse.json({ handle, sql })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }
}

// GET ?handle=… — poll a submitted step's status.
export async function GET(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const handle = request.nextUrl.searchParams.get("handle")
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 })
  // Optional, and used only to explain a failure — a compile error surfaces
  // here, on the poll, long after the SQL was built.
  const key = String(request.nextUrl.searchParams.get("key") ?? "").trim()
  try {
    const status = await getSnowflakeStatementStatus(handle)
    if (status.status === "error" && status.error && key) {
      return NextResponse.json({
        ...status,
        error: status.error + (await hintFor(configId, key, status.error)),
      })
    }
    return NextResponse.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: "error", error: message }, { status: 200 })
  }
}

// Re-read the config to name the procedure the failed step called. Best effort
// and only on failure, so a config read that itself fails costs nothing.
async function hintFor(configId: string, key: string, message: string): Promise<string> {
  const id = parseId(configId)
  if (id === null) return ""
  try {
    const config = await readConfigById(id)
    const ref = config ? procRefForStep(config, key) : null
    return ref ? callHint(message, ref) : ""
  } catch {
    return ""
  }
}
