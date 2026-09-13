import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  MAP_SF_OPTS,
  MAP_TABLE,
  YAXXA_SOURCE,
  buildCampaignCount,
  buildCampaigns,
  isResolved,
} from "@/lib/dialler-campaign-map"
import { resolveSourceColumns } from "@/lib/dialler-campaign-columns"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The Yaxxa campaign picker.
 *
 * Its own endpoint rather than part of the main payload, because the dialler
 * has its own campaign list and shipping all of it alongside every page of
 * SilverSurfer campaigns would make the screen slow for a dropdown most people
 * open once.
 *
 * Each row carries who currently owns it, so the picker can separate the
 * unattached from the ones already spoken for — attaching one of the latter
 * MOVES it, and that has to be a visible choice rather than a surprise.
 */

type Row = { CAMPAIGN_ID: string; LABEL: string | null }
type Owned = { YAXXA_CAMPAIGNID: string; SS_CAMPAIGNID: string; SS_TITLE: string | null }

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "dialler")
  if (guard instanceof NextResponse) return guard

  const url = request.nextUrl
  const search = url.searchParams.get("search") ?? ""
  const limitRaw = Number(url.searchParams.get("limit") ?? 50)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50

  try {
    const cols = await resolveSourceColumns(YAXXA_SOURCE)
    if (!isResolved(cols)) {
      return NextResponse.json(
        {
          error:
            `Could not work out which columns to read on ${YAXXA_SOURCE.table}. ` +
            `Run scripts/dialler/00-discover-columns.sql, then correct the candidates in ` +
            `lib/dialler-campaign-map.ts.`,
        },
        { status: 500 }
      )
    }

    const [rows, counts] = await Promise.all([
      executeSnowflakeQuery<Row>(buildCampaigns(YAXXA_SOURCE, cols, search, limit, 0), {
        database: YAXXA_SOURCE.database,
        schema: YAXXA_SOURCE.schema,
      }),
      executeSnowflakeQuery<{ CNT: number | string }>(
        buildCampaignCount(YAXXA_SOURCE, cols, search),
        { database: YAXXA_SOURCE.database, schema: YAXXA_SOURCE.schema }
      ),
    ])

    // Ownership for the rows on show, not the whole map.
    let owners: Owned[] = []
    try {
      owners = await executeSnowflakeQuery<Owned>(
        `SELECT YAXXA_CAMPAIGNID, SS_CAMPAIGNID, SS_TITLE FROM ${MAP_TABLE}`,
        MAP_SF_OPTS
      )
    } catch {
      // The map table may not exist yet on a first visit. Not an error.
    }
    const ownerOf = new Map(owners.map((o) => [String(o.YAXXA_CAMPAIGNID), o]))

    return NextResponse.json({
      total: Number(counts[0]?.CNT ?? 0),
      limit,
      campaigns: rows.map((r) => {
        const owner = ownerOf.get(String(r.CAMPAIGN_ID))
        return {
          id: String(r.CAMPAIGN_ID),
          name: r.LABEL ?? "",
          ownedBy: owner
            ? { ssId: String(owner.SS_CAMPAIGNID), ssTitle: owner.SS_TITLE ?? null }
            : null,
        }
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler/campaign-map/yaxxa] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
