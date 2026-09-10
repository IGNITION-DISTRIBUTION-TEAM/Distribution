import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  AUDIT_SF_OPTS,
  SF_OPTS,
  buildAuditInsert,
  buildCollapseExactCopies,
  buildDuplicateGroupCount,
  buildDuplicateGroups,
  buildEnsureAuditTable,
  buildExactCopyImpact,
  buildResolveOne,
  buildRowsForKeys,
  normProductName,
  normValue,
  validateMapping,
  type DuplicateMode,
  type ProductMapping,
} from "@/lib/billing-mappings"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

/**
 * Resolving the duplicate product mappings.
 *
 * The mapping has hundreds of product names appearing more than once, and the
 * billing fact table LEFT JOINs to it on the name alone — so each surplus row
 * is one extra copy of every sale that product has. The main screen reports
 * that; this is where it gets fixed.
 *
 * TWO KINDS OF DUPLICATE, TWO DIFFERENT ACTIONS, AND THE SEPARATION MATTERS:
 *
 *   exact copies  every row says the same thing. Collapsing is lossless and
 *                 needs no judgement, so it is one bulk action.
 *   conflicts     the rows disagree about group, VAS flag or an override.
 *                 Something has to pick, and picking is a business decision —
 *                 so it is one product at a time, with the competing rows in
 *                 front of the person choosing.
 *
 * The bulk action can only ever touch the first kind; the SQL excludes
 * disagreements rather than trusting the caller to.
 */

type GroupRow = {
  PRODUCT_KEY: string
  ROWS_FOUND: number | string
  DISTINCT_SHAPES: number | string
}

type MappingRow = {
  PRODUCT_NAME: string
  PRODUCT_GROUP: string | null
  VAS_BUTTON_FLAG: string | null
  CHANNEL_OVERRIDE: string | null
  BRAND_OVERRIDE: string | null
}

const toMapping = (r: MappingRow): ProductMapping => ({
  productName: String(r.PRODUCT_NAME ?? ""),
  productGroup: r.PRODUCT_GROUP ?? null,
  vasButtonFlag: r.VAS_BUTTON_FLAG ?? null,
  channelOverride: r.CHANNEL_OVERRIDE ?? null,
  brandOverride: r.BRAND_OVERRIDE ?? null,
})

function parseMode(raw: string | null): DuplicateMode {
  return raw === "copies" || raw === "all" ? raw : "conflicts"
}

/** GET — a page of duplicate groups, each with the rows competing in it. */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  const url = request.nextUrl
  const mode = parseMode(url.searchParams.get("mode"))
  const limitRaw = Number(url.searchParams.get("limit") ?? 25)
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 25
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  try {
    const [groups, counts, impact] = await Promise.all([
      executeSnowflakeQuery<GroupRow>(buildDuplicateGroups(mode, limit, offset), SF_OPTS),
      executeSnowflakeQuery<{ CNT: number | string }>(buildDuplicateGroupCount(mode), SF_OPTS),
      executeSnowflakeQuery<{ KEYS_AFFECTED: number | string; ROWS_REMOVED: number | string }>(
        buildExactCopyImpact(),
        SF_OPTS
      ),
    ])

    // The rows are fetched for the page's keys only — one extra query for the
    // page rather than one per group, which at 25 groups would be 25 round
    // trips to render a screen.
    const keys = groups.map((g) => String(g.PRODUCT_KEY))
    const rows = keys.length > 0
      ? await executeSnowflakeQuery<MappingRow>(buildRowsForKeys(keys), SF_OPTS)
      : []

    const byKey = new Map<string, ProductMapping[]>()
    for (const r of rows) {
      const key = String(r.PRODUCT_NAME ?? "").trim().toUpperCase()
      const list = byKey.get(key) ?? []
      list.push(toMapping(r))
      byKey.set(key, list)
    }

    return NextResponse.json({
      mode,
      total: Number(counts[0]?.CNT ?? 0),
      limit,
      offset,
      exactCopyKeys: Number(impact[0]?.KEYS_AFFECTED ?? 0),
      exactCopyRowsRemoved: Number(impact[0]?.ROWS_REMOVED ?? 0),
      groups: groups.map((g) => ({
        productKey: String(g.PRODUCT_KEY),
        rowsFound: Number(g.ROWS_FOUND ?? 0),
        conflicting: Number(g.DISTINCT_SHAPES ?? 1) > 1,
        rows: byKey.get(String(g.PRODUCT_KEY)) ?? [],
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/paiment/.../duplicates GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST — collapse every exact-copy group, or resolve one conflict.
 *
 * Both delete rows, so both need an explicit confirmation. The words differ on
 * purpose: a mistyped "DELETE" should not fire the bulk action.
 */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // ---------------------------------------------------------- bulk collapse
  if (body.action === "collapse-copies") {
    if (body.confirm !== "COLLAPSE") {
      return NextResponse.json(
        { error: 'Send confirm: "COLLAPSE" to collapse the exact copies' },
        { status: 400 }
      )
    }
    try {
      // Measured before, so the audit row and the toast report what actually
      // happened rather than what the screen last showed.
      const before = await executeSnowflakeQuery<{
        KEYS_AFFECTED: number | string
        ROWS_REMOVED: number | string
      }>(buildExactCopyImpact(), SF_OPTS)
      const keysAffected = Number(before[0]?.KEYS_AFFECTED ?? 0)
      const rowsRemoved = Number(before[0]?.ROWS_REMOVED ?? 0)

      if (keysAffected === 0) {
        return NextResponse.json({ ok: true, keysAffected: 0, rowsRemoved: 0 })
      }

      await executeSnowflakeQuery(buildCollapseExactCopies(), SF_OPTS)

      try {
        await executeSnowflakeQuery(buildEnsureAuditTable(), AUDIT_SF_OPTS)
        await executeSnowflakeQuery(
          buildAuditInsert(
            "collapse",
            `(bulk: ${keysAffected} products)`,
            null,
            null,
            guard.email
          ),
          AUDIT_SF_OPTS
        )
      } catch (e) {
        console.error("[/api/paiment/.../duplicates] audit write failed:", e)
      }

      return NextResponse.json({ ok: true, keysAffected, rowsRemoved })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[/api/paiment/.../duplicates collapse] error:", message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // -------------------------------------------------------- resolve one key
  if (body.action === "resolve") {
    if (body.confirm !== "RESOLVE") {
      return NextResponse.json(
        { error: 'Send confirm: "RESOLVE" to keep one row and remove the others' },
        { status: 400 }
      )
    }
    const keepRaw = (body.keep ?? {}) as Record<string, unknown>
    const keep: ProductMapping = {
      productName: normProductName(String(keepRaw.productName ?? "")),
      productGroup: normValue(keepRaw.productGroup as string | null),
      vasButtonFlag: normValue(keepRaw.vasButtonFlag as string | null),
      channelOverride: normValue(keepRaw.channelOverride as string | null),
      brandOverride: normValue(keepRaw.brandOverride as string | null),
    }
    const invalid = validateMapping(keep)
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

    const productKey = String(body.productKey ?? "").trim().toUpperCase()
    if (!productKey) {
      return NextResponse.json({ error: "productKey is required" }, { status: 400 })
    }
    // The chosen row has to belong to the group being resolved, or this would
    // delete one product's rows and insert a different product entirely.
    if (keep.productName.toUpperCase() !== productKey) {
      return NextResponse.json(
        { error: "The row you kept is not one of this product's rows" },
        { status: 400 }
      )
    }

    try {
      const existing = await executeSnowflakeQuery<MappingRow>(
        buildRowsForKeys([productKey]),
        SF_OPTS
      )
      if (existing.length === 0) {
        return NextResponse.json({ error: `No rows found for "${productKey}"` }, { status: 404 })
      }

      await executeSnowflakeQuery(buildResolveOne(productKey, keep), SF_OPTS)

      try {
        await executeSnowflakeQuery(buildEnsureAuditTable(), AUDIT_SF_OPTS)
        // The whole discarded set goes in BEFORE_JSON, so a resolution made in
        // haste can be read back and reversed.
        await executeSnowflakeQuery(
          buildAuditInsert(
            "resolve",
            keep.productName,
            { ...toMapping(existing[0]), productName: JSON.stringify(existing.map(toMapping)) },
            keep,
            guard.email
          ),
          AUDIT_SF_OPTS
        )
      } catch (e) {
        console.error("[/api/paiment/.../duplicates] audit write failed:", e)
      }

      return NextResponse.json({ ok: true, removed: existing.length - 1, kept: keep })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[/api/paiment/.../duplicates resolve] error:", message)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  return NextResponse.json(
    { error: 'action must be "collapse-copies" or "resolve"' },
    { status: 400 }
  )
}
