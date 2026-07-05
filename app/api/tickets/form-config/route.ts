import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireAuthenticated, requireSuperAdmin } from "@/lib/admin-guard"
import { TICKETS_CONFIG_TABLE, validateFormConfig, type TicketFormConfig } from "@/lib/tickets-shared"
import { SF_OPTS, ensureTicketTables, getFormConfig, sqlString } from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

// GET /api/tickets/form-config — current form definition. Any signed-in user
// (the department capture pages render the form before any grant exists).
export async function GET(request: NextRequest) {
  const guard = await requireAuthenticated(request)
  if (guard instanceof NextResponse) return guard

  try {
    await ensureTicketTables()
    const config = await getFormConfig()
    return NextResponse.json({ config })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/form-config] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// PUT /api/tickets/form-config — replace the form definition (super admin).
// Config rows are append-only; the newest row wins and older ones remain as history.
export async function PUT(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { config?: TicketFormConfig }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const problem = validateFormConfig(body.config)
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })

  try {
    await ensureTicketTables()
    await executeSnowflakeQueryWithMeta(
      `INSERT INTO ${TICKETS_CONFIG_TABLE} (CONFIG_JSON, UPDATED_BY) ` +
        `SELECT ${sqlString(JSON.stringify(body.config))}, ${sqlString(guard.email)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/form-config] save error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
