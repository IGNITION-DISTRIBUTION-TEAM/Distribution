import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TABLE, SF_OPTS, sqlStr, sqlNullable, validateName, normType, normStatus, normProcKind, normSourceKind, validateMapping, validateStandaloneProc } from "../route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// PATCH — edit a task (any subset of fields).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []
  if (body.name !== undefined) {
    const name = validateName(body.name)
    if (typeof name !== "string") return NextResponse.json(name, { status: 400 })
    sets.push(`NAME = ${sqlStr(name)}`)
  }
  if (body.description !== undefined) sets.push(`DESCRIPTION = ${sqlNullable(body.description)}`)
  if (body.type !== undefined) sets.push(`TASK_TYPE = ${sqlStr(normType(body.type))}`)
  if (body.target !== undefined) sets.push(`TARGET = ${sqlNullable(body.target)}`)
  if (body.status !== undefined) sets.push(`STATUS = ${sqlStr(normStatus(body.status))}`)
  if (body.schedule !== undefined) sets.push(`SCHEDULE = ${sqlNullable(body.schedule)}`)
  if (body.campaignId !== undefined) sets.push(`CAMPAIGN_ID = ${sqlNullable(body.campaignId)}`)
  if (body.campaignTitle !== undefined) sets.push(`CAMPAIGN_TITLE = ${sqlNullable(body.campaignTitle)}`)
  if (body.procKind !== undefined) sets.push(`PROC_KIND = ${sqlStr(normProcKind(body.procKind))}`)
  if (body.sourceKind !== undefined) sets.push(`SOURCE_KIND = ${sqlStr(normSourceKind(body.sourceKind))}`)
  if (body.sourceObject !== undefined) sets.push(`SOURCE_OBJECT = ${sqlNullable(body.sourceObject)}`)
  if (body.sourceTable !== undefined) sets.push(`SOURCE_TABLE = ${sqlNullable(body.sourceTable)}`)
  if (body.mapping !== undefined) { const m = validateMapping(body.mapping); sets.push(`MAPPING_JSON = ${m ? sqlStr(m) : "NULL"}`) }
  if (body.standaloneProc !== undefined) {
    const sp = validateStandaloneProc(body.standaloneProc)
    if (body.standaloneProc && !sp) return NextResponse.json({ error: 'Standalone procedure must be "DATABASE.SCHEMA.PROC" with optional (args)' }, { status: 400 })
    sets.push(`STANDALONE_PROC = ${sp ? sqlStr(sp) : "NULL"}`)
  }
  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  sets.push("UPDATED_AT = CURRENT_TIMESTAMP()")

  try {
    await executeSnowflakeQuery(`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE ID = ${taskId}`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/tasks PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE — remove a task.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })
  try {
    await executeSnowflakeQuery(`DELETE FROM ${TABLE} WHERE ID = ${taskId}`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/tasks DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
