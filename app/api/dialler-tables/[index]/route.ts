import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  TABLE,
  SF_OPTS,
  escapeSqlString,
  validateTableIndex,
  validateTableName,
} from "../route"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const currentIdx = validateTableIndex(index)
  if (typeof currentIdx !== "number") return NextResponse.json(currentIdx, { status: 400 })

  let body: { tableIndex?: unknown; tableName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const sets: string[] = []

  if (body.tableIndex !== undefined) {
    const newIdx = validateTableIndex(body.tableIndex)
    if (typeof newIdx !== "number") return NextResponse.json(newIdx, { status: 400 })
    sets.push(`TABLE_INDEX = ${newIdx}`)
  }

  if (body.tableName !== undefined) {
    const name = validateTableName(body.tableName)
    if (typeof name !== "string") return NextResponse.json(name, { status: 400 })
    sets.push(`TABLE_NAME = '${escapeSqlString(name)}'`)
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  try {
    await executeSnowflakeQuery(
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE TABLE_INDEX = ${currentIdx}`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler-tables PATCH] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ index: string }> }) {
  const { index } = await params
  const idx = validateTableIndex(index)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  try {
    await executeSnowflakeQuery(
      `DELETE FROM ${TABLE} WHERE TABLE_INDEX = ${idx}`,
      SF_OPTS
    )
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler-tables DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
