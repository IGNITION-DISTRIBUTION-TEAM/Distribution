import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import {
  TICKETS_DB,
  TICKETS_SCHEMA,
  TICKETS_TABLE,
  TICKETS_CONFIG_TABLE,
  DEFAULT_FORM_CONFIG,
  validateFormConfig,
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
}

// Latest saved form config, falling back to the built-in default when the
// table is empty. Rows are append-only (newest wins) so config history is kept.
export async function getFormConfig(): Promise<TicketFormConfig> {
  const { rows } = await executeSnowflakeQueryWithMeta(
    `SELECT CONFIG_JSON FROM ${TICKETS_CONFIG_TABLE} ORDER BY UPDATED_AT DESC LIMIT 1`,
    SF_OPTS
  )
  const raw = rows[0]?.[0]
  if (typeof raw !== "string" || !raw) return DEFAULT_FORM_CONFIG
  try {
    const parsed = JSON.parse(raw) as TicketFormConfig
    if (validateFormConfig(parsed) !== null) return DEFAULT_FORM_CONFIG
    if (!parsed.slaHoursByUrgency) parsed.slaHoursByUrgency = {}
    return parsed
  } catch {
    return DEFAULT_FORM_CONFIG
  }
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
