import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

export const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG"
export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// Fully-qualified DATABASE.SCHEMA.NAME, A-Z/0-9/_ only — used for both the
// upload target table and the sync procedure name.
const QUALIFIED_IDENT = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

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
  syncProcedure?: string
  isActive?: boolean
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
  if (loadHistoryProcedure && !QUALIFIED_IDENT.test(loadHistoryProcedure)) {
    return { error: 'loadHistoryProcedure must be "DATABASE.SCHEMA.PROC" (A-Z, 0-9, _ only)' }
  }

  const syncProcedure = body.syncProcedure ? String(body.syncProcedure).trim() : ""
  if (syncProcedure && !QUALIFIED_IDENT.test(syncProcedure)) {
    return { error: 'syncProcedure must be "DATABASE.SCHEMA.PROC" (A-Z, 0-9, _ only)' }
  }

  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

  return {
    campaignId,
    campaignTitle: str(body.campaignTitle),
    sftpHost: str(body.sftpHost),
    sftpPort,
    sftpUsername: str(body.sftpUsername),
    sftpPassword: str(body.sftpPassword),
    sftpPrivateKey: str(body.sftpPrivateKey),
    sftpRemotePath: str(body.sftpRemotePath),
    sftpAuthType,
    uploadTargetTable,
    loadHistoryProcedure,
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
    ["SYNC_PROCEDURE", sqlStr(parsed.syncProcedure)],
    ["IS_ACTIVE", parsed.isActive ? "TRUE" : "FALSE"],
  ]

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
