import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { HISTORY_TABLE, type EngaigeExecution } from "@/lib/engaige-shared"
import { SF_OPTS } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

// GET /api/engaige/executions — the 5 most recent executions per config, in one
// query (the Streamlit version issued a query per config in a loop).
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  try {
    // Timestamps as epoch ms (storage is UTC) so the browser can render them
    // in the viewer's local timezone.
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT batch_id, config_id,
              DATE_PART(EPOCH_MILLISECOND, start_time) AS start_ms,
              DATE_PART(EPOCH_MILLISECOND, end_time) AS end_ms,
              total_records, processed_records, failed_records, status,
              TIMESTAMPDIFF(second, start_time, COALESCE(end_time, CURRENT_TIMESTAMP())) AS duration_seconds
       FROM ${HISTORY_TABLE}
       QUALIFY ROW_NUMBER() OVER (PARTITION BY config_id ORDER BY start_time DESC) <= 5
       ORDER BY start_time DESC`,
      SF_OPTS
    )
    const executions: EngaigeExecution[] = rows.map((r) => ({
      batchId: String(r.BATCH_ID ?? ""),
      configId: String(r.CONFIG_ID ?? ""),
      startMs: r.START_MS == null ? null : Number(r.START_MS),
      endMs: r.END_MS == null ? null : Number(r.END_MS),
      totalRecords: Number(r.TOTAL_RECORDS ?? 0),
      processedRecords: Number(r.PROCESSED_RECORDS ?? 0),
      failedRecords: Number(r.FAILED_RECORDS ?? 0),
      status: String(r.STATUS ?? ""),
      durationSeconds: r.DURATION_SECONDS == null ? null : Number(r.DURATION_SECONDS),
    }))
    return NextResponse.json({ executions })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/executions] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
