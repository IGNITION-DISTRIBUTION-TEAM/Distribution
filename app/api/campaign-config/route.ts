import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { normLeadExpiryDays, batchNameSql, DEFAULT_BATCH_TEMPLATE } from "@/lib/hll-insert"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// Fully-qualified DATABASE.SCHEMA.NAME, A-Z/0-9/_ only — used for the upload
// target table.
const QUALIFIED_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
// A procedure reference: DATABASE.SCHEMA.PROC, optionally with a call-argument
// list (e.g. SP_ONAIR_NEW_POOL_BR(1)). The argument list is passed to Snowflake
// VERBATIM — nothing is substituted — so the only things that work here are SQL
// literals valid on their own: numbers, and keywords such as NULL / TRUE. A bare
// identifier like PROC(campaignid) passes this check and then fails at run time
// on "invalid identifier"; there is no campaign-id placeholder.
// Only safe chars inside the parens — no quotes/semicolons.
const PROC_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\s*\([A-Za-z0-9_,\s]*\))?$/

/**
 * Normalise a pasted identifier before validating it.
 *
 * These values are usually pasted, and a paste out of a document, a chat window
 * or a SQL comment routinely carries a non-breaking space, a zero-width
 * character or a soft line break. None of those belong inside
 * DATABASE.SCHEMA.NAME, and left in place they fail the pattern while looking
 * completely correct on screen — which is close to impossible to diagnose from
 * the field alone.
 */
export function normIdent(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")      // zero-width and BOM
    .replace(/[\u00A0\u2007\u202F\u2000-\u200A]/g, " ") // non-breaking / typographic spaces
    .replace(/\s+/g, " ")                        // newlines and tabs
    .trim()
}

/**
 * Say what was actually received, and name the offending character when there
 * is one. "must be DATABASE.SCHEMA.NAME" is the rule, not the diagnosis — and
 * when the culprit is invisible the rule alone is no help at all.
 */
export function identProblem(value: string): string {
  if (!value) return " — the field was empty."
  const bad = Array.from(value).find((c) => !/[A-Za-z0-9_.,() ]/.test(c))
  if (bad) {
    const cp = (bad.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")
    return ` — received "${value}", which contains ${JSON.stringify(bad)} (U+${cp}). That character is not visible in the field; retype the value rather than pasting it.`
  }
  // A space before the argument list means the name itself is broken — usually a
  // line break in the pasted value, which normIdent turns into a space.
  const head = value.split("(")[0]
  if (/\s/.test(head)) {
    return ` — received "${value}". The name contains a space, which usually means the value was pasted across a line break.`
  }
  const dots = (head.match(/\./g) ?? []).length
  if (dots !== 2) {
    return ` — received "${value}", which has ${dots} dot${dots === 1 ? "" : "s"}. It needs exactly two: DATABASE.SCHEMA.NAME.`
  }
  return ` — received "${value}".`
}

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

// How a campaign's leads arrive. Distinct from sourceKind (proc/view), which
// only applies within the "snowflake" method.
export const LEAD_SOURCES = ["file", "sftp", "snowflake"] as const
export function normLeadSource(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase()
  return (LEAD_SOURCES as readonly string[]).includes(s) ? s : "file"
}

export type CampaignConfigInput = {
  campaignId: number
  campaignTitle?: string
  leadSource?: string
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
  sourceLoadFrom?: string
  sourceMappingJson?: string | null
  leadExpiryDays?: number
  batchNameTemplate?: string
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

  const uploadTargetTable = normIdent(body.uploadTargetTable)
  if (uploadTargetTable && !QUALIFIED_IDENT.test(uploadTargetTable)) {
    return { error: 'Upload target must be "DATABASE.SCHEMA.NAME" (A-Z, 0-9, _ only)' + identProblem(uploadTargetTable) }
  }

  const loadHistoryProcedure = normIdent(body.loadHistoryProcedure)
  if (loadHistoryProcedure && !PROC_IDENT.test(loadHistoryProcedure)) {
    return { error: 'Load-history procedure must be "DATABASE.SCHEMA.PROC" with optional (args)' + identProblem(loadHistoryProcedure) }
  }

  const updateHllProcedure = normIdent(body.updateHllProcedure)
  if (updateHllProcedure && !PROC_IDENT.test(updateHllProcedure)) {
    return { error: 'Update-HLL procedure must be "DATABASE.SCHEMA.PROC" with optional (args)' + identProblem(updateHllProcedure) }
  }

  const syncProcedure = normIdent(body.syncProcedure)
  if (syncProcedure && !PROC_IDENT.test(syncProcedure)) {
    return { error: 'Sync procedure must be "DATABASE.SCHEMA.PROC" with optional (args), e.g. DB.SCHEMA.SP_X(1)' + identProblem(syncProcedure) }
  }

  const sourceKind = body.sourceKind ? String(body.sourceKind).trim().toLowerCase() : "none"
  if (!["none", "proc", "view"].includes(sourceKind)) {
    return { error: "sourceKind must be none | proc | view" }
  }
  const sourceObject = normIdent(body.sourceObject)
  if (sourceObject && !PROC_IDENT.test(sourceObject)) {
    return { error: 'Procedure / view must be "DATABASE.SCHEMA.NAME" with optional (args)' + identProblem(sourceObject) }
  }
  // What the mapped INSERT reads, when it is not the upload target.
  const sourceLoadFrom = normIdent(body.sourceLoadFrom)
  if (sourceLoadFrom && !QUALIFIED_IDENT.test(sourceLoadFrom)) {
    return { error: 'Load from must be "DATABASE.SCHEMA.NAME" (A-Z, 0-9, _ only)' + identProblem(sourceLoadFrom) }
  }
  const sourceMappingJson = validateSourceMapping(body.sourceMapping)
  const leadExpiryDays = normLeadExpiryDays(body.leadExpiryDays)

  // Batch-name template: default when empty; reject anything that doesn't
  // compile to a safe expression.
  const batchNameTemplate = body.batchNameTemplate ? String(body.batchNameTemplate).trim() : DEFAULT_BATCH_TEMPLATE
  if (batchNameSql(batchNameTemplate, leadExpiryDays) === null) {
    return { error: `Batch name is invalid. Use letters, digits, _ . - and the tokens {date} and {expiry}, e.g. BATCH_ONAIR_ULTRA5{date} — received "${batchNameTemplate}"` }
  }

  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

  return {
    campaignId,
    campaignTitle: str(body.campaignTitle),
    leadSource: normLeadSource(body.leadSource),
    sourceKind,
    sourceObject,
    sourceLoadFrom,
    sourceMappingJson,
    leadExpiryDays,
    batchNameTemplate,
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
  ["LEAD_SOURCE", "VARCHAR"],
  ["SFTP_HOST", "VARCHAR"], ["SFTP_PORT", "NUMBER"], ["SFTP_USERNAME", "VARCHAR"],
  ["SFTP_PASSWORD", "VARCHAR"], ["SFTP_PRIVATE_KEY", "VARCHAR"], ["SFTP_REMOTE_PATH", "VARCHAR"],
  ["SFTP_AUTH_TYPE", "VARCHAR"], ["UPLOAD_TARGET_TABLE", "VARCHAR"],
  ["LOAD_HISTORY_PROCEDURE", "VARCHAR"], ["UPDATE_HLL_PROCEDURE", "VARCHAR"], ["SYNC_PROCEDURE", "VARCHAR"],
  ["SOURCE_KIND", "VARCHAR"], ["SOURCE_OBJECT", "VARCHAR"], ["SOURCE_MAPPING_JSON", "VARCHAR"],
  ["LEAD_EXPIRY_DAYS", "NUMBER"],
  ["BATCH_NAME_TEMPLATE", "VARCHAR"],
  ["IS_ACTIVE", "BOOLEAN"],
  // Last full-distribution run outcome (set by the campaign run orchestrator).
  ["LAST_RUN_AT", "TIMESTAMP_NTZ"], ["LAST_RUN_STATUS", "VARCHAR"], ["LAST_RUN_MESSAGE", "VARCHAR"],
  ["CREATED_BY", "VARCHAR"], ["CREATED_AT", "TIMESTAMP_NTZ"],
  ["UPDATED_BY", "VARCHAR"], ["UPDATED_AT", "TIMESTAMP_NTZ"],
]

// Shared regexes for the run orchestrator — re-validate stored values before executing.
export const RUN_QUALIFIED = QUALIFIED_IDENT
export const RUN_PROC_IDENT = PROC_IDENT

// Ensure the config table has every column, including the run-tracking ones.
export async function ensurePublicConfigColumns(): Promise<Set<string>> {
  return ensureConfigColumns()
}

// Best-effort schema-prep: create the table if absent, then try to add any
// missing columns. Returns the UPPERCASE set of columns that exist afterward.
// Each step is wrapped so it never throws — the app role may lack rights to
// CREATE/ALTER this table (a missing OPTIONAL column must not block a save).
// The caller writes only to columns that actually exist.
async function ensureConfigColumns(): Promise<Set<string>> {
  try {
    await executeSnowflakeQuery(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (${CONFIG_COLUMNS.map(([n, t]) => `${n} ${t}`).join(", ")})`,
      SF_OPTS
    )
  } catch (e) {
    console.error("[campaign-config] create-if-not-exists (best-effort):", e instanceof Error ? e.message : e)
  }

  const have = new Set<string>()
  try {
    const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION' AND TABLE_NAME = 'TSK_CAMPAIGN_AUTOMATION_CONFIG'`,
      SF_OPTS
    )
    for (const r of existing) have.add(String(r.COLUMN_NAME).toUpperCase())
  } catch (e) {
    console.error("[campaign-config] column introspection failed:", e instanceof Error ? e.message : e)
    // Can't tell what exists — assume the full schema so we don't wrongly drop
    // columns from the upsert. A genuinely-missing column then surfaces as a
    // clear Snowflake "invalid identifier" error instead of silent data loss.
    for (const [name] of CONFIG_COLUMNS) have.add(name)
    return have
  }

  for (const [name, type] of CONFIG_COLUMNS) {
    if (name === "CAMPAIGNID") continue // the key column must already exist
    if (!have.has(name)) {
      try {
        await executeSnowflakeQuery(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${type}`, SF_OPTS)
        have.add(name)
      } catch (e) {
        // Likely insufficient privileges to ALTER. Skip — the column simply
        // won't be written to until an admin adds it (see README/grants).
        console.error(`[campaign-config] could not add column ${name} (best-effort):`, e instanceof Error ? e.message : e)
      }
    }
  }
  return have
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
    ["UPDATE_HLL_PROCEDURE", sqlStr(parsed.updateHllProcedure)],
    ["SYNC_PROCEDURE", sqlStr(parsed.syncProcedure)],
    ["SOURCE_KIND", sqlStr(parsed.sourceKind)],
    ["SOURCE_OBJECT", sqlStr(parsed.sourceObject)],
    ["SOURCE_MAPPING_JSON", parsed.sourceMappingJson ? sqlStr(parsed.sourceMappingJson) : "NULL"],
    ["LEAD_EXPIRY_DAYS", String(parsed.leadExpiryDays ?? 45)],
    ["BATCH_NAME_TEMPLATE", sqlStr(parsed.batchNameTemplate ?? DEFAULT_BATCH_TEMPLATE)],
    ["IS_ACTIVE", parsed.isActive ? "TRUE" : "FALSE"],
  ]

  // Make sure the table has every column the upsert writes to — older/partial
  // config tables can be missing some (e.g. UPDATE_HLL_PROCEDURE, SOURCE_*).
  // Best-effort: returns the columns that actually exist. If the app role
  // can't add a missing column, we write only to what exists rather than
  // failing the whole save (and warn about anything we had to drop).
  const existingCols = await ensureConfigColumns()

  const writableCols = cols.filter(([c]) => existingCols.has(c))
  // Columns the user actually gave a value for but that don't exist and
  // couldn't be created — these silently won't be saved, so tell them.
  const droppedWithValue = cols
    .filter(([c, v]) => !existingCols.has(c) && v !== "NULL" && v !== "FALSE")
    .map(([c]) => c)
  if (writableCols.length === 0) {
    return NextResponse.json(
      { error: "The config table is missing the expected columns and the app can't add them. Ask an admin to grant column-modify rights or add the columns (see grants)." },
      { status: 500 }
    )
  }

  const updateSet = [
    ...writableCols.map(([c, v]) => `${c} = ${v}`),
    "UPDATED_AT = CURRENT_TIMESTAMP()",
    `UPDATED_BY = ${sqlStr(actor)}`,
  ].join(", ")

  const insertCols = ["CAMPAIGNID", ...writableCols.map(([c]) => c), "CREATED_BY"].join(", ")
  const insertVals = [String(parsed.campaignId), ...writableCols.map(([, v]) => v), sqlStr(actor)].join(", ")

  const sql = `
    MERGE INTO ${TABLE} t
    USING (SELECT ${parsed.campaignId} AS CAMPAIGNID) s
    ON t.CAMPAIGNID = s.CAMPAIGNID
    WHEN MATCHED THEN UPDATE SET ${updateSet}
    WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})
  `

  try {
    await executeSnowflakeQuery(sql, SF_OPTS)
    return NextResponse.json({
      ok: true,
      campaignId: parsed.campaignId,
      ...(droppedWithValue.length
        ? { warning: `Saved, but these fields couldn't be stored (column missing / no rights to add): ${droppedWithValue.join(", ")}.` }
        : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaign-config POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
