import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const SAFE_IDENT = /^[A-Z0-9_]+$/i

type Body = { table?: unknown }

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const tableRaw = typeof body.table === "string" ? body.table.trim() : ""
  if (!tableRaw) {
    return NextResponse.json({ error: "table required (DATABASE.SCHEMA.NAME)" }, { status: 400 })
  }

  const parts = tableRaw.split(".")
  if (parts.length !== 3 || parts.some((p) => !SAFE_IDENT.test(p))) {
    return NextResponse.json(
      { error: 'table must be "DATABASE.SCHEMA.NAME" using A-Z, 0-9, _ only' },
      { status: 400 }
    )
  }
  const [database, schema, name] = parts.map((p) => p.toUpperCase())

  try {
    const columns = await executeSnowflakeQuery<{
      COLUMN_NAME: string
      DATA_TYPE: string
      IS_NULLABLE: "YES" | "NO"
      COLUMN_DEFAULT: string | null
    }>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM ${database}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${name}'
       ORDER BY ORDINAL_POSITION`,
      { database, schema }
    )
    if (columns.length > 0) {
      return NextResponse.json({ table: `${database}.${schema}.${name}`, columns })
    }

    // INFORMATION_SCHEMA lists only what the role has privileges on, so an empty
    // result means "absent OR invisible" — and the caller uses this to decide
    // whether to offer creating the table. Getting that wrong sends someone into
    // a create flow for a table that already exists. SHOW COLUMNS separates the
    // two: it returns the columns when the role can reach the object, and errors
    // explicitly when it cannot.
    try {
      const shown = await executeSnowflakeQuery<Record<string, unknown>>(
        `SHOW COLUMNS IN ${database}.${schema}.${name}`,
        { database, schema }
      )
      const pick = (row: Record<string, unknown>, key: string): string => {
        const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase())
        const v = hit ? row[hit] : undefined
        return v == null ? "" : String(v)
      }
      const mapped = shown
        .map((r) => {
          let type = pick(r, "data_type")
          try {
            const parsed = JSON.parse(type)
            if (parsed && typeof parsed.type === "string") type = parsed.type
          } catch { /* data_type wasn't JSON — keep the raw string */ }
          return {
            COLUMN_NAME: pick(r, "column_name"),
            DATA_TYPE: type,
            IS_NULLABLE: (pick(r, "null?") === "true" ? "YES" : "NO") as "YES" | "NO",
            COLUMN_DEFAULT: null,
          }
        })
        .filter((c) => c.COLUMN_NAME)
      if (mapped.length > 0) {
        return NextResponse.json({ table: `${database}.${schema}.${name}`, columns: mapped })
      }
    } catch (showError) {
      const m = showError instanceof Error ? showError.message : String(showError)
      // Snowflake reports absent and unauthorised identically here, so say both
      // rather than asserting the table does not exist.
      return NextResponse.json(
        {
          error:
            `${database}.${schema}.${name} could not be read. Snowflake reports a missing object ` +
            `and a missing privilege the same way, so it either does not exist or this app's role ` +
            `has no access to it. Detail: ${m}`,
          reason: "unreadable",
        },
        { status: 404 }
      )
    }

    return NextResponse.json(
      {
        error: `Table ${database}.${schema}.${name} not found or not visible to the role`,
        reason: "unreadable",
      },
      { status: 404 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
