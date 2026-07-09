import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { ENGAIGE_DB, ENGAIGE_SCHEMA, SAFE_IDENT } from "@/lib/engaige-shared"

export const SF_OPTS = { database: ENGAIGE_DB, schema: ENGAIGE_SCHEMA }

// Escape a value for a single-quoted SQL string literal. The Streamlit original
// interpolated raw user input into SQL; every literal now goes through this.
export function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Validate an identifier (table/column) before interpolating into
// information_schema lookups, which can't use bind parameters.
export function assertIdent(name: string, label: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`)
  }
  return name
}

export function sqlBool(v: unknown): "TRUE" | "FALSE" {
  return v ? "TRUE" : "FALSE"
}

// Snowflake VARIANT (api_settings, payloads) arrive as JSON strings via
// TO_JSON(); parse defensively to a plain object.
export function safeJsonParse(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string") {
    const s = v.trim()
    if (!s) return {}
    try {
      const parsed = JSON.parse(s)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

// Column names of a source table (for mapping dropdowns).
export async function getSourceColumns(table: string): Promise<string[]> {
  assertIdent(table, "source table")
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT column_name FROM ${ENGAIGE_DB}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = ${sqlString(table.toUpperCase())}
     ORDER BY ordinal_position`,
    SF_OPTS
  )
  return rows.map((r) => String(r[0] ?? "")).filter(Boolean)
}
