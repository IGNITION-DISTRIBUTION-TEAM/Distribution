import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE, SF_OPTS, escapeSqlString, validateProcIndex, validateProcName } from "../route"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const currentIdx = validateProcIndex(index)
  if (typeof currentIdx !== "number") return NextResponse.json(currentIdx, { status: 400 })

  let body: { procIndex?: unknown; procName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []

  if (body.procIndex !== undefined) {
    const newIdx = validateProcIndex(body.procIndex)
    if (typeof newIdx !== "number") return NextResponse.json(newIdx, { status: 400 })
    sets.push(`PROC_INDEX = ${newIdx}`)
  }

  if (body.procName !== undefined) {
    const name = validateProcName(body.procName)
    if (typeof name !== "string") return NextResponse.json(name, { status: 400 })
    sets.push(`PROC_NAME = '${escapeSqlString(name)}'`)
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    await executeSnowflakeQuery(
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE PROC_INDEX = ${currentIdx}`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/hll-procedures PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const idx = validateProcIndex(index)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  try {
    await executeSnowflakeQuery(`DELETE FROM ${TABLE} WHERE PROC_INDEX = ${idx}`, SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/hll-procedures DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
