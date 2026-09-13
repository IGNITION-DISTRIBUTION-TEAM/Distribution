import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  MAP_SF_OPTS,
  SS_SOURCE,
  YAXXA_SOURCE,
  buildAttach,
  buildCampaignCount,
  buildCampaigns,
  buildDetach,
  buildDoubleBookedCheck,
  buildEnsureMapTable,
  buildMappingsFor,
  buildOwnerOf,
  buildStaleMappings,
  buildTabCounts,
  isResolved,
  type MapFilter,
  type ResolvedColumns,
} from "@/lib/dialler-campaign-map"
import { resolveSourceColumns } from "@/lib/dialler-campaign-columns"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Mapping active SilverSurfer campaigns to Yaxxa dialler campaigns.
 *
 * One SilverSurfer campaign to many Yaxxa ones, so attaching a Yaxxa campaign
 * that already belongs somewhere else MOVES it. The response says where it
 * moved from; the screen is expected to repeat that to the person who did it,
 * because re-parenting a live dialler campaign should never be silent.
 */

type CampaignRow = { CAMPAIGN_ID: string; LABEL: string | null }
type MapRow = {
  SS_CAMPAIGNID: string
  YAXXA_CAMPAIGNID: string
  YAXXA_NAME: string | null
  SS_TITLE: string | null
  CREATED_BY: string | null
  CREATED_AT: unknown
}

/** A resolution failure is the likeliest first fault, so it explains itself. */
function unresolved(which: string, cols: ResolvedColumns, source: typeof SS_SOURCE) {
  return NextResponse.json(
    {
      error:
        `Could not work out which columns to read on ${which} (${source.table}). ` +
        `Looked for an id among [${source.idCandidates.join(", ")}] and a name among ` +
        `[${source.labelCandidates.join(", ")}], and found ` +
        `id=${cols.id ?? "none"}, name=${cols.label ?? "none"}. ` +
        `Run scripts/dialler/00-discover-columns.sql to see the real column list, then add ` +
        `the right name to the candidates in lib/dialler-campaign-map.ts. ` +
        `If the table lists no columns at all, the app's role is missing SELECT on it — ` +
        `run scripts/dialler/01-grants.sql.`,
    },
    { status: 500 }
  )
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "dialler")
  if (guard instanceof NextResponse) return guard

  const url = request.nextUrl
  const search = url.searchParams.get("search") ?? ""
  const modeRaw = url.searchParams.get("mode")
  const mode: MapFilter = modeRaw === "mapped" || modeRaw === "unmapped" ? modeRaw : "all"
  const limitRaw = Number(url.searchParams.get("limit") ?? 25)
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 25
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  try {
    const [ssCols, yaxxaCols] = await Promise.all([
      resolveSourceColumns(SS_SOURCE),
      resolveSourceColumns(YAXXA_SOURCE),
    ])
    if (!isResolved(ssCols)) return unresolved("SilverSurfer", ssCols, SS_SOURCE)
    if (!isResolved(yaxxaCols)) return unresolved("Yaxxa", yaxxaCols, YAXXA_SOURCE)

    await executeSnowflakeQuery(buildEnsureMapTable(), MAP_SF_OPTS)

    const [campaigns, counts] = await Promise.all([
      executeSnowflakeQuery<CampaignRow>(
        buildCampaigns(SS_SOURCE, ssCols, search, limit, offset, mode),
        { database: SS_SOURCE.database, schema: SS_SOURCE.schema }
      ),
      executeSnowflakeQuery<{ CNT: number | string }>(
        buildCampaignCount(SS_SOURCE, ssCols, search, mode),
        { database: SS_SOURCE.database, schema: SS_SOURCE.schema }
      ),
    ])

    // Mappings for this page only — one query for the page rather than one per
    // campaign, which at 25 rows would be 25 round trips to draw a list.
    const ids = campaigns.map((c) => String(c.CAMPAIGN_ID))
    const mappings = ids.length
      ? await executeSnowflakeQuery<MapRow>(buildMappingsFor(ids), MAP_SF_OPTS)
      : []

    const byCampaign = new Map<string, { yaxxaId: string; yaxxaName: string | null }[]>()
    for (const m of mappings) {
      const key = String(m.SS_CAMPAIGNID)
      const list = byCampaign.get(key) ?? []
      list.push({ yaxxaId: String(m.YAXXA_CAMPAIGNID), yaxxaName: m.YAXXA_NAME ?? null })
      byCampaign.set(key, list)
    }

    // Health checks are best effort. A screen that will not load because a
    // diagnostic failed is worse than one without its warnings.
    let tabTotal = 0
    let tabMapped = 0
    let stale: unknown[] = []
    let doubleBooked: unknown[] = []
    try {
      const r = await executeSnowflakeQuery<{ TOTAL: number | string; MAPPED: number | string }>(
        buildTabCounts(ssCols, search),
        { database: SS_SOURCE.database, schema: SS_SOURCE.schema }
      )
      tabTotal = Number(r[0]?.TOTAL ?? 0)
      tabMapped = Number(r[0]?.MAPPED ?? 0)
    } catch (e) {
      console.error("[/api/dialler/campaign-map] tab counts failed:", e)
    }
    try {
      stale = await executeSnowflakeQuery(buildStaleMappings(ssCols, yaxxaCols), MAP_SF_OPTS)
    } catch (e) {
      console.error("[/api/dialler/campaign-map] stale check failed:", e)
    }
    try {
      doubleBooked = await executeSnowflakeQuery(buildDoubleBookedCheck(), MAP_SF_OPTS)
    } catch (e) {
      console.error("[/api/dialler/campaign-map] double-booked check failed:", e)
    }

    return NextResponse.json({
      mode,
      total: Number(counts[0]?.CNT ?? 0),
      limit,
      offset,
      // For the tab labels. Derived from one scan so the three always add up.
      tabs: { all: tabTotal, mapped: tabMapped, unmapped: Math.max(0, tabTotal - tabMapped) },
      staleCount: stale.length,
      doubleBookedCount: doubleBooked.length,
      // Echoed so a wrong resolution is visible on the screen rather than
      // silently producing an odd-looking list.
      resolved: {
        silversurfer: { table: SS_SOURCE.table, ...ssCols },
        yaxxa: { table: YAXXA_SOURCE.table, ...yaxxaCols },
      },
      campaigns: campaigns.map((c) => ({
        id: String(c.CAMPAIGN_ID),
        title: c.LABEL ?? "",
        yaxxa: byCampaign.get(String(c.CAMPAIGN_ID)) ?? [],
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler/campaign-map GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** POST — attach a Yaxxa campaign, moving it if it already belongs elsewhere. */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "dialler")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const ssId = String(body.ssId ?? "").trim()
  const yaxxaId = String(body.yaxxaId ?? "").trim()
  const ssTitle = body.ssTitle == null ? null : String(body.ssTitle).trim()
  const yaxxaName = body.yaxxaName == null ? null : String(body.yaxxaName).trim()
  if (!ssId || !yaxxaId) {
    return NextResponse.json({ error: "ssId and yaxxaId are required" }, { status: 400 })
  }

  try {
    await executeSnowflakeQuery(buildEnsureMapTable(), MAP_SF_OPTS)

    // Read the current owner BEFORE the merge, so the response can name it.
    // After the merge it is gone, and "moved from where" is the one thing the
    // person doing it needs to hear.
    const owner = await executeSnowflakeQuery<{ SS_CAMPAIGNID: string; SS_TITLE: string | null }>(
      buildOwnerOf(yaxxaId),
      MAP_SF_OPTS
    )
    const previous = owner[0]
    const movedFrom =
      previous && String(previous.SS_CAMPAIGNID) !== ssId
        ? { ssId: String(previous.SS_CAMPAIGNID), ssTitle: previous.SS_TITLE ?? null }
        : null

    await executeSnowflakeQuery(
      buildAttach(ssId, ssTitle, yaxxaId, yaxxaName, guard.email),
      MAP_SF_OPTS
    )
    return NextResponse.json({ ok: true, movedFrom })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler/campaign-map POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** DELETE — detach one Yaxxa campaign from one SilverSurfer campaign. */
export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "dialler")
  if (guard instanceof NextResponse) return guard

  let body: { ssId?: unknown; yaxxaId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const ssId = String(body.ssId ?? "").trim()
  const yaxxaId = String(body.yaxxaId ?? "").trim()
  if (!ssId || !yaxxaId) {
    return NextResponse.json({ error: "ssId and yaxxaId are required" }, { status: 400 })
  }

  try {
    await executeSnowflakeQuery(buildDetach(ssId, yaxxaId), MAP_SF_OPTS)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler/campaign-map DELETE] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
