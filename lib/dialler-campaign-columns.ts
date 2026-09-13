import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  buildColumnProbe,
  resolveColumns,
  type CampaignSource,
  type ResolvedColumns,
} from "@/lib/dialler-campaign-map"

/**
 * Work out which columns to read on a campaign source, once per process.
 *
 * Kept out of lib/dialler-campaign-map.ts so that module stays pure and its SQL
 * stays testable without a warehouse. This is the half that talks to Snowflake.
 *
 * WHY PROBE AT ALL. Neither source is one this app has read before —
 * SILVERSURFER.CAMP_CAMPAIGN is a different table from the one the Distribution
 * picker uses, and nothing here has ever touched YAXXA_DW_REPLICATION. A
 * hard-coded guess at their id and name columns fails as "invalid identifier",
 * which says nothing about which of the two is wrong or what the right answer
 * would be. Probing turns that into a specific message naming the candidates
 * tried.
 *
 * CACHED FOR THE LIFE OF THE PROCESS, like `cachedNameCols` in
 * app/api/admin/employees/route.ts. A source table's shape does not change
 * between requests, and on a serverless deploy the process is short-lived
 * anyway — so a rename is picked up by the next cold start rather than needing
 * an invalidation path nobody would remember to call.
 *
 * A FAILED PROBE IS NOT CACHED. A missing grant is temporary and gets fixed by
 * running the grants script; caching the empty result would mean the screen
 * stayed broken until redeploy, which is a maddening thing to debug.
 */
const cache = new Map<string, ResolvedColumns>()

export async function resolveSourceColumns(source: CampaignSource): Promise<ResolvedColumns> {
  const hit = cache.get(source.table)
  if (hit) return hit

  let present: string[] = []
  try {
    const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(buildColumnProbe(source), {
      database: source.database,
      schema: source.schema,
    })
    present = rows.map((r) => String(r.COLUMN_NAME))
  } catch (error) {
    // Almost always a missing grant. The caller turns an unresolved source into
    // a message naming the grants script, which is more use than this stack.
    console.error(`[dialler-campaign-columns] probe failed for ${source.table}:`, error)
    return { id: null, label: null }
  }

  const resolved = resolveColumns(source, present)
  if (resolved.id && resolved.label) cache.set(source.table, resolved)
  return resolved
}
