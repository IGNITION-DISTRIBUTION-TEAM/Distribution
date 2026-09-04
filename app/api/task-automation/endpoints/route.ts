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
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<{
      ENDPOINT_NAME: string
      LABEL: string | null
      ALLOWED_ROOT: string | null
      ENABLED: boolean | string | null
    }>(
      `SELECT ENDPOINT_NAME, LABEL, ALLOWED_ROOT, ENABLED
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
