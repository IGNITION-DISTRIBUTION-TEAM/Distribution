import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  ASSIGNMENTS_TABLE,
  SCHEDULE_TYPES,
  DAY_KEYS,
  TIME_WINDOWS,
} from "@/lib/engaige-shared"
import { SF_OPTS, sqlString, sqlBool } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// POST /api/engaige/schedule — apply one time-window schedule to many configs at
// once. When replaceExisting, existing assignments at that window are cleared
// first (per config).
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  let body: {
    configIds?: unknown
    taskWindow?: unknown
    scheduleType?: unknown
    days?: unknown
    replaceExisting?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const configIds = Array.isArray(body.configIds) ? body.configIds.map(String) : []
  const taskWindow = String(body.taskWindow ?? "")
  const scheduleType = String(body.scheduleType ?? "")
  const days = (body.days ?? {}) as Record<string, unknown>
  const replaceExisting = body.replaceExisting !== false

  if (configIds.length === 0 || !configIds.every((c) => UUID_RE.test(c))) {
    return NextResponse.json({ error: "Select at least one valid configuration" }, { status: 400 })
  }
  if (!TIME_WINDOWS.includes(taskWindow)) {
    return NextResponse.json({ error: "Invalid time window" }, { status: 400 })
  }
  if (!(SCHEDULE_TYPES as readonly string[]).includes(scheduleType)) {
    return NextResponse.json({ error: "Invalid schedule type" }, { status: 400 })
  }
  const dayVals = DAY_KEYS.map((d) => Boolean(days[d]))
  if (scheduleType === "Specific Days" && !dayVals.some(Boolean)) {
    return NextResponse.json({ error: "Select at least one day" }, { status: 400 })
  }

  try {
    const windowLit = `TIME(${sqlString(taskWindow)})`
    for (const configId of configIds) {
      const idLit = sqlString(configId)
      if (replaceExisting) {
        await executeSnowflakeQueryWithMeta(
          `DELETE FROM ${ASSIGNMENTS_TABLE}
           WHERE config_id = ${idLit} AND task_window = ${windowLit}`,
          SF_OPTS
        )
      }
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${ASSIGNMENTS_TABLE}
           (assignment_id, config_id, task_window, schedule_type,
            monday, tuesday, wednesday, thursday, friday, saturday, sunday, is_active, created_at)
         SELECT ${sqlString(randomUUID())}, ${idLit}, ${windowLit},
                ${sqlString(scheduleType.toUpperCase())},
                ${dayVals.map(sqlBool).join(", ")}, TRUE, CURRENT_TIMESTAMP()`,
        SF_OPTS
      )
    }
    return NextResponse.json({ success: true, scheduled: configIds.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/schedule] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
