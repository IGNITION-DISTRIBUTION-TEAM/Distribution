import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE as CONFIG_TABLE, SF_OPTS as CONFIG_SF_OPTS } from "@/app/api/campaign-config/route"
import { CONFIGS_TABLE } from "@/lib/distribution-steps"

/**
 * Read one setting for a campaign, from whichever config table holds it.
 *
 * THERE ARE TWO CONFIG TABLES.
 *   TSK_CAMPAIGN_AUTOMATION_CONFIGS   one row per named automation, per campaign
 *   TSK_CAMPAIGN_AUTOMATION_CONFIG    one row per campaign — the original
 *
 * Everything the app has grown since — the step plan, the run, the manual step
 * tabs, the Settings screen — reads the multi-config table. Several older
 * single-purpose endpoints still read only the legacy one, and a campaign
 * configured today has no row there at all. The result is an endpoint reporting
 * "nothing is configured for this campaign" about a setting the operator can see
 * on screen, set in the very screen the rest of the panel reads correctly. That
 * is a bad failure: it describes the app's own plumbing as the user's mistake.
 *
 * So: multi-config first — by CONFIG_ID when the caller knows which config is on
 * screen, otherwise the campaign's active one — then legacy.
 *
 * `columns` is tried in order and the first non-empty value wins, which is how a
 * field that was renamed across the two tables is handled (UPDATE_HLL_PROCEDURES
 * superseded UPDATE_HLL_PROCEDURE). Column names are interpolated, so they must
 * be literals from calling code, never from a request.
 */
export type ConfigLookup = {
  /** The value found, trimmed; null when every candidate column was empty. */
  value: string | null
  /** Which column it came from, for a diagnosable error message. */
  column: string | null
  /** Human-readable description of where it was read from. */
  source: string
}

const SAFE_COLUMN = /^[A-Za-z0-9_]+$/

export async function readCampaignSetting(
  campaignId: number,
  configId: number | null,
  columns: string[]
): Promise<ConfigLookup> {
  const cols = columns.filter((c) => SAFE_COLUMN.test(c))
  if (cols.length === 0) throw new Error("readCampaignSetting: no valid column names")

  const first = (row: Record<string, unknown> | undefined): { value: string; column: string } | null => {
    if (!row) return null
    for (const c of cols) {
      const v = row[c]
      const s = v == null ? "" : String(v).trim()
      if (s) return { value: s, column: c }
    }
    return null
  }

  // 1. The multi-config table.
  try {
    const select = `${cols.join(", ")}, CONFIG_NAME`
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      configId != null
        ? `SELECT ${select} FROM ${CONFIGS_TABLE} WHERE CONFIG_ID = ${configId}`
        : `SELECT ${select} FROM ${CONFIGS_TABLE}
            WHERE CAMPAIGNID = ${campaignId}
            ORDER BY IFF(IS_ACTIVE = TRUE, 0, 1), CONFIG_ID
            LIMIT 1`,
      CONFIG_SF_OPTS
    )
    const hit = first(rows[0])
    if (hit) {
      const name = rows[0]?.CONFIG_NAME
      return {
        ...hit,
        source: name ? `config "${String(name)}"` : "the campaign automation config",
      }
    }
  } catch {
    // The multi-config table may not exist on an older deployment; fall through
    // rather than reporting a plumbing error as a missing setting.
  }

  // 2. The legacy single-campaign table.
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT ${cols.join(", ")} FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
    const hit = first(rows[0])
    if (hit) return { ...hit, source: "the legacy single-campaign config" }
  } catch {
    // Same: an unreadable legacy table is not evidence of a missing setting.
  }

  return {
    value: null,
    column: null,
    source:
      configId != null
        ? `config ${configId} and the legacy single-campaign config`
        : "the campaign's active config and the legacy single-campaign config",
  }
}

/**
 * A JSON array column (the multi-config UPDATE_HLL_PROCEDURES) or its single
 * predecessor, as a list. Mirrors getUpdateHllProcs, which does the same for a
 * config row already in hand.
 */
export function asList(value: string | null): string[] {
  if (!value) return []
  try {
    const arr = JSON.parse(value)
    if (Array.isArray(arr)) {
      return arr.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    }
  } catch {
    // Not JSON — the legacy column holds one bare reference.
  }
  return [value]
}
