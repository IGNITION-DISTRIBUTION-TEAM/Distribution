import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta, SnowflakeColumn } from "@/lib/snowflake"
import {
  TABLE as DIALLER_TABLE,
  SF_OPTS as DIALLER_SF_OPTS,
} from "@/app/api/dialler-tables/route"

const SAFE_IDENT = /^[A-Z0-9_."]+$/i

export class DiallerCsvError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

/**
 * Format a Snowflake API value according to its declared column type.
 * Snowflake encodes DATE as days-since-epoch integers and TIMESTAMP_*
 * as "<seconds>.<nanos> [<tz_offset_minutes>]" — both look like raw
 * numbers without context, so we need the column type metadata.
 */
function formatByType(value: unknown, type: string): string {
  if (value === null || value === undefined) return ""
  const upper = (type || "").toUpperCase()

  if (upper === "DATE") {
    const days = typeof value === "number" ? value : parseInt(String(value), 10)
    if (Number.isFinite(days)) {
      const d = new Date(days * 86_400_000)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
    return String(value)
  }

  if (upper === "TIME") {
    // Snowflake TIME comes through as nanoseconds since midnight (string).
    const ns = typeof value === "number" ? value : parseInt(String(value), 10)
    if (Number.isFinite(ns)) {
      const totalSec = Math.floor(ns / 1_000_000_000)
      const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0")
      const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")
      const ss = String(totalSec % 60).padStart(2, "0")
      return `${hh}:${mm}:${ss}`
    }
    return String(value)
  }

  if (upper.startsWith("TIMESTAMP")) {
    // "<seconds>.<nanos>" optionally followed by " <tz_offset_minutes>"
    const parts = String(value).split(/\s+/)
    const seconds = parseFloat(parts[0])
    if (Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000)
      if (!Number.isNaN(d.getTime())) {
        // ISO with seconds precision, no timezone applied (LTZ/TZ offset ignored — keep UTC).
        return d.toISOString().replace(/\.\d{3}Z$/, "Z")
      }
    }
    return String(value)
  }

  return String(value)
}

function csvEscape(value: unknown, type: string): string {
  const s = formatByType(value, type)
  if (s === "") return ""
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function safeFilename(input: string): string {
  return (
    input
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "export"
  )
}

export type DiallerCsvResult = {
  index: number
  viewName: string
  filename: string
  csv: string
  rowCount: number
}

export async function buildDiallerCsv(index: number): Promise<DiallerCsvResult> {
  const rows = await executeSnowflakeQuery<{ TABLE_NAME: string }>(
    `SELECT TABLE_NAME FROM ${DIALLER_TABLE} WHERE TABLE_INDEX = ${index}`,
    DIALLER_SF_OPTS
  )
  if (rows.length === 0) {
    throw new DiallerCsvError(`No view found at index ${index}`, 404)
  }
  const viewName = rows[0].TABLE_NAME
  if (!SAFE_IDENT.test(viewName)) {
    throw new DiallerCsvError(`Stored view name contains unsafe characters: ${viewName}`, 400)
  }

  const { columns: colMeta, rows: rawRows } = await executeSnowflakeQueryWithMeta(
    `SELECT * FROM ${viewName}`
  )

  if (rawRows.length === 0) {
    throw new DiallerCsvError(`View ${viewName} returned no rows`, 404)
  }

  const headerLine = colMeta.map((c) => csvEscape(c.name, "TEXT")).join(",")
  const dataLines = rawRows.map((row) =>
    row.map((value, i) => csvEscape(value, colMeta[i]?.type ?? "TEXT")).join(",")
  )
  const csv = [headerLine, ...dataLines].join("\r\n") + "\r\n"

  // Filename: prefer the BATCHNAME column value, fall back to view name.
  const batchIdx = colMeta.findIndex((c) => c.name.toUpperCase() === "BATCHNAME")
  let filename = safeFilename(viewName.split(".").pop() ?? viewName)
  if (batchIdx >= 0) {
    const distinctBatches = Array.from(
      new Set(
        rawRows
          .map((r) => r[batchIdx])
          .filter((v) => v !== null && v !== undefined)
      )
    ).map(String)
    if (distinctBatches.length === 1) {
      filename = safeFilename(distinctBatches[0])
    } else if (distinctBatches.length > 1) {
      filename = safeFilename(distinctBatches[0]) + `_plus_${distinctBatches.length - 1}_more`
    }
  }
  filename = `${filename}.csv`

  return { index, viewName, filename, csv, rowCount: rawRows.length }
}

// Re-export to keep old import paths happy
export type { SnowflakeColumn }
