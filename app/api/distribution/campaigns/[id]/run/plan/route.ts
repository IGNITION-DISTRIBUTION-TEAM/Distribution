import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { readRunConfig, isConfigActive, planSteps } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// GET — the ordered steps that will run for this campaign's saved config.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })
  try {
    const config = await readRunConfig(campaignId)
    if (!config) return NextResponse.json({ error: "No campaign config found for this campaign." }, { status: 400 })
    if (!isConfigActive(config)) return NextResponse.json({ error: "This campaign's config is inactive. Activate it before running." }, { status: 400 })
    return NextResponse.json({ steps: planSteps(config) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }
}
