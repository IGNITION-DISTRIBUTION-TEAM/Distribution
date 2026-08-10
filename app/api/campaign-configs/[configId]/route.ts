import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { SF_OPTS } from "@/app/api/campaign-config/route"
import { CONFIGS_TABLE } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// DELETE — remove one automation config.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    await executeSnowflakeQuery(`DELETE FROM ${CONFIGS_TABLE} WHERE CONFIG_ID = ${id}`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
