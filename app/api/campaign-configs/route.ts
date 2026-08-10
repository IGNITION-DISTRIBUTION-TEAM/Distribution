import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  parseConfigBody,
  sqlStr,
  getActorEmail,
  RUN_PROC_IDENT,
  TABLE as LEGACY_TABLE,
  SF_OPTS,
} from "@/app/api/campaign-config/route"
import { CONFIGS_TABLE, CONFIGS_COLUMNS, ensureConfigsTable } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Config columns copied when migrating a legacy single-config row (skip the
// run/audit columns — those start fresh).
const MIGRATE_SKIP = new Set(["LAST_RUN_AT", "LAST_RUN_STATUS", "LAST_RUN_MESSAGE", "CREATED_AT", "UPDATED_AT", "CREATED_BY", "UPDATED_BY", "CONFIG_NAME"])

// Map a raw value to a SQL literal for the given column type.
function literalFor(type: string, value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (type === "BOOLEAN") return value === true || String(value).toUpperCase() === "TRUE" ? "TRUE" : "FALSE"
  if (type === "NUMBER") { const n = Number(value); return Number.isFinite(n) ? String(n) : "NULL" }
  const s = String(value).trim()
  return s ? sqlStr(s) : "NULL"
}

// Build the shared [column, value] pairs from a validated config input.
// `updateHllList` is the (validated) list of update-HLL procedures to run.
function colsFromParsed(parsed: Record<string, unknown>, updateHllList: string[]): [string, string][] {
  const port = (parsed.sftpPort as number | undefined) ?? 22
  const authType = (parsed.sftpAuthType as string | undefined) ?? "password"
  return [
    ["CAMPAIGN_TITLE", sqlStr(parsed.campaignTitle)],
    ["LEAD_SOURCE", sqlStr(parsed.leadSource ?? "file")],
    ["SFTP_HOST", sqlStr(parsed.sftpHost)],
    ["SFTP_PORT", String(port)],
    ["SFTP_USERNAME", sqlStr(parsed.sftpUsername)],
    ["SFTP_PASSWORD", sqlStr(parsed.sftpPassword)],
    ["SFTP_PRIVATE_KEY", sqlStr(parsed.sftpPrivateKey)],
    ["SFTP_REMOTE_PATH", sqlStr(parsed.sftpRemotePath)],
    ["SFTP_AUTH_TYPE", sqlStr(authType)],
    ["UPLOAD_TARGET_TABLE", sqlStr(parsed.uploadTargetTable)],
    ["LOAD_HISTORY_PROCEDURE", sqlStr(parsed.loadHistoryProcedure)],
    // First proc kept in the legacy single column for backwards compat; the
    // full ordered list lives in UPDATE_HLL_PROCEDURES.
    ["UPDATE_HLL_PROCEDURE", sqlStr(updateHllList[0] ?? "")],
    ["UPDATE_HLL_PROCEDURES", updateHllList.length ? sqlStr(JSON.stringify(updateHllList)) : "NULL"],
    ["SYNC_PROCEDURE", sqlStr(parsed.syncProcedure)],
    ["SOURCE_KIND", sqlStr(parsed.sourceKind)],
    ["SOURCE_OBJECT", sqlStr(parsed.sourceObject)],
    ["SOURCE_MAPPING_JSON", parsed.sourceMappingJson ? sqlStr(parsed.sourceMappingJson) : "NULL"],
    ["LEAD_EXPIRY_DAYS", String((parsed.leadExpiryDays as number | undefined) ?? 45)],
    ["BATCH_NAME_TEMPLATE", sqlStr(parsed.batchNameTemplate)],
    ["IS_ACTIVE", parsed.isActive ? "TRUE" : "FALSE"],
  ]
}

// If a campaign has no configs yet but a legacy single-config row exists, copy
// it in as a "Default" config so existing setups aren't lost.
async function migrateLegacyIfNeeded(campaignId: number): Promise<void> {
  let legacy: Record<string, unknown> | undefined
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(`SELECT * FROM ${LEGACY_TABLE} WHERE CAMPAIGNID = ${campaignId}`, SF_OPTS)
    legacy = rows[0]
  } catch { return } // no legacy table / row — nothing to migrate
  if (!legacy) return
  const cols: string[] = ["CAMPAIGNID", "CONFIG_NAME"]
  const vals: string[] = [String(campaignId), sqlStr("Default")]
  for (const [name, type] of CONFIGS_COLUMNS) {
    if (name === "CAMPAIGNID" || MIGRATE_SKIP.has(name)) continue
    if (Object.prototype.hasOwnProperty.call(legacy, name)) {
      cols.push(name)
      vals.push(literalFor(type, legacy[name]))
    }
  }
  try {
    await executeSnowflakeQuery(`INSERT INTO ${CONFIGS_TABLE} (${cols.join(", ")}) VALUES (${vals.join(", ")})`, SF_OPTS)
  } catch (e) {
    console.error("[/api/campaign-configs] legacy migration failed:", e)
  }
}

// GET ?campaignId=… — list a campaign's automation configs (migrating a legacy
// single config in on first access).
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const campaignIdRaw = request.nextUrl.searchParams.get("campaignId") ?? ""
  if (!/^[0-9]+$/.test(campaignIdRaw)) return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  const campaignId = Number(campaignIdRaw)
  try {
    await ensureConfigsTable()
    const query = () =>
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT *, TO_VARCHAR(LAST_RUN_AT, 'YYYY-MM-DD HH24:MI') AS LAST_RUN_AT_FMT
         FROM ${CONFIGS_TABLE} WHERE CAMPAIGNID = ${campaignId} ORDER BY CONFIG_ID`,
        SF_OPTS
      )
    let rows = await query()
    if (rows.length === 0) { await migrateLegacyIfNeeded(campaignId); rows = await query() }
    for (const r of rows) if (r.LAST_RUN_AT_FMT != null) r.LAST_RUN_AT = r.LAST_RUN_AT_FMT
    return NextResponse.json({ configs: rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-configs GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST — create a new config (no configId) or update an existing one (configId).
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }

  const parsed = parseConfigBody(body)
  if ("error" in parsed) return NextResponse.json(parsed, { status: 400 })

  const name = String(body.name ?? "").trim() || "Automation"
  if (name.length > 200) return NextResponse.json({ error: "name is too long (max 200)" }, { status: 400 })
  const configIdRaw = body.configId
  const configId = configIdRaw != null && /^[0-9]+$/.test(String(configIdRaw)) ? Number(configIdRaw) : null
  const actor = getActorEmail(request)

  // Update-HLL procedures: the new multi list, falling back to the single field.
  const rawList = Array.isArray(body.updateHllProcedures)
    ? body.updateHllProcedures
    : (parsed.updateHllProcedure ? [parsed.updateHllProcedure] : [])
  const updateHllList = rawList.map((p) => String(p).trim()).filter(Boolean)
  const badProc = updateHllList.find((p) => !RUN_PROC_IDENT.test(p))
  if (badProc) return NextResponse.json({ error: `Update-HLL procedure is invalid: ${badProc}` }, { status: 400 })

  try {
    await ensureConfigsTable()
    const cols: [string, string][] = [["CONFIG_NAME", sqlStr(name)], ...colsFromParsed(parsed as unknown as Record<string, unknown>, updateHllList)]
    if (configId !== null) {
      const setSql = [...cols.map(([c, v]) => `${c} = ${v}`), "UPDATED_AT = CURRENT_TIMESTAMP()", `UPDATED_BY = ${sqlStr(actor)}`].join(", ")
      await executeSnowflakeQuery(`UPDATE ${CONFIGS_TABLE} SET ${setSql} WHERE CONFIG_ID = ${configId}`, SF_OPTS)
      return NextResponse.json({ ok: true, configId })
    }
    const insertCols = ["CAMPAIGNID", ...cols.map(([c]) => c), "CREATED_BY"].join(", ")
    const insertVals = [String(parsed.campaignId), ...cols.map(([, v]) => v), sqlStr(actor)].join(", ")
    await executeSnowflakeQuery(`INSERT INTO ${CONFIGS_TABLE} (${insertCols}) VALUES (${insertVals})`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-configs POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
