import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const SAFE_IDENT = /^[A-Za-z0-9_]+$/
const QUALIFIED_TABLE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
const MAX_ROWS_PER_BATCH = 5000

type Body = {
  table?: unknown
  columns?: unknown
  rows?: unknown
  campaignId?: unknown
  injectCampaignId?: unknown
  truncate?: unknown
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''")
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // --- table ---
  const table = typeof body.table === "string" ? body.table.trim() : ""
  if (!QUALIFIED_TABLE.test(table)) {
    return NextResponse.json(
      { error: 'table must be "DATABASE.SCHEMA.NAME" (A-Z, 0-9, _ only)' },
      { status: 400 }
    )
  }
  const [database, schema] = table.split(".")

  // --- columns ---
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return NextResponse.json({ error: "columns must be a non-empty array" }, { status: 400 })
  }
  const columns = (body.columns as unknown[]).map((c) => String(c).trim().toUpperCase())
  const badCol = columns.find((c) => !SAFE_IDENT.test(c))
  if (badCol !== undefined) {
    return NextResponse.json({ error: `Invalid column name: ${badCol}` }, { status: 400 })
  }

  // --- rows ---
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows must be a non-empty array" }, { status: 400 })
  }
  if (body.rows.length > MAX_ROWS_PER_BATCH) {
    return NextResponse.json(
      { error: `Max ${MAX_ROWS_PER_BATCH} rows per batch` },
      { status: 400 }
    )
  }
  const rows = body.rows as unknown[]
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== columns.length) {
      return NextResponse.json(
        { error: "each row must be an array matching the columns length" },
        { status: 400 }
      )
    }
  }

  // --- optional CAMPAIGNID injection ---
  const injectCampaignId = !!body.injectCampaignId
  let campaignIdNum = 0
  if (injectCampaignId) {
    if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
      return NextResponse.json(
        { error: "campaignId must be a positive integer when injectCampaignId is set" },
        { status: 400 }
      )
    }
    campaignIdNum = Number(body.campaignId)
  }

  const finalCols = injectCampaignId ? [...columns, "CAMPAIGNID"] : columns

  const valuesSql = (rows as (string | null)[][])
    .map((row) => {
      const vals = row.map((v) =>
        v === null || v === undefined || v === "" ? "NULL" : `'${escapeSqlString(String(v))}'`
      )
      if (injectCampaignId) vals.push(String(campaignIdNum))
      return `(${vals.join(",")})`
    })
    .join(",\n")

  const insertSql = `INSERT INTO ${table} (${finalCols.join(", ")}) VALUES\n${valuesSql}`
  const sfOpts = { database, schema }

  // --- truncate (first batch only) ---
  if (body.truncate === true) {
    try {
      await executeSnowflakeQuery(`TRUNCATE TABLE ${table}`, sfOpts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[/api/upload/load] truncate error:", message)
      return NextResponse.json({ error: `Truncate failed: ${message}` }, { status: 500 })
    }
  }

  // --- insert ---
  try {
    await executeSnowflakeQuery(insertSql, sfOpts)
    return NextResponse.json({ ok: true, inserted: rows.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/upload/load] insert error:", message)
    return NextResponse.json({ error: `Insert failed: ${message}` }, { status: 500 })
  }
}
