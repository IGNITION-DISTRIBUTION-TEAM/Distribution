import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { HISTORY_TABLE } from "@/lib/engaige-shared"
import { SF_OPTS, sqlString } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// POST /api/engaige/configs/[id]/run
//   { action: "run", testMode: bool }  → CALL execute_config_manually(id, testMode)
//   { action: "cancel" }               → mark RUNNING batches CANCELLED
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  let body: { action?: unknown; testMode?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    if (body.action === "cancel") {
      await executeSnowflakeQueryWithMeta(
        `UPDATE ${HISTORY_TABLE} SET status = 'CANCELLED', end_time = CURRENT_TIMESTAMP()
         WHERE config_id = ${sqlString(id)} AND status = 'RUNNING'`,
        SF_OPTS
      )
      return NextResponse.json({ success: true, message: "Process cancelled" })
    }

    const testMode = body.testMode === true ? "TRUE" : "FALSE"
    // execute_config_manually resolves in the SS_INTEGRATION schema via SF_OPTS.
    const { rows } = await executeSnowflakeQueryWithMeta(
      `CALL execute_config_manually(${sqlString(id)}, ${testMode})`,
      SF_OPTS
    )
    const message = rows[0]?.[0] != null ? String(rows[0][0]) : null
    if (!message) {
      return NextResponse.json({ error: "Execution failed with no result" }, { status: 500 })
    }
    return NextResponse.json({ success: true, message })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs/[id]/run] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
