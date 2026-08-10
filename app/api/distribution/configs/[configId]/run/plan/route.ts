import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { readConfigById, isConfigActive, planSteps } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// GET — the ordered steps that will run for this specific config.
export async function GET(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    const config = await readConfigById(id)
    if (!config) return NextResponse.json({ error: "Config not found." }, { status: 400 })
    if (!isConfigActive(config)) return NextResponse.json({ error: "This config is inactive. Activate it before running." }, { status: 400 })
    return NextResponse.json({ steps: planSteps(config) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Failed to read config: ${message}` }, { status: 500 })
  }
}
