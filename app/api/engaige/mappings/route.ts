import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { CONFIGS_TABLE, MAPPINGS_TABLE, type EngaigeMapping } from "@/lib/engaige-shared"
import { SF_OPTS, sqlString } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// GET /api/engaige/mappings?configId=... — existing mappings for a config.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  const configId = request.nextUrl.searchParams.get("configId") ?? ""
  if (!UUID_RE.test(configId)) {
    return NextResponse.json({ error: "Invalid configId" }, { status: 400 })
  }
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT mapping_id, source_column, target_field_path
       FROM ${MAPPINGS_TABLE} WHERE config_id = ${sqlString(configId)}
       ORDER BY target_field_path`,
      SF_OPTS
    )
    const mappings: EngaigeMapping[] = rows.map((r) => ({
      mappingId: String(r.MAPPING_ID ?? ""),
      sourceColumn: String(r.SOURCE_COLUMN ?? ""),
      targetFieldPath: String(r.TARGET_FIELD_PATH ?? ""),
    }))
    return NextResponse.json({ mappings })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/mappings] list error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/engaige/mappings — add one or many mappings, optionally activating
// the config afterwards (used to complete a template config's required mapping).
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  let body: {
    configId?: unknown
    mappings?: unknown // [{ sourceColumn, targetFieldPath }]
    activate?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const configId = String(body.configId ?? "")
  if (!UUID_RE.test(configId)) {
    return NextResponse.json({ error: "Invalid configId" }, { status: 400 })
  }
  const list = Array.isArray(body.mappings) ? body.mappings : []
  const clean = list
    .map((m) => ({
      sourceColumn: String((m as Record<string, unknown>)?.sourceColumn ?? "").trim(),
      targetFieldPath: String((m as Record<string, unknown>)?.targetFieldPath ?? "").trim(),
    }))
    .filter((m) => m.sourceColumn && m.targetFieldPath)
  if (clean.length === 0) {
    return NextResponse.json({ error: "At least one complete mapping is required" }, { status: 400 })
  }

  try {
    // Single multi-row insert instead of one round-trip per field.
    const values = clean
      .map(
        (m) =>
          `(${sqlString(randomUUID())}, ${sqlString(configId)}, ${sqlString(m.sourceColumn)}, ` +
          `${sqlString(m.targetFieldPath)}, CURRENT_TIMESTAMP())`
      )
      .join(", ")
    await executeSnowflakeQueryWithMeta(
      `INSERT INTO ${MAPPINGS_TABLE}
         (mapping_id, config_id, source_column, target_field_path, created_at)
       VALUES ${values}`,
      SF_OPTS
    )

    if (body.activate === true) {
      await executeSnowflakeQueryWithMeta(
        `UPDATE ${CONFIGS_TABLE} SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP()
         WHERE config_id = ${sqlString(configId)}`,
        SF_OPTS
      )
    }
    return NextResponse.json({ success: true, added: clean.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/mappings] create error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/engaige/mappings?mappingId=... — remove one mapping.
export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  const mappingId = request.nextUrl.searchParams.get("mappingId") ?? ""
  if (!UUID_RE.test(mappingId)) {
    return NextResponse.json({ error: "Invalid mappingId" }, { status: 400 })
  }
  try {
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${MAPPINGS_TABLE} WHERE mapping_id = ${sqlString(mappingId)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/mappings] delete error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
