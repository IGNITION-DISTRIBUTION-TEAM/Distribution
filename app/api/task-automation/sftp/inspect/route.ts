import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

/**
 * Browse the SFTP, or read the head of one file.
 *
 * The app cannot reach the SFTP itself — the private key lives in a Snowflake
 * secret and stays there. Everything goes through SP_SFTP_INSPECT, which runs
 * as its owner and hands back JSON.
 *
 *   POST { endpoint, path, action: "list" | "peek", maxRows? }
 *
 * The procedure NEVER RAISES. It returns status SUCCESS or FAILED with an
 * error_message, so a CALL that "worked" proves nothing — the status field is
 * checked here and a FAILED result is surfaced as an error rather than as an
 * empty listing.
 */
const PROC = "SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT"
const SF = { database: "SPOT_DW", schema: "SFTP_ADMIN" } as const

const ACTIONS = new Set(["list", "peek"])
/** Endpoint names are interpolated into the CALL, so they are identifiers. */
const ENDPOINT_RE = /^[A-Za-z0-9_]+$/

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`

export type SftpEntry = {
  name: string
  is_dir: boolean
  size: number | null
  mtime_epoch: number | null
  path: string
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: { endpoint?: unknown; path?: unknown; action?: unknown; maxRows?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const endpoint = String(body.endpoint ?? "").trim().toUpperCase()
  if (!ENDPOINT_RE.test(endpoint)) {
    return NextResponse.json(
      { error: `Endpoint name must be letters, digits and underscores. Got ${JSON.stringify(body.endpoint)}.` },
      { status: 400 }
    )
  }

  const action = String(body.action ?? "list").trim().toLowerCase()
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: `action must be "list" or "peek".` }, { status: 400 })
  }

  // The path is passed as a bound-style literal and validated server-side by
  // the procedure against the endpoint's ROOT_FLOOR. Escaping the quote here is
  // enough for the CALL; the boundary itself is enforced in Snowflake, where
  // the app cannot move it.
  const path = String(body.path ?? "")
  const maxRowsRaw = Number(body.maxRows)
  const maxRows = Number.isInteger(maxRowsRaw) && maxRowsRaw > 0 ? maxRowsRaw : action === "peek" ? 20 : 500

  const sql = `CALL ${PROC}(${sqlLit(endpoint)}, ${sqlLit(path)}, ${sqlLit(action)}, ${maxRows})`

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(sql, SF)
    // A CALL returns one row, one column, named after the procedure.
    const first = rows[0] ?? {}
    const raw = Object.values(first)[0]
    const result = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)

    if (!result || result.status !== "SUCCESS") {
      return NextResponse.json(
        {
          error: String(result?.error_message ?? "The procedure returned no status."),
          endpoint,
          path: result?.path ?? path,
          allowedRoot: result?.allowed_root ?? null,
          rootFloor: result?.root_floor ?? null,
        },
        { status: 400 }
      )
    }

    return NextResponse.json({
      action,
      endpoint,
      path: result.path,
      allowedRoot: result.allowed_root,
      rootFloor: result.root_floor,
      // list
      entries: result.entries ?? null,
      entryCount: result.entry_count ?? null,
      truncated: result.truncated ?? false,
      // peek
      lines: result.lines ?? null,
      lineCount: result.line_count ?? null,
      size: result.size ?? null,
      mtimeEpoch: result.mtime_epoch ?? null,
      byteCapped: result.byte_capped ?? false,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/sftp/inspect] error:", message)
    return NextResponse.json(
      {
        error:
          `${message}\n\nRan: ${sql}\n\nIf Snowflake reports an unknown function, ` +
          `either ${PROC} has not been created (01-bootstrap.sql section 5) or the ` +
          `app's role has no USAGE on it (section 7) — the message is the same ` +
          `either way. /api/distribution/snowflake-identity?object=${PROC} tells ` +
          `you which.`,
      },
      { status: 500 }
    )
  }
}
