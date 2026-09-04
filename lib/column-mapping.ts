/**
 * Column mapping helpers, shared by the Distribution file upload and the Task
 * Automation SFTP wizard.
 *
 * Lifted out of components/distribution-dashboard.tsx rather than copied: that
 * file is ~9,500 lines and a second copy of autoMatchColumn would drift from
 * the first the moment either changed.
 */

/** Sentinel for "do not map this source column". Not a column name. */
export const SKIP_VALUE = "__skip__"

/**
 * Types offered when creating a table from a file. Deliberately short — every
 * extra option is a decision the operator has to make per column, and CSV is
 * string-shaped anyway, so VARCHAR is usually right and the cast belongs
 * downstream.
 */
export const ALLOWED_SQL_TYPES = [
  "VARCHAR(500)",
  "VARCHAR(1000)",
  "VARCHAR(4000)",
  "NUMBER",
  "NUMBER(38,0)",
  "FLOAT",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP_NTZ",
] as const

export type SqlType = (typeof ALLOWED_SQL_TYPES)[number]

export type TargetColumn = {
  COLUMN_NAME: string
  DATA_TYPE: string
  IS_NULLABLE: "YES" | "NO"
  COLUMN_DEFAULT: string | null
}

/** A CSV header turned into a legal, unquoted Snowflake identifier. */
export function sanitizeColumnName(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
  if (!s) s = "COL"
  if (/^[0-9]/.test(s)) s = `C_${s}`
  return s
}

/**
 * Sanitize a whole header row, keeping names unique.
 *
 * Sanitising can collide — "Total (R)" and "Total %" both become TOTAL_R…
 * actually both become "TOTAL_R" and "TOTAL", but "Total (R)" and "Total-R"
 * both become "TOTAL_R". A silent collision would produce a CREATE TABLE with
 * two identical column names, which Snowflake rejects with a message that does
 * not mention the original headers. Suffixing is ugly and visible, which is
 * the right trade.
 */
export function sanitizeHeaderRow(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h) => {
    const base = sanitizeColumnName(h)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  })
}

/** Match a source header to a target column by name, ignoring case and punctuation. */
export function autoMatchColumn(sourceHeader: string, targets: TargetColumn[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const src = norm(sourceHeader)
  const exact = targets.find((t) => norm(t.COLUMN_NAME) === src)
  return exact ? exact.COLUMN_NAME : SKIP_VALUE
}

/* ---------------------------------------------------------------- delimiters */

export const DELIMITERS = [
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
] as const

export type Delimiter = (typeof DELIMITERS)[number]["value"]

/**
 * Guess the delimiter from the first few raw lines.
 *
 * Counts candidates OUTSIDE quotes — a comma inside "Smith, John" is not a
 * delimiter, and counting it is how a two-column file gets read as three. The
 * winner is the candidate whose per-line count is both non-zero and CONSISTENT
 * across lines, because a delimiter appears the same number of times on every
 * row of a well-formed file while stray punctuation does not.
 *
 * Returns a comma when nothing is convincing. The UI shows the guess and lets
 * it be overridden; a wrong guess the operator can see beats a right guess
 * they cannot.
 */
export function sniffDelimiter(lines: string[]): Delimiter {
  const sample = lines.filter((l) => l.trim() !== "").slice(0, 5)
  if (sample.length === 0) return ","

  let best: { d: Delimiter; count: number } | null = null
  for (const { value } of DELIMITERS) {
    const counts = sample.map((l) => countOutsideQuotes(l, value))
    if (counts.some((c) => c === 0)) continue          // absent from a line
    if (new Set(counts).size !== 1) continue           // inconsistent
    const count = counts[0]
    if (!best || count > best.count) best = { d: value, count }
  }
  return best ? best.d : ","
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      // "" inside a quoted field is an escaped quote, not a close.
      if (inQuotes && line[i + 1] === '"') { i++; continue }
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && c === ch) n++
  }
  return n
}

/**
 * Split one delimited line into fields, honouring quotes and "" escapes.
 *
 * Not a full CSV parser — it does not handle a field containing a newline,
 * because the caller only ever has the first N lines and a record split across
 * lines cannot be reassembled from them anyway. Good enough to show a header
 * and a couple of sample rows, which is all this is for.
 */
export function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && c === delimiter) { out.push(cur); cur = ""; continue }
    cur += c
  }
  out.push(cur)
  return out.map((f) => f.trim())
}
