import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  AUDIT_SF_OPTS,
  MAX_IMPORT_ROWS,
  SF_OPTS,
  buildAuditInsert,
  buildEnsureAuditTable,
  buildImportMerge,
  buildSearch,
  looksAmbiguous,
  normProductName,
  normValue,
  validateMapping,
  type ProductMapping,
} from "@/lib/billing-mappings"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

/**
 * Bulk import of the product mapping from a spreadsheet.
 *
 * TWO PHASES, ALWAYS. `dryRun: true` returns what WOULD change and writes
 * nothing; only a second call with `dryRun: false` writes. The screen will not
 * let you skip the preview, and that is deliberate — this endpoint can rewrite
 * the channel and brand attribution of the entire product catalogue in one
 * statement, and the person clicking it is a business user with a spreadsheet,
 * not an engineer reading a diff.
 *
 * AN IMPORT NEVER DELETES. Rows absent from the file are left exactly as they
 * are. Someone uploading a filtered export by mistake would otherwise wipe
 * every mapping not in their filter, and the first anyone would know of it is
 * next month's executive report.
 */

type Row = {
  PRODUCT_NAME: string
  PRODUCT_GROUP: string | null
  VAS_BUTTON_FLAG: string | null
  CHANNEL_OVERRIDE: string | null
  BRAND_OVERRIDE: string | null
}

type Verdict = {
  productName: string
  action: "create" | "update" | "unchanged" | "rejected"
  reason?: string
  before?: ProductMapping | null
  after?: ProductMapping
}

const same = (a: string | null, b: string | null) => (a ?? "") === (b ?? "")

function unchanged(before: ProductMapping, after: ProductMapping): boolean {
  return (
    same(before.productGroup, after.productGroup) &&
    same(before.vasButtonFlag, after.vasButtonFlag) &&
    same(before.channelOverride, after.channelOverride) &&
    same(before.brandOverride, after.brandOverride)
  )
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "paiment")
  if (guard instanceof NextResponse) return guard

  let body: { rows?: unknown; dryRun?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 })
  }
  if (body.rows.length === 0) {
    return NextResponse.json({ error: "The file has no rows" }, { status: 400 })
  }
  if (body.rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      { error: `That file has ${body.rows.length} rows; the limit is ${MAX_IMPORT_ROWS}` },
      { status: 400 }
    )
  }
  const dryRun = body.dryRun !== false

  // Normalise and validate every row before touching Snowflake, so a bad row
  // is reported against its product name rather than as a failed statement.
  const parsed: ProductMapping[] = []
  const verdicts: Verdict[] = []
  const seen = new Map<string, number>()

  for (const raw of body.rows as Record<string, unknown>[]) {
    const row: ProductMapping = {
      productName: normProductName(String(raw.productName ?? "")),
      productGroup: normValue(raw.productGroup as string | null),
      vasButtonFlag: normValue(raw.vasButtonFlag as string | null),
      channelOverride: normValue(raw.channelOverride as string | null),
      brandOverride: normValue(raw.brandOverride as string | null),
    }

    const invalid = validateMapping(row)
    if (invalid) {
      verdicts.push({ productName: row.productName, action: "rejected", reason: invalid })
      continue
    }
    const ambiguous = looksAmbiguous(row.productName)
    if (ambiguous) {
      verdicts.push({
        productName: row.productName,
        action: "rejected",
        reason: `Name ${ambiguous} — it would never match the billing data`,
      })
      continue
    }
    // Two rows in one file for the same product: the MERGE would be
    // non-deterministic about which wins, so refuse both rather than pick one.
    const key = row.productName.toUpperCase()
    const first = seen.get(key)
    if (first !== undefined) {
      verdicts.push({
        productName: row.productName,
        action: "rejected",
        reason: `Appears more than once in this file (also row ${first + 1})`,
      })
      continue
    }
    seen.set(key, parsed.length)
    parsed.push(row)
  }

  if (parsed.length === 0) {
    return NextResponse.json({ dryRun, verdicts, counts: summarise(verdicts) })
  }

  try {
    // Current state for exactly the products in the file. Fetched in one read
    // rather than per row: an import of 2,000 products would otherwise be 2,000
    // round trips to decide what a preview says.
    const existing = await executeSnowflakeQuery<Row>(buildSearch("", 500, 0), SF_OPTS)
    const byKey = new Map<string, ProductMapping>()
    for (const r of existing) {
      byKey.set(String(r.PRODUCT_NAME ?? "").trim().toUpperCase(), {
        productName: String(r.PRODUCT_NAME ?? ""),
        productGroup: r.PRODUCT_GROUP ?? null,
        vasButtonFlag: r.VAS_BUTTON_FLAG ?? null,
        channelOverride: r.CHANNEL_OVERRIDE ?? null,
        brandOverride: r.BRAND_OVERRIDE ?? null,
      })
    }

    const toWrite: ProductMapping[] = []
    for (const row of parsed) {
      const before = byKey.get(row.productName.toUpperCase()) ?? null
      if (!before) {
        verdicts.push({ productName: row.productName, action: "create", before: null, after: row })
        toWrite.push(row)
      } else if (unchanged(before, row)) {
        verdicts.push({ productName: row.productName, action: "unchanged", before, after: row })
      } else {
        verdicts.push({ productName: row.productName, action: "update", before, after: row })
        toWrite.push(row)
      }
    }

    const counts = summarise(verdicts)
    if (dryRun) return NextResponse.json({ dryRun: true, verdicts, counts })

    if (toWrite.length > 0) {
      await executeSnowflakeQuery(buildImportMerge(toWrite), SF_OPTS)
      // One audit row per product, not one per import: the log has to answer
      // "what was this product's override last set to, and by whom", and a
      // single row naming the file cannot.
      try {
        await executeSnowflakeQuery(buildEnsureAuditTable(), AUDIT_SF_OPTS)
        for (const row of toWrite) {
          const before = byKey.get(row.productName.toUpperCase()) ?? null
          await executeSnowflakeQuery(
            buildAuditInsert("import", row.productName, before, row, guard.email),
            AUDIT_SF_OPTS
          )
        }
      } catch (error) {
        console.error("[/api/paiment/.../import] audit write failed:", error)
      }
    }

    return NextResponse.json({ dryRun: false, applied: toWrite.length, verdicts, counts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/paiment/product-mappings/import] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function summarise(verdicts: Verdict[]) {
  return {
    create: verdicts.filter((v) => v.action === "create").length,
    update: verdicts.filter((v) => v.action === "update").length,
    unchanged: verdicts.filter((v) => v.action === "unchanged").length,
    rejected: verdicts.filter((v) => v.action === "rejected").length,
  }
}
