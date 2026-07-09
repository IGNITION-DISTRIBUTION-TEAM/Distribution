import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  CONFIGS_TABLE,
  MAPPINGS_TABLE,
  HISTORY_TABLE,
  API_BASE,
  ENDPOINT_OPTIONS,
  TEMPLATE_TYPES,
  TEMPLATE_ID_BY_TYPE,
  type EngaigeConfig,
  type TemplateType,
} from "@/lib/engaige-shared"
import { SF_OPTS, sqlString, assertIdent, safeJsonParse } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

// GET /api/engaige/configs — all configs with mapping counts and running-batch
// counts folded in via joins (the Streamlit version ran these per-config).
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT c.config_id, c.config_name, c.template_id, c.source_table, c.batch_size,
              c.api_endpoint, TO_JSON(c.api_settings) AS api_settings_json, c.is_active,
              TO_VARCHAR(c.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              TO_VARCHAR(c.updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at,
              COALESCE(m.cnt, 0) AS mapping_count,
              COALESCE(r.cnt, 0) AS running_count
       FROM ${CONFIGS_TABLE} c
       LEFT JOIN (SELECT config_id, COUNT(*) cnt FROM ${MAPPINGS_TABLE} GROUP BY config_id) m
              ON m.config_id = c.config_id
       LEFT JOIN (SELECT config_id, COUNT(*) cnt FROM ${HISTORY_TABLE}
                  WHERE status = 'RUNNING' GROUP BY config_id) r
              ON r.config_id = c.config_id
       ORDER BY c.created_at DESC`,
      SF_OPTS
    )

    const configs: EngaigeConfig[] = rows.map((r) => {
      const settings = safeJsonParse(r.API_SETTINGS_JSON)
      const endpoint = String(r.API_ENDPOINT ?? "")
      return {
        configId: String(r.CONFIG_ID ?? ""),
        configName: String(r.CONFIG_NAME ?? ""),
        templateId: r.TEMPLATE_ID == null || r.TEMPLATE_ID === "" ? null : String(r.TEMPLATE_ID),
        sourceTable: String(r.SOURCE_TABLE ?? ""),
        batchSize: Number(r.BATCH_SIZE ?? 0),
        apiEndpoint: endpoint,
        externalSourceId: String(settings.external_source_id ?? ""),
        eventId: String(settings.event_id ?? ""),
        isActive: Boolean(r.IS_ACTIVE),
        createdAt: r.CREATED_AT == null ? null : String(r.CREATED_AT),
        updatedAt: r.UPDATED_AT == null ? null : String(r.UPDATED_AT),
        mappingCount: Number(r.MAPPING_COUNT ?? 0),
        runningCount: Number(r.RUNNING_COUNT ?? 0),
      }
    })
    return NextResponse.json({ configs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs] list error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/engaige/configs — create a configuration. Template-based configs
// start inactive (is_active=false) until their required mappings are saved.
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  let body: {
    configName?: unknown
    sourceTable?: unknown
    endpoint?: unknown
    templateType?: unknown
    externalSourceId?: unknown
    eventId?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const configName = String(body.configName ?? "").trim()
  const sourceTable = String(body.sourceTable ?? "").trim()
  const endpoint = String(body.endpoint ?? ENDPOINT_OPTIONS[0])
  const templateType = String(body.templateType ?? "Generic") as TemplateType
  const externalSourceId = String(body.externalSourceId ?? "").trim().slice(0, 200)
  const eventId = String(body.eventId ?? "").trim().slice(0, 200)

  if (!configName || !sourceTable) {
    return NextResponse.json(
      { error: "Configuration Name and Source Table are required" },
      { status: 400 }
    )
  }
  if (!(ENDPOINT_OPTIONS as readonly string[]).includes(endpoint)) {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 })
  }
  if (!(TEMPLATE_TYPES as readonly string[]).includes(templateType)) {
    return NextResponse.json({ error: "Invalid template type" }, { status: 400 })
  }
  try {
    assertIdent(sourceTable, "source table")
  } catch {
    return NextResponse.json({ error: "Source table name is not a valid identifier" }, { status: 400 })
  }

  try {
    // Verify the source table exists (name-only, matching the original).
    const exists = await executeSnowflakeQuery<{ CNT: number }>(
      `SELECT COUNT(1) AS CNT FROM ${SF_OPTS.database}.INFORMATION_SCHEMA.TABLES
       WHERE table_name = ${sqlString(sourceTable.toUpperCase())}`,
      SF_OPTS
    )
    if (Number(exists[0]?.CNT ?? 0) === 0) {
      return NextResponse.json(
        { error: `Source table '${sourceTable}' does not exist` },
        { status: 400 }
      )
    }

    const templateId = TEMPLATE_ID_BY_TYPE[templateType]
    const configId = randomUUID()
    const apiEndpoint = `${API_BASE}${endpoint}`
    const apiSettings = JSON.stringify({ external_source_id: externalSourceId, event_id: eventId })
    // Template configs stay inactive until mappings are provided.
    const isActive = templateId ? "FALSE" : "TRUE"

    await executeSnowflakeQueryWithMeta(
      `INSERT INTO ${CONFIGS_TABLE}
         (config_id, config_name, template_id, source_table, batch_size, api_endpoint,
          api_settings, is_active, created_at, updated_at)
       SELECT ${sqlString(configId)}, ${sqlString(configName)},
              ${templateId ? sqlString(templateId) : "NULL"}, ${sqlString(sourceTable)},
              100, ${sqlString(apiEndpoint)}, PARSE_JSON(${sqlString(apiSettings)}),
              ${isActive}, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
      SF_OPTS
    )

    return NextResponse.json({
      success: true,
      configId,
      templateId,
      sourceTable,
      needsMapping: !!templateId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/configs] create error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
