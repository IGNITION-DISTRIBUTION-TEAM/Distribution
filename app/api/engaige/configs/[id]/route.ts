import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  CONFIGS_TABLE,
  MAPPINGS_TABLE,
  ASSIGNMENTS_TABLE,
  API_BASE,
  ENDPOINT_OPTIONS,
} from "@/lib/engaige-shared"
import { SF_OPTS, sqlString, assertIdent } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// PATCH /api/engaige/configs/[id] —
//   { action: "toggle" } flips is_active
//   { action: "update", ...fields } edits name/source/endpoint/IDs/batch size
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  let body: {
    action?: unknown
    configName?: unknown
    sourceTable?: unknown
    endpoint?: unknown
    externalSourceId?: unknown
    eventId?: unknown
    batchSize?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    if (body.action === "toggle") {
      await executeSnowflakeQueryWithMeta(
        `UPDATE ${CONFIGS_TABLE} SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP()
         WHERE config_id = ${sqlString(id)}`,
        SF_OPTS
      )
      return NextResponse.json({ success: true })
    }

    if (body.action === "update") {
      const configName = String(body.configName ?? "").trim()
      const sourceTable = String(body.sourceTable ?? "").trim()
      const endpoint = String(body.endpoint ?? "")
      const externalSourceId = String(body.externalSourceId ?? "").trim().slice(0, 200)
      const eventId = String(body.eventId ?? "").trim().slice(0, 200)
      const batchSize = Number(body.batchSize)

      if (!configName || !sourceTable) {
        return NextResponse.json(
          { error: "Configuration name and source table are required" },
          { status: 400 }
        )
      }
      if (!(ENDPOINT_OPTIONS as readonly string[]).includes(endpoint)) {
        return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 })
      }
      try {
        assertIdent(sourceTable, "source table")
      } catch {
        return NextResponse.json(
          { error: "Source table is not a valid identifier" },
          { status: 400 }
        )
      }
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100000) {
        return NextResponse.json({ error: "Batch size must be 1–100000" }, { status: 400 })
      }

      const apiEndpoint = `${API_BASE}${endpoint}`
      const apiSettings = JSON.stringify({ external_source_id: externalSourceId, event_id: eventId })

      await executeSnowflakeQueryWithMeta(
        `UPDATE ${CONFIGS_TABLE} SET
           config_name = ${sqlString(configName)},
           source_table = ${sqlString(sourceTable)},
           api_endpoint = ${sqlString(apiEndpoint)},
           api_settings = PARSE_JSON(${sqlString(apiSettings)}),
           batch_size = ${batchSize},
           updated_at = CURRENT_TIMESTAMP()
         WHERE config_id = ${sqlString(id)}`,
        SF_OPTS
      )
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs/[id]] patch error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/engaige/configs/[id] — cascade delete mappings, assignments, config.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })

  try {
    const idLit = sqlString(id)
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${MAPPINGS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${CONFIGS_TABLE} WHERE config_id = ${idLit}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs/[id]] delete error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
