import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import {
  TICKETS_DB,
  TICKETS_SCHEMA,
  TICKETS_TABLE,
  TICKETS_CONFIG_TABLE,
  TICKETS_DEPARTMENTS_TABLE,
  DEFAULT_FORM_CONFIG,
  validateFormConfig,
  type TicketDepartment,
  type TicketFormConfig,
} from "@/lib/tickets-shared"

export const SF_OPTS = { database: TICKETS_DB, schema: TICKETS_SCHEMA }

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function ensureTicketTables(): Promise<void> {
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${TICKETS_TABLE} (` +
      `TICKET_ID VARCHAR, TICKET_REF VARCHAR, STATUS VARCHAR, ` +
      `REQUEST_TYPE VARCHAR, URGENCY VARCHAR, SLA_DUE_AT TIMESTAMP_NTZ, ` +
      `ASSIGNED_TO VARCHAR, FIELDS VARCHAR, ` +
      `CREATED_BY_NAME VARCHAR, CREATED_BY_EMAIL VARCHAR, ` +
      `CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(), ` +
      `UPDATED_BY VARCHAR, UPDATED_AT TIMESTAMP_NTZ)`,
    SF_OPTS
  )
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${TICKETS_CONFIG_TABLE} (` +
      `CONFIG_JSON VARCHAR, UPDATED_BY VARCHAR, ` +
      `UPDATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
    SF_OPTS
  )
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${TICKETS_DEPARTMENTS_TABLE} (` +
      `NAME VARCHAR, SLUG VARCHAR, ACTIVE BOOLEAN, ` +
      `CREATED_BY VARCHAR, CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
    SF_OPTS
  )

  // DEPT_SLUG arrived after the config table did, so CREATE TABLE IF NOT EXISTS
  // above will not add it to an existing install — that statement is a no-op
  // once the table is there, whatever its shape. Checked against
  // INFORMATION_SCHEMA rather than relying on ADD COLUMN IF NOT EXISTS, which
  // is not available on every Snowflake edition and would fail the whole call.
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT COUNT(*) FROM ${TICKETS_DB}.INFORMATION_SCHEMA.COLUMNS` +
      ` WHERE TABLE_SCHEMA = ${sqlString(TICKETS_SCHEMA)}` +
      `   AND TABLE_NAME = 'TICKETS_FORM_CONFIG'` +
      `   AND COLUMN_NAME = 'DEPT_SLUG'`,
    SF_OPTS
  )
  if (Number(rows[0]?.[0] ?? 0) === 0) {
    await executeSnowflakeQueryWithMeta(
      `ALTER TABLE ${TICKETS_CONFIG_TABLE} ADD COLUMN DEPT_SLUG VARCHAR`,
      SF_OPTS
    )
  }
}

// Active requesting departments, alphabetically.
export async function getActiveDepartments(): Promise<TicketDepartment[]> {
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT NAME, SLUG FROM ${TICKETS_DEPARTMENTS_TABLE} WHERE ACTIVE = TRUE ORDER BY NAME`,
    SF_OPTS
  )
  return rows
    .map((r) => ({ name: String(r[0] ?? ""), slug: String(r[1] ?? "") }))
    .filter((d) => d.name && d.slug)
}

/** Where a resolved form config came from. Shown in the admin UI. */
export type FormConfigSource = "department" | "global" | "default"

function parseConfig(raw: unknown): TicketFormConfig | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const parsed = JSON.parse(raw) as TicketFormConfig
    if (validateFormConfig(parsed) !== null) return null
    if (!parsed.slaHoursByUrgency) parsed.slaHoursByUrgency = {}
    return parsed
  } catch {
    return null
  }
}

/**
 * The form config for a department, falling back to the global one.
 *
 * Rows stay APPEND-ONLY — newest wins per department — so every edit keeps its
 * history and nothing is ever overwritten. DEPT_SLUG null or '' is the global
 * form; any other value is that department's own.
 *
 * A row whose CONFIG_JSON IS NULL is a TOMBSTONE meaning "inherit the global
 * form again". Without it, append-only storage would make customising a
 * department a one-way door: there would be no way to express "no longer has
 * its own form" other than deleting history.
 *
 * Both candidates come back in ONE query. Two round trips to answer one
 * question would also let the global config change between them, and the
 * public capture page pays that cost on every load.
 */
export async function getFormConfig(
  deptSlug?: string | null
): Promise<{ config: TicketFormConfig; source: FormConfigSource }> {
  const slug = (deptSlug ?? "").trim()
  const wanted = slug ? `('', ${sqlString(slug)})` : `('')`
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT COALESCE(DEPT_SLUG, '') AS SLUG, CONFIG_JSON FROM (` +
      `  SELECT DEPT_SLUG, CONFIG_JSON, UPDATED_AT FROM ${TICKETS_CONFIG_TABLE}` +
      `   WHERE COALESCE(DEPT_SLUG, '') IN ${wanted}` +
      `  QUALIFY ROW_NUMBER() OVER (` +
      `    PARTITION BY COALESCE(DEPT_SLUG, '') ORDER BY UPDATED_AT DESC) = 1)`,
    SF_OPTS
  )

  let deptRaw: unknown = null
  let globalRaw: unknown = null
  let deptRowExists = false
  for (const r of rows) {
    if (String(r[0] ?? "") === "") globalRaw = r[1]
    else {
      deptRowExists = true
      deptRaw = r[1]
    }
  }

  // A tombstone row exists but carries no JSON — deliberately falls through.
  if (deptRowExists) {
    const dept = parseConfig(deptRaw)
    if (dept) return { config: dept, source: "department" }
  }
  const global = parseConfig(globalRaw)
  if (global) return { config: global, source: "global" }
  return { config: DEFAULT_FORM_CONFIG, source: "default" }
}

/** Which departments have a form of their own right now (tombstones excluded). */
export async function getCustomisedDeptSlugs(): Promise<string[]> {
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT SLUG FROM (` +
      `  SELECT COALESCE(DEPT_SLUG, '') AS SLUG, CONFIG_JSON, UPDATED_AT` +
      `    FROM ${TICKETS_CONFIG_TABLE} WHERE COALESCE(DEPT_SLUG, '') <> ''` +
      `  QUALIFY ROW_NUMBER() OVER (PARTITION BY SLUG ORDER BY UPDATED_AT DESC) = 1)` +
      ` WHERE CONFIG_JSON IS NOT NULL`,
    SF_OPTS
  )
  return rows.map((r) => String(r[0] ?? "")).filter(Boolean)
}

/**
 * Every field label ever saved, keyed by field key, newest definition winning.
 *
 * The All tickets view labels a ticket's answers from ONE config. Once forms
 * differ per department, a ticket logged against a department's own field would
 * show its raw key there instead of its label — the answer is right and the
 * heading is gibberish. This merges the labels so the reading stays correct
 * whichever form the ticket came from.
 */
export async function getFieldLabels(): Promise<Record<string, string>> {
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT CONFIG_JSON FROM ${TICKETS_CONFIG_TABLE}` +
      ` WHERE CONFIG_JSON IS NOT NULL ORDER BY UPDATED_AT ASC`,
    SF_OPTS
  )
  const labels: Record<string, string> = {}
  for (const f of DEFAULT_FORM_CONFIG.fields) labels[f.key] = f.label
  // Ascending, so a newer definition of the same key overwrites an older one.
  for (const r of rows) {
    const cfg = parseConfig(r[0])
    if (!cfg) continue
    for (const f of cfg.fields) labels[f.key] = f.label
  }
  return labels
}

// Read the display name from the session cookie (best-effort; guards already
// verified the session before this is called).
export function sessionName(cookieValue: string | undefined): string {
  if (!cookieValue) return ""
  try {
    const session = JSON.parse(cookieValue) as { name?: string }
    return typeof session.name === "string" ? session.name : ""
  } catch {
    return ""
  }
}

// Best-effort per-key rate limiter for the public capture endpoint. In-memory,
// so on serverless it only bounds bursts within a warm instance — it is a
// speed bump, not real abuse protection.
const rateBuckets = new Map<string, number[]>()

export function rateLimitOk(key: string, limit = 5, windowMs = 60_000): boolean {
  const now = Date.now()
  const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) {
    rateBuckets.set(key, recent)
    return false
  }
  recent.push(now)
  rateBuckets.set(key, recent)
  return true
}
