import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  CONFIGS_TABLE,
  HISTORY_TABLE,
  API_LOGS_TABLE,
  ASSIGNMENTS_TABLE,
} from "@/lib/engaige-shared"
import { SF_OPTS, sqlString, safeJsonParse } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUSES = ["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]
const BATCH_RE = /^[0-9a-fA-F-]{8,64}$/

// GET /api/engaige/monitoring?view=history|metrics|schedule|errors
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  const p = request.nextUrl.searchParams
  const view = p.get("view") ?? "history"

  try {
    if (view === "history") {
      const date = p.get("date") ?? ""
      const status = p.get("status") ?? "All"
      const configName = p.get("config") ?? "All"
      if (!DATE_RE.test(date)) {
        return NextResponse.json({ error: "Invalid date" }, { status: 400 })
      }
      let where = `WHERE DATE(p.start_time) = ${sqlString(date)}`
      if (STATUSES.includes(status)) where += ` AND p.status = ${sqlString(status)}`
      if (configName !== "All") where += ` AND c.config_name = ${sqlString(configName)}`

      const rows = await executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT p.batch_id, c.config_name,
                TO_VARCHAR(p.start_time, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
                TO_VARCHAR(p.end_time, 'YYYY-MM-DD HH24:MI:SS') AS end_time,
                p.total_records, p.processed_records, p.failed_records, p.status,
                TIMESTAMPDIFF(second, p.start_time, COALESCE(p.end_time, CURRENT_TIMESTAMP())) AS duration_seconds
         FROM ${HISTORY_TABLE} p
         JOIN ${CONFIGS_TABLE} c ON c.config_id = p.config_id
         ${where} ORDER BY p.start_time DESC`,
        SF_OPTS
      )
      const records = rows.map((r) => ({
        batchId: String(r.BATCH_ID ?? ""),
        configName: String(r.CONFIG_NAME ?? ""),
        startTime: r.START_TIME == null ? null : String(r.START_TIME),
        endTime: r.END_TIME == null ? null : String(r.END_TIME),
        totalRecords: Number(r.TOTAL_RECORDS ?? 0),
        processedRecords: Number(r.PROCESSED_RECORDS ?? 0),
        failedRecords: Number(r.FAILED_RECORDS ?? 0),
        status: String(r.STATUS ?? ""),
        durationSeconds: r.DURATION_SECONDS == null ? null : Number(r.DURATION_SECONDS),
      }))
      const total = records.length
      const completed = records.filter((r) => r.status === "COMPLETED").length
      return NextResponse.json({
        records,
        summary: {
          totalBatches: total,
          successRate: total > 0 ? (completed / total) * 100 : 0,
          totalRecords: records.reduce((a, r) => a + r.totalRecords, 0),
          failedRecords: records.reduce((a, r) => a + r.failedRecords, 0),
        },
      })
    }

    if (view === "metrics") {
      const start = p.get("start") ?? ""
      const end = p.get("end") ?? ""
      if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
        return NextResponse.json({ error: "Invalid date range" }, { status: 400 })
      }
      const rows = await executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT TO_VARCHAR(DATE(start_time), 'YYYY-MM-DD') AS process_date,
                COUNT(*) AS total_batches,
                SUM(total_records) AS total_records,
                SUM(processed_records) AS processed_records,
                SUM(failed_records) AS failed_records,
                AVG(TIMESTAMPDIFF(second, start_time, end_time)) AS avg_duration_seconds,
                COUNT_IF(status = 'COMPLETED') AS completed_batches,
                COUNT_IF(status = 'FAILED') AS failed_batches
         FROM ${HISTORY_TABLE}
         WHERE DATE(start_time) BETWEEN ${sqlString(start)} AND ${sqlString(end)}
         GROUP BY DATE(start_time) ORDER BY DATE(start_time)`,
        SF_OPTS
      )
      const metrics = rows.map((r) => {
        const totalBatches = Number(r.TOTAL_BATCHES ?? 0)
        const completed = Number(r.COMPLETED_BATCHES ?? 0)
        return {
          date: String(r.PROCESS_DATE ?? ""),
          totalBatches,
          totalRecords: Number(r.TOTAL_RECORDS ?? 0),
          processedRecords: Number(r.PROCESSED_RECORDS ?? 0),
          failedRecords: Number(r.FAILED_RECORDS ?? 0),
          avgDurationSeconds: r.AVG_DURATION_SECONDS == null ? 0 : Number(r.AVG_DURATION_SECONDS),
          successRate: totalBatches > 0 ? (completed / totalBatches) * 100 : 0,
        }
      })
      return NextResponse.json({ metrics })
    }

    if (view === "schedule") {
      // Summary rows + assignment grid for the weekly heatmap.
      const [summary, grid] = await Promise.all([
        executeSnowflakeQuery<Record<string, unknown>>(
          `SELECT c.config_name,
                  LISTAGG(DISTINCT
                    CASE ta.schedule_type
                      WHEN 'DAILY' THEN 'Daily'
                      WHEN 'WEEKDAYS' THEN 'Weekdays'
                      WHEN 'WEEKENDS' THEN 'Weekends'
                      WHEN 'SPECIFIC DAYS' THEN 'Specific: '
                        || IFF(ta.monday,'M','') || IFF(ta.tuesday,'T','') || IFF(ta.wednesday,'W','')
                        || IFF(ta.thursday,'T','') || IFF(ta.friday,'F','') || IFF(ta.saturday,'S','')
                        || IFF(ta.sunday,'S','')
                      ELSE ta.schedule_type
                    END
                    || ' at ' || TO_CHAR(ta.task_window, 'HH12:MI AM'), ', ') AS schedules
           FROM ${CONFIGS_TABLE} c
           LEFT JOIN ${ASSIGNMENTS_TABLE} ta ON c.config_id = ta.config_id AND ta.is_active = TRUE
           WHERE c.is_active = TRUE
           GROUP BY c.config_name ORDER BY c.config_name`,
          SF_OPTS
        ),
        executeSnowflakeQuery<Record<string, unknown>>(
          `SELECT c.config_name, TO_VARCHAR(ta.task_window, 'HH24:MI') AS task_window,
                  ta.monday, ta.tuesday, ta.wednesday, ta.thursday, ta.friday, ta.saturday, ta.sunday
           FROM ${ASSIGNMENTS_TABLE} ta
           JOIN ${CONFIGS_TABLE} c ON c.config_id = ta.config_id
           WHERE c.is_active = TRUE AND ta.is_active = TRUE`,
          SF_OPTS
        ),
      ])
      return NextResponse.json({
        summary: summary.map((r) => ({
          configName: String(r.CONFIG_NAME ?? ""),
          schedules: r.SCHEDULES ? String(r.SCHEDULES) : "Not scheduled",
        })),
        grid: grid.map((r) => ({
          configName: String(r.CONFIG_NAME ?? ""),
          taskWindow: String(r.TASK_WINDOW ?? ""),
          monday: Boolean(r.MONDAY),
          tuesday: Boolean(r.TUESDAY),
          wednesday: Boolean(r.WEDNESDAY),
          thursday: Boolean(r.THURSDAY),
          friday: Boolean(r.FRIDAY),
          saturday: Boolean(r.SATURDAY),
          sunday: Boolean(r.SUNDAY),
        })),
      })
    }

    if (view === "errors") {
      const batchId = p.get("batchId") ?? ""
      if (!BATCH_RE.test(batchId)) {
        return NextResponse.json({ error: "Invalid batchId" }, { status: 400 })
      }
      const logs = await executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT log_id, TO_JSON(request_payload) AS request_payload_json,
                TO_JSON(response_payload) AS response_payload_json,
                status_code, error_message,
                TO_VARCHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
         FROM ${API_LOGS_TABLE}
         WHERE batch_id = ${sqlString(batchId)}
           AND (status_code >= 400 OR error_message IS NOT NULL)
         ORDER BY created_at DESC LIMIT 25`,
        SF_OPTS
      )
      return NextResponse.json({
        errors: logs.map((r) => ({
          logId: String(r.LOG_ID ?? ""),
          statusCode: r.STATUS_CODE == null ? null : Number(r.STATUS_CODE),
          errorMessage: r.ERROR_MESSAGE == null ? "" : String(r.ERROR_MESSAGE),
          createdAt: r.CREATED_AT == null ? null : String(r.CREATED_AT),
          request: safeJsonParse(r.REQUEST_PAYLOAD_JSON),
          response: safeJsonParse(r.RESPONSE_PAYLOAD_JSON),
        })),
      })
    }

    if (view === "config-names") {
      const rows = await executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT DISTINCT c.config_name
         FROM ${CONFIGS_TABLE} c
         JOIN ${HISTORY_TABLE} p ON p.config_id = c.config_id
         ORDER BY c.config_name`,
        SF_OPTS
      )
      return NextResponse.json({ configNames: rows.map((r) => String(r.CONFIG_NAME ?? "")) })
    }

    return NextResponse.json({ error: "Unknown view" }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/monitoring] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
