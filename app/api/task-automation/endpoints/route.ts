import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The SFTP endpoints this app may browse.
 *
 * Reads the SECURE VIEW, never the registry table. The table holds the host,
 * the SFTP user and the pinned host key; the app deliberately has no privilege
 * on it, because a row pairs a host with the key that will be trusted for it
 * and write access there would make the pinning decorative.
 *
 * So this returns four harmless fields, and that is all the app can see.
 */
const VIEW = "SPOT_DW.SFTP_ADMIN.VW_SFTP_ENDPOINTS_APP"
const SF = { database: "SPOT_DW", schema: "SFTP_ADMIN" } as const

export type SftpEndpoint = {
  name: string
  label: string
  /** Where browsing starts. The procedure enforces its own floor regardless. */
  allowedRoot: string
  enabled: boolean
  /** The hard boundary. Not editable from the app, shown so it is not a mystery. */
  rootFloor: string
  maxEntries: number
  maxPeekLines: number
  maxPeekBytes: number
  notes: string
  updatedAt: string | null
  updatedBy: string | null
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT ENDPOINT_NAME, LABEL, ROOT_FLOOR, ALLOWED_ROOT,
              MAX_ENTRIES, MAX_PEEK_LINES, MAX_PEEK_BYTES,
              ENABLED, NOTES, UPDATED_AT, UPDATED_BY
         FROM ${VIEW}
        ORDER BY ENDPOINT_NAME`,
      SF
    )

    const endpoints: SftpEndpoint[] = rows.map((r) => ({
      name: String(r.ENDPOINT_NAME),
      label: r.LABEL ? String(r.LABEL) : String(r.ENDPOINT_NAME),
      allowedRoot: r.ALLOWED_ROOT ? String(r.ALLOWED_ROOT) : "/",
      // Snowflake's REST API can hand a boolean back as the string "true".
      enabled: r.ENABLED === true || String(r.ENABLED).toLowerCase() === "true",
      rootFloor: r.ROOT_FLOOR ? String(r.ROOT_FLOOR) : "/",
      maxEntries: Number(r.MAX_ENTRIES ?? 0),
      maxPeekLines: Number(r.MAX_PEEK_LINES ?? 0),
      maxPeekBytes: Number(r.MAX_PEEK_BYTES ?? 0),
      notes: r.NOTES ? String(r.NOTES) : "",
      updatedAt: r.UPDATED_AT == null ? null : String(r.UPDATED_AT),
      updatedBy: r.UPDATED_BY == null ? null : String(r.UPDATED_BY),
    }))

    return NextResponse.json({ endpoints })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/endpoints] error:", message)
    return NextResponse.json(
      {
        error:
          `${message}\n\nThis reads ${VIEW}. If it reports the view does not ` +
          `exist, run scripts/task-automation/01-bootstrap.sql; if it reports a ` +
          `privilege problem, run section 4b of 00-grants.sql. Snowflake words ` +
          `both the same way.`,
      },
      { status: 500 }
    )
  }
}

/**
 * Edit an endpoint's app-editable fields.
 *
 *   PATCH { name, label, allowedRoot, maxEntries, maxPeekLines, maxPeekBytes, enabled, notes }
 *
 * Goes through SP_SFTP_ENDPOINT_UPDATE, which is owned by ACCOUNTADMIN and
 * accepts only these fields. Snowflake has no column-level UPDATE privilege, so
 * that procedure IS the access control: it is the reason the app can change a
 * label and a cap but not the host, the SFTP user or the pinned host key.
 *
 * The signed-in user is passed as ACTOR and lands in UPDATED_BY. It is
 * app-asserted — Snowflake sees one service user for everyone — and the column
 * comment in the registry says so.
 */
const UPDATE_PROC = "SPOT_DW.SFTP_ADMIN.SP_SFTP_ENDPOINT_UPDATE"
const NAME_RE = /^[A-Za-z0-9_]+$/
const sqlLit = (v: string) => `'${String(v).replace(/'/g, "''")}'`

export async function PATCH(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const name = String(body.name ?? "").trim().toUpperCase()
  if (!NAME_RE.test(name)) {
    return NextResponse.json({ error: `Invalid endpoint name: ${JSON.stringify(body.name)}` }, { status: 400 })
  }

  const num = (v: unknown, what: string): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a positive whole number.`)
    return n
  }

  try {
    const sql =
      `CALL ${UPDATE_PROC}(` +
      [
        sqlLit(name),
        sqlLit(guard.email),
        sqlLit(String(body.label ?? "")),
        sqlLit(String(body.allowedRoot ?? "")),
        num(body.maxEntries, "Max entries"),
        num(body.maxPeekLines, "Max peek lines"),
        num(body.maxPeekBytes, "Max peek bytes"),
        body.enabled === true || String(body.enabled).toLowerCase() === "true" ? "TRUE" : "FALSE",
        sqlLit(String(body.notes ?? "")),
      ].join(", ") +
      `)`

    const rows = await executeSnowflakeQuery<Record<string, unknown>>(sql, SF)
    const raw = Object.values(rows[0] ?? {})[0]
    const result = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)

    // The procedure never raises — it returns a status — so a CALL that
    // "worked" proves nothing on its own.
    if (!result || result.status !== "SUCCESS") {
      return NextResponse.json(
        { error: String(result?.error_message ?? "The procedure returned no status.") },
        { status: 400 }
      )
    }
    return NextResponse.json({ ok: true, endpoint: name, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/endpoints] PATCH error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
