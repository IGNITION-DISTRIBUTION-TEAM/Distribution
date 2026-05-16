import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  TABLE,
  SF_OPTS,
  escapeSqlString,
  validateTaskIndex,
  validateTaskName,
} from "../route"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const currentIdx = validateTaskIndex(index)
  if (typeof currentIdx !== "number") return NextResponse.json(currentIdx, { status: 400 })

  let body: { taskIndex?: unknown; taskName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []

  if (body.taskIndex !== undefined) {
    const newIdx = validateTaskIndex(body.taskIndex)
    if (typeof newIdx !== "number") return NextResponse.json(newIdx, { status: 400 })
    sets.push(`TASK_INDEX = ${newIdx}`)
  }

  if (body.taskName !== undefined) {
    const name = validateTaskName(body.taskName)
    if (typeof name !== "string") return NextResponse.json(name, { status: 400 })
    sets.push(`TASK_NAME = '${escapeSqlString(name)}'`)
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    await executeSnowflakeQuery(
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE TASK_INDEX = ${currentIdx}`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const idx = validateTaskIndex(index)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  try {
    await executeSnowflakeQuery(
      `DELETE FROM ${TABLE} WHERE TASK_INDEX = ${idx}`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
