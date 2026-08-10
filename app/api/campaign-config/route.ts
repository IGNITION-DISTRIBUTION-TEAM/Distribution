import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// Fully-qualified DATABASE.SCHEMA.NAME, A-Z/0-9/_ only — used for the upload
// target table.
const QUALIFIED_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
// A procedure reference: DATABASE.SCHEMA.PROC, optionally with a call-argument
// list of digits / identifiers / commas (e.g. SP_ONAIR_NEW_POOL_BR(1) or
// PROC(campaignid)). Only safe chars inside the parens — no quotes/semicolons.
const PROC_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\s*\([A-Za-z0-9_,\s]*\))?$/

export function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

/** Render a string column value: NULL when empty, otherwise a quoted literal. */
export function sqlStr(v: unknown): string {
  if (v === undefined || v === null) return "NULL"
  const s = String(v).trim()
  if (s === "") return "NULL"
  return `'${escapeSqlString(s)}'`
}

export type CampaignConfigInput = {
  campaignId: number
  campaignTitle?: string
  sftpHost?: string
  sftpPort?: number
  sftpUsername?: string
  sftpPassword?: string
  sftpPrivateKey?: string
  sftpRemotePath?: string
  sftpAuthType?: string
  uploadTargetTable?: string
  loadHistoryProcedure?: string
  updateHllProcedure?: string
  syncProcedure?: string
  // Step 1 — initial source: a proc that fills the stage/upload table, or a
  // view read directly into HLL (with a column mapping).
  sourceKind?: string
  sourceObject?: string
  sourceMappingJson?: string | null
  isActive?: boolean
}

const IDENT_COL = /^[A-Za-z0-9_]+$/
// Validate a { hllColumn: viewColumn } map for the view→HLL source; JSON or null.
function validateSourceMapping(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object") return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const src = typeof v === "string" ? v.trim() : ""
    if (src && IDENT_COL.test(k) && IDENT_COL.test(src)) out[k] = src
  }
  const keys = Object.keys(out)
  return keys.length && keys.length <= 500 ? JSON.stringify(out) : null
}

/** Validate and normalise the request body. Returns the cleaned input or an error string. */
export function parseConfigBody(body: Record<string, unknown>): CampaignConfigInput | { error: string } {
  const campaignIdRaw = body.campaignId
  if (!campaignIdRaw || !/^[0-9]+$/.test(String(campaignIdRaw))) {
    return { error: "campaignId must be a positive integer" }
  }
  const campaignId = Number(campaignIdRaw)

  let sftpPort: number | undefined
  if (body.sftpPort !== undefined && body.sftpPort !== null && String(body.sftpPort).trim() !== "") {
    const p = Number(body.sftpPort)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { error: "sftpPort must be an integer 1-65535" }
    }
    sftpPort = p
  }

  let sftpAuthType: string | undefined
  if (body.sftpAuthType !== undefined && body.sftpAuthType !== null && String(body.sftpAuthType).trim() !== "") {
    const a = String(body.sftpAuthType).trim()
    if (a !== "password" && a !== "privateKey") {
      return { error: 'sftpAuthType must be "password" or "privateKey"' }
    }
    sftpAuthType = a
  }

  const uploadTargetTable = body.uploadTargetTable ? String(body.uploadTargetTable).trim() : ""
  if (uploadTargetTable && !QUALIFIED_IDENT.test(uploadTargetTable)) {
    return { error: 'uploadTargetTable must be "DATABASE.SCHEMA.NAME" (A-Z, 0-9, _ only)' }
  }

  const loadHistoryProcedure = body.loadHistoryProcedure
    ? String(body.loadHistoryProcedure).trim()
    : ""
  if (loadHistoryProcedure && !PROC_IDENT.test(loadHistoryProcedure)) {
    return { error: 'loadHistoryProcedure must be "DATABASE.SCHEMA.PROC" with optional (args)' }
  }

  const updateHllProcedure = body.updateHllProcedure
    ? String(body.updateHllProcedure).trim()
    : ""
  if (updateHllProcedure && !PROC_IDENT.test(updateHllProcedure)) {
    return { error: 'updateHllProcedure must be "DATABASE.SCHEMA.PROC" with optional (args)' }
  }

  const syncProcedure = body.syncProcedure ? String(body.syncProcedure).trim() : ""
  if (syncProcedure && !PROC_IDENT.test(syncProcedure)) {
    return { error: 'syncProcedure must be "DATABASE.SCHEMA.PROC" with optional (args), e.g. DB.SCHEMA.SP_X(1)' }
  }

  const sourceKind = body.sourceKind ? String(body.sourceKind).trim().toLowerCase() : "none"
  if (!["none", "proc", "view"].includes(sourceKind)) {
    return { error: "sourceKind must be none | proc | view" }
  }
  const sourceObject = body.sourceObject ? String(body.sourceObject).trim() : ""
  if (sourceObject && !PROC_IDENT.test(sourceObject)) {
    return { error: 'sourceObject must be "DATABASE.SCHEMA.NAME" with optional (args)' }
  }
  const sourceMappingJson = validateSourceMapping(body.sourceMapping)

  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

  return {
    campaignId,
    campaignTitle: str(body.campaignTitle),
    sourceKind,
    sourceObject,
    sourceMappingJson,
    sftpHost: str(body.sftpHost),
    sftpPort,
    sftpUsername: str(body.sftpUsername),
    sftpPassword: str(body.sftpPassword),
    sftpPrivateKey: str(body.sftpPrivateKey),
    sftpRemotePath: str(body.sftpRemotePath),
    sftpAuthType,
    uploadTargetTable,
    loadHistoryProcedure,
    updateHllProcedure,
    syncProcedure,
    isActive: body.isActive === undefined ? true : !!body.isActive,
  }
}

export function getActorEmail(request: NextRequest): string | null {
  try {
    const cookie = request.cookies.get("azure_session")?.value
    if (!cookie) return null
    const session = JSON.parse(cookie) as { email?: unknown }
    return typeof session.email === "string" ? session.email : null
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT * FROM ${TABLE} ORDER BY CAMPAIGNID`,
      SF_OPTS
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Every column the upsert touches, with its type. Used to create the table
// if absent and to add any missing columns to a pre-existing/partial table.
const CONFIG_COLUMNS: [string, string][] = [
  ["CAMPAIGNID", "NUMBER"],
  ["CAMPAIGN_TITLE", "VARCHAR"],
  ["SFTP_HOST", "VARCHAR"], ["SFTP_PORT", "NUMBER"], ["SFTP_USERNAME", "VARCHAR"],
  ["SFTP_PASSWORD", "VARCHAR"], ["SFTP_PRIVATE_KEY", "VARCHAR"], ["SFTP_REMOTE_PATH", "VARCHAR"],
  ["SFTP_AUTH_TYPE", "VARCHAR"], ["UPLOAD_TARGET_TABLE", "VARCHAR"],
  ["LOAD_HISTORY_PROCEDURE", "VARCHAR"], ["UPDATE_HLL_PROCEDURE", "VARCHAR"], ["SYNC_PROCEDURE", "VARCHAR"],
  ["SOURCE_KIND", "VARCHAR"], ["SOURCE_OBJECT", "VARCHAR"], ["SOURCE_MAPPING_JSON", "VARCHAR"],
  ["IS_ACTIVE", "BOOLEAN"],
  ["CREATED_BY", "VARCHAR"], ["CREATED_AT", "TIMESTAMP_NTZ"],
  ["UPDATED_BY", "VARCHAR"], ["UPDATED_AT", "TIMESTAMP_NTZ"],
]

async function ensureConfigColumns(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (${CONFIG_COLUMNS.map(([n, t]) => `${n} ${t}`).join(", ")})`,
    SF_OPTS
  )
  const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION' AND TABLE_NAME = 'TSK_CAMPAIGN_AUTOMATION_CONFIG'`,
    SF_OPTS
  )
  const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toUpperCase()))
  for (const [name, type] of CONFIG_COLUMNS) {
    if (name === "CAMPAIGNID") continue // the key column must already exist
    if (!have.has(name)) {
      await executeSnowflakeQuery(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${type}`, SF_OPTS)
    }
  }
}

// Upsert (insert or update) a campaign's config row, keyed by CAMPAIGNID.
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = parseConfigBody(body)
  if ("error" in parsed) return NextResponse.json(parsed, { status: 400 })

  const actor = getActorEmail(request)
  const port = parsed.sftpPort ?? 22
  const authType = parsed.sftpAuthType ?? "password"

  // Column/value pairs shared between the UPDATE and INSERT branches.
  const cols: [string, string][] = [
    ["CAMPAIGN_TITLE", sqlStr(parsed.campaignTitle)],
    ["SFTP_HOST", sqlStr(parsed.sftpHost)],
    ["SFTP_PORT", String(port)],
    ["SFTP_USERNAME", sqlStr(parsed.sftpUsername)],
    ["SFTP_PASSWORD", sqlStr(parsed.sftpPassword)],
    ["SFTP_PRIVATE_KEY", sqlStr(parsed.sftpPrivateKey)],
    ["SFTP_REMOTE_PATH", sqlStr(parsed.sftpRemotePath)],
    ["SFTP_AUTH_TYPE", sqlStr(authType)],
    ["UPLOAD_TARGET_TABLE", sqlStr(parsed.uploadTargetTable)],
    ["LOAD_HISTORY_PROCEDURE", sqlStr(parsed.loadHistoryProcedure)],
    ["UPDATE_HLL_PROCEDURE", sqlStr(parsed.updateHllProcedure)],
    ["SYNC_PROCEDURE", sqlStr(parsed.syncProcedure)],
    ["SOURCE_KIND", sqlStr(parsed.sourceKind)],
    ["SOURCE_OBJECT", sqlStr(parsed.sourceObject)],
    ["SOURCE_MAPPING_JSON", parsed.sourceMappingJson ? sqlStr(parsed.sourceMappingJson) : "NULL"],
    ["IS_ACTIVE", parsed.isActive ? "TRUE" : "FALSE"],
  ]

  // Make sure the table has every column the upsert writes to — older/partial
  // config tables can be missing some (e.g. UPDATE_HLL_PROCEDURE, SOURCE_*),
  // which makes the MERGE fail to compile. Add any that are absent.
  try {
    await ensureConfigColumns()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config POST] ensureConfigColumns error:", message)
    return NextResponse.json({ error: `Could not prepare the config table: ${message}` }, { status: 500 })
  }

  const updateSet = [
    ...cols.map(([c, v]) => `${c} = ${v}`),
    "UPDATED_AT = CURRENT_TIMESTAMP()",
    `UPDATED_BY = ${sqlStr(actor)}`,
  ].join(", ")

  const insertCols = ["CAMPAIGNID", ...cols.map(([c]) => c), "CREATED_BY"].join(", ")
  const insertVals = [String(parsed.campaignId), ...cols.map(([, v]) => v), sqlStr(actor)].join(", ")

  const sql = `
    MERGE INTO ${TABLE} t
    USING (SELECT ${parsed.campaignId} AS CAMPAIGNID) s
    ON t.CAMPAIGNID = s.CAMPAIGNID
    WHEN MATCHED THEN UPDATE SET ${updateSet}
    WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})
  `

  try {
    await executeSnowflakeQuery(sql, SF_OPTS)
    return NextResponse.json({ ok: true, campaignId: parsed.campaignId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
