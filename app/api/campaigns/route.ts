import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { MAP_TABLE } from "@/lib/dialler-campaign-map"

export const dynamic = "force-dynamic"

const SOURCE = "DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "SILVERSURFER_CAMP_HEVO" } as const

type CampaignRow = {
  CAMPAIGNID: string | number
  TITLE: string | null
  IS_MAPPED?: boolean | string | null
}

/**
 * Active SilverSurfer campaigns, for every campaign picker in the portal.
 *
 * `?mappedToDialler=1` narrows the list to campaigns that have a Yaxxa dialler
 * campaign attached in TSK_CAMPAIGN_DIALLER_MAP. OPT-IN, because SEVEN screens
 * read this route and only the Dialler report wants it — the default query is
 * what it always was, so the other six take no dependency on a table in another
 * schema that could fail on a missing grant.
 *
 * The Dialler report filters VW_DIALLER_STATS through that mapping, so an
 * unmapped campaign has no answer to give there: picking one produced a report
 * of zeroes. Not offering it is the better half of that fix.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const mappedOnly = request.nextUrl.searchParams.get("mappedToDialler") === "1"

  // DISTINCT IS NOT TIDYING. The map is one row per PAIR and one SilverSurfer
  // campaign can feed several Yaxxa campaigns, so a plain join would list that
  // campaign three times in the picker. Same trap buildTabCounts documents.
  //
  // Flagged and filtered in ONE query rather than counted in a second, so the
  // "n of m are mapped" caption cannot drift from the list it describes.
  const sql = mappedOnly
    ? `WITH MAPPED AS (SELECT DISTINCT SS_CAMPAIGNID FROM ${MAP_TABLE})
       SELECT c.CAMPAIGNID, c.TITLE, (m.SS_CAMPAIGNID IS NOT NULL) AS IS_MAPPED
         FROM ${SOURCE} c
         LEFT JOIN MAPPED m ON m.SS_CAMPAIGNID = CAST(c.CAMPAIGNID AS VARCHAR)
        WHERE c.ACTIVE = 1
          AND c.TITLE IS NOT NULL
          AND c.TITLE <> ''
        ORDER BY c.TITLE`
    : `SELECT CAMPAIGNID, TITLE
       FROM ${SOURCE}
       WHERE ACTIVE = 1
         AND TITLE IS NOT NULL
         AND TITLE <> ''
       ORDER BY TITLE`

  try {
    const rows = await executeSnowflakeQuery<CampaignRow>(sql, SF_OPTS)

    // Snowflake's REST results are strings; "false" is truthy in JS, which is
    // exactly the sort of thing that silently shows every campaign as mapped.
    const isMapped = (v: CampaignRow["IS_MAPPED"]) =>
      v === true || String(v).toUpperCase() === "TRUE"

    const all = rows.map((r) => ({
      id: String(r.CAMPAIGNID),
      title: r.TITLE ?? "",
      mapped: isMapped(r.IS_MAPPED),
    }))
    const campaigns = mappedOnly ? all.filter((c) => c.mapped) : all

    return NextResponse.json({
      campaigns: campaigns.map(({ id, title }) => ({ id, title })),
      // How many were filtered out, so the shorter list can explain itself.
      // Only meaningful for the filtered call; null keeps the other six
      // callers' payload the shape it was.
      activeTotal: mappedOnly ? all.length : null,
    })
  } catch (error) {
    // NOT swallowed into an unfiltered list. A silent fallback would restore
    // the exact behaviour the filter exists to remove, and would do it by
    // appearing to work.
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaigns] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
