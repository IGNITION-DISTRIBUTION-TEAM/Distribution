import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  ASSIGNMENTS_TABLE,
  SCHEDULE_TYPES,
  DAY_KEYS,
  TIME_WINDOWS,
  type EngaigeAssignment,
} from "@/lib/engaige-shared"
import { SF_OPTS, sqlString, sqlBool } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/

// GET /api/engaige/assignments — all assignments (client groups by config).
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT assignment_id, config_id, TO_VARCHAR(task_window, 'HH24:MI:SS') AS task_window,
              schedule_type, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
              is_active
       FROM ${ASSIGNMENTS_TABLE} ORDER BY task_window`,
      SF_OPTS
    )
    const assignments: EngaigeAssignment[] = rows.map((r) => ({
      assignmentId: String(r.ASSIGNMENT_ID ?? ""),
      configId: String(r.CONFIG_ID ?? ""),
      taskWindow: String(r.TASK_WINDOW ?? ""),
      scheduleType: String(r.SCHEDULE_TYPE ?? ""),
      monday: Boolean(r.MONDAY),
      tuesday: Boolean(r.TUESDAY),
      wednesday: Boolean(r.WEDNESDAY),
      thursday: Boolean(r.THURSDAY),
      friday: Boolean(r.FRIDAY),
      saturday: Boolean(r.SATURDAY),
      sunday: Boolean(r.SUNDAY),
      isActive: Boolean(r.IS_ACTIVE),
    }))
    return NextResponse.json({ assignments })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/assignments] list error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/engaige/assignments — create one assignment.
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  let body: {
    configId?: unknown
    taskWindow?: unknown
    scheduleType?: unknown
    days?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const configId = String(body.configId ?? "")
  const taskWindow = String(body.taskWindow ?? "")
  const scheduleType = String(body.scheduleType ?? "")
  const days = (body.days ?? {}) as Record<string, unknown>

  if (!UUID_RE.test(configId)) {
    return NextResponse.json({ error: "Invalid configId" }, { status: 400 })
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
    await executeSnowflakeQueryWithMeta(
      `INSERT INTO ${ASSIGNMENTS_TABLE}
         (assignment_id, config_id, task_window, schedule_type,
          monday, tuesday, wednesday, thursday, friday, saturday, sunday, is_active, created_at)
       SELECT ${sqlString(randomUUID())}, ${sqlString(configId)}, TIME(${sqlString(taskWindow)}),
              ${sqlString(scheduleType.toUpperCase())},
              ${dayVals.map(sqlBool).join(", ")}, TRUE, CURRENT_TIMESTAMP()`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/assignments] create error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// PATCH /api/engaige/assignments — { assignmentId, action: "toggle" }.
export async function PATCH(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  let body: { assignmentId?: unknown; action?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const assignmentId = String(body.assignmentId ?? "")
  if (!UUID_RE.test(assignmentId)) {
    return NextResponse.json({ error: "Invalid assignmentId" }, { status: 400 })
  }
  if (body.action !== "toggle") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  }
  try {
    await executeSnowflakeQueryWithMeta(
      `UPDATE ${ASSIGNMENTS_TABLE} SET is_active = NOT is_active
       WHERE assignment_id = ${sqlString(assignmentId)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/assignments] toggle error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/engaige/assignments?assignmentId=...
export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard
  const assignmentId = request.nextUrl.searchParams.get("assignmentId") ?? ""
  if (!UUID_RE.test(assignmentId)) {
    return NextResponse.json({ error: "Invalid assignmentId" }, { status: 400 })
  }
  try {
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE assignment_id = ${sqlString(assignmentId)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/assignments] delete error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
