import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  AUDIT_SF_OPTS,
  MAX_VALUE_LEN,
  PRODUCT_MAPPING,
  SF_OPTS,
  buildAuditInsert,
  buildCount,
  buildDelete,
  buildDriftCheck,
  buildDuplicateCheck,
  buildEnsureAuditTable,
  buildGetOne,
  buildSearch,
  buildUpsert,
  looksAmbiguous,
  normProductName,
  normValue,
  validateMapping,
  type ProductMapping,
} from "@/lib/billing-mappings"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The billing product mapping, maintained by the business.
 *
 * Guarded on the Paiment department rather than super-admin. This is the same
 * call the calendar recipient list makes and for the same reason: it is
 * content, not authorization data. The difference worth naming is the blast
 * radius — a wrong row here silently changes how revenue is attributed in
 * executive reporting, and nothing downstream will complain. Hence: every write
 * is audited to a table in the app's own schema, deletes need an explicit
 * confirmation, and the duplicate and drift checks ride along on every GET so
 * the screen can say something is wrong before anyone asks.
 */

type Row = {
  PRODUCT_NAME: string
  PRODUCT_GROUP: string | null
  VAS_BUTTON_FLAG: string | null
  CHANNEL_OVERRIDE: string | null
  BRAND_OVERRIDE: string | null
}

const toMapping = (r: Row): ProductMapping => ({
  productName: String(r.PRODUCT_NAME ?? ""),
  productGroup: r.PRODUCT_GROUP ?? null,
  vasButtonFlag: r.VAS_BUTTON_FLAG ?? null,
  channelOverride: r.CHANNEL_OVERRIDE ?? null,
  brandOverride: r.BRAND_OVERRIDE ?? null,
})

/**
 * Turn Snowflake's "I cannot see that object" into something actionable.
 *
 * The BI table name in lib/billing-mappings.ts is a documented assumption until
 * someone runs the resolve script, so this is the most likely first failure and
 * the raw Snowflake text would send the reader looking in the wrong place.
 */
function explain(message: string): string {
  if (/does not exist or not authorized|Object '[^']+' does not exist/i.test(message)) {
    return (
      `${message}\n\nThe mapping table is configured as ${PRODUCT_MAPPING.table}. ` +
      `That name is an assumption until it is confirmed — run ` +
      `scripts/paiment/00-resolve-and-diagnose.sql section 1 to resolve the real table ` +
      `behind ${PRODUCT_MAPPING.view}, then correct PRODUCT_MAPPING in ` +
      `lib/billing-mappings.ts. If the name is right, the app's role is missing grants: ` +
      `run scripts/paiment/01-grants.sql.`
    )
  }
  return message
}

/** Best-effort: a failed audit write must not fail the change it describes. */
async function audit(sql: string): Promise<void> {
  try {
    await executeSnowflakeQuery(buildEnsureAuditTable(), AUDIT_SF_OPTS)
    await executeSnowflakeQuery(sql, AUDIT_SF_OPTS)
  } catch (error) {
    console.error("[/api/paiment/product-mappings] audit write failed:", error)
  }
}

/** GET — a page of mappings, plus the two health checks the screen surfaces. */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  const url = request.nextUrl
  const search = url.searchParams.get("search") ?? ""
  const limitRaw = Number(url.searchParams.get("limit") ?? 100)
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  try {
    const [rows, counts] = await Promise.all([
      executeSnowflakeQuery<Row>(buildSearch(search, limit, offset), SF_OPTS),
      executeSnowflakeQuery<{ CNT: number | string }>(buildCount(search), SF_OPTS),
    ])
    const total = Number(counts[0]?.CNT ?? 0)

    // Health checks are best-effort: a screen that will not load because a
    // diagnostic failed is worse than a screen without its warnings.
    let duplicates: { PRODUCT_KEY: string; ROWS_FOUND: number }[] = []
    let drift: { PRODUCT_NAME: string }[] = []
    try {
      duplicates = await executeSnowflakeQuery(buildDuplicateCheck(), SF_OPTS)
    } catch (e) {
      console.error("[/api/paiment/product-mappings] duplicate check failed:", e)
    }
    try {
      drift = await executeSnowflakeQuery(buildDriftCheck(), AUDIT_SF_OPTS)
    } catch {
      // The audit table may not exist yet on a first run. Not an error.
    }

    return NextResponse.json({
      rows: rows.map(toMapping),
      total,
      limit,
      offset,
      duplicates,
      driftCount: drift.length,
      table: PRODUCT_MAPPING.table,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/paiment/product-mappings GET] error:", message)
    return NextResponse.json({ error: explain(message) }, { status: 500 })
  }
}

/** POST — create or update one mapping. */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const incoming: ProductMapping = {
    productName: normProductName(String(body.productName ?? "")),
    productGroup: normValue(body.productGroup as string | null),
    vasButtonFlag: normValue(body.vasButtonFlag as string | null),
    channelOverride: normValue(body.channelOverride as string | null),
    brandOverride: normValue(body.brandOverride as string | null),
  }

  const invalid = validateMapping(incoming)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })

  // Not fatal, but the row would never join, so saying so is the whole value.
  const ambiguous = looksAmbiguous(incoming.productName)
  if (ambiguous) {
    return NextResponse.json(
      {
        error:
          `The product name ${ambiguous}. It looks identical on screen but will not match ` +
          `the billing data, so the override would never apply. Retype the name rather than ` +
          `pasting it.`,
      },
      { status: 400 }
    )
  }

  try {
    const existing = await executeSnowflakeQuery<Row>(buildGetOne(incoming.productName), SF_OPTS)
    const before = existing.length > 0 ? toMapping(existing[0]) : null

    await executeSnowflakeQuery(buildUpsert(incoming), SF_OPTS)
    await audit(
      buildAuditInsert(
        before ? "update" : "create",
        incoming.productName,
        before,
        incoming,
        guard.email
      )
    )
    return NextResponse.json({ ok: true, created: !before, row: incoming })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/paiment/product-mappings POST] error:", message)
    return NextResponse.json({ error: explain(message) }, { status: 500 })
  }
}

/**
 * DELETE — remove one mapping.
 *
 * Requires `confirm: "DELETE"`, matching the Remove-duplicates precedent. A
 * mapping removed by accident does not error anywhere: the product silently
 * reverts to campaign-based attribution and the number in the executive report
 * quietly changes.
 */
export async function DELETE(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  let body: { productName?: unknown; confirm?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.confirm !== "DELETE") {
    return NextResponse.json({ error: 'Send confirm: "DELETE" to remove a mapping' }, { status: 400 })
  }
  const name = normProductName(String(body.productName ?? ""))
  if (!name) return NextResponse.json({ error: "productName is required" }, { status: 400 })
  if (name.length > MAX_VALUE_LEN) {
    return NextResponse.json({ error: "productName is too long" }, { status: 400 })
  }

  try {
    const existing = await executeSnowflakeQuery<Row>(buildGetOne(name), SF_OPTS)
    if (existing.length === 0) {
      return NextResponse.json({ error: `No mapping found for "${name}"` }, { status: 404 })
    }
    await executeSnowflakeQuery(buildDelete(name), SF_OPTS)
    await audit(buildAuditInsert("delete", name, toMapping(existing[0]), null, guard.email))
    return NextResponse.json({ ok: true, deleted: name })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/paiment/product-mappings DELETE] error:", message)
    return NextResponse.json({ error: explain(message) }, { status: 500 })
  }
}
