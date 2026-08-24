import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Temp upload — refresh today's batch counts.
 *
 * Runs the agreed three steps in order:
 *
 *   TRUNCATE TABLE ...TEMP_UPLOAD
 *   CALL ...SP_SYNC_BATCH_COUNTS_TODAY()
 *   SELECT * FROM ...TEMP_UPLOAD
 *
 * Order matters and the steps are sequential, not parallel: the truncate must
 * land before the procedure fills the table, and the select must run after.
 *
 * TEMP_UPLOAD is a staging table that this process owns — truncating it is the
 * intended behaviour, not a side effect. It is called out in the UI so nobody is
 * surprised by it.
 *
 * GET  returns the current contents without running anything.
 * POST runs the refresh and returns the new contents.
 */

const SCHEMA = "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION"
const TABLE = `${SCHEMA}.TEMP_UPLOAD`
const PROC = `${SCHEMA}.SP_SYNC_BATCH_COUNTS_TODAY`
const SF = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_AUTOMATION" } as const

type StepLog = { step: string; ms: number; detail?: string }

async function readTable() {
  const { columns, rows } = await executeSnowflakeQueryWithMeta(
    `SELECT * FROM ${TABLE}`,
    SF
  )
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    rows,
  }
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  try {
    const { columns, rows } = await readTable()
    return NextResponse.json({ ok: true, ran: false, columns, rows, steps: [] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/temp-upload] GET error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const steps: StepLog[] = []
  const timed = async <T,>(step: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      const out = await fn()
      steps.push({ step, ms: Date.now() - started })
      return out
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      steps.push({ step, ms: Date.now() - started, detail: message })
      // Name the step that failed. "Snowflake query failed" on its own leaves you
      // guessing whether the truncate, the procedure or the read went wrong.
      throw new Error(`${step} failed: ${message}`)
    }
  }

  try {
    await timed("Truncate TEMP_UPLOAD", () =>
      executeSnowflakeQuery(`TRUNCATE TABLE ${TABLE}`, SF)
    )
    await timed("Call SP_SYNC_BATCH_COUNTS_TODAY", () =>
      executeSnowflakeQuery(`CALL ${PROC}()`, SF)
    )
    const { columns, rows } = await timed("Read TEMP_UPLOAD", readTable)

    return NextResponse.json({
      ok: true,
      ran: true,
      columns,
      rows,
      steps,
      ranBy: guard.email,
      ranAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/temp-upload] POST error:", message)
    return NextResponse.json({ error: message, steps }, { status: 500 })
  }
}
