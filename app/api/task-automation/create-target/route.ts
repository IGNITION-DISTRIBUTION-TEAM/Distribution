import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { getSync } from "@/lib/sftp-sync-registry"
import { buildSyncScript } from "@/lib/sftp-sync-codegen"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Create the target table for a job whose table has gone missing.
 *
 *   POST { syncName }
 *
 * Runs the CREATE TABLE the generator already produces for that config — not a
 * new one written here — so the table it builds is the table the sync was
 * designed against.
 *
 * REFUSED when the job was configured as "existing table". Those rows carry
 * VARCHAR(1000) placeholders in COLUMN_MAP_JSON rather than real types, because
 * the wizard read the types off the live table instead of choosing them.
 * Building from placeholders would replace a loud failure with a quiet wrong
 * answer, so the fix there is to reopen the job and switch it to
 * create-a-new-table, where the types are chosen deliberately.
 */
const IDENT = /^[A-Za-z0-9_]+$/

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  let body: { syncName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const name = String(body.syncName ?? "").trim().toUpperCase()
  if (!IDENT.test(name)) {
    return NextResponse.json({ error: `Invalid sync name: ${JSON.stringify(body.syncName)}` }, { status: 400 })
  }

  try {
    const row = await getSync(name)
    if (!row) return NextResponse.json({ error: `No job called ${name}.` }, { status: 404 })
    const target = `${row.config.targetDb}.${row.config.targetSchema}.${row.config.targetTable}`

    if (!row.config.createTable) {
      return NextResponse.json(
        {
          error:
            `${name} was set up against an existing table, so the job does not know that ` +
            `table's real column types — the ones it stored are VARCHAR(1000) placeholders. ` +
            `Creating it from those would give you a table that loads without complaining and ` +
            `holds the wrong types. Either create ${target} in Snowflake yourself, or open the ` +
            `job, switch Destination to "Create a new table", choose the types and deploy again.`,
        },
        { status: 400 }
      )
    }

    const built = buildSyncScript(row.config)
    const create = built.statements.find((s) => s.label.startsWith("Target table"))
    if (!create) {
      return NextResponse.json(
        { error: "The generator produced no CREATE TABLE for this job." },
        { status: 500 }
      )
    }

    const sf = { database: row.config.targetDb, schema: row.config.targetSchema }
    await executeSnowflakeQuery(create.sql, sf)
    // Prove it, rather than trusting the absence of an error.
    await executeSnowflakeQuery(`SELECT * FROM ${target} LIMIT 0`, sf)

    return NextResponse.json({ ok: true, created: target, sql: create.sql })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/create-target] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
