import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { HLL_TABLE } from "@/lib/hll-insert"
import { resolveExportLayout } from "@/lib/distribution-export"
import { ensureConfigsTable } from "@/lib/distribution-steps"
import { PRESETS, TRANSFORMS, defaultLayout, validateLayout } from "@/lib/export-layout"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * What the export layout editor needs, in one call.
 *
 * The layout currently in force for the campaign, the live column list of the
 * leads table to populate the source dropdown, and the fixed transform/preset
 * vocabularies so the UI never hardcodes a list that can drift from the one
 * the validator enforces.
 *
 * Read-only. Saving goes through /api/campaign-configs with the rest of the
 * config, so a layout cannot be saved against a campaign that has none.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const raw = request.nextUrl.searchParams.get("campaignId") ?? ""
  if (!/^[0-9]+$/.test(raw)) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const cid = Number(raw)

  try {
    // Self-migrate first: EXPORT_LAYOUT_JSON is a new column, and until
    // something adds it every read of it errors and falls back silently. This
    // is an admin screen, so paying two round trips here is the cheap place to
    // make sure the column exists before anyone tries to save one.
    await ensureConfigsTable()
    const [resolved, columns] = await Promise.all([
      resolveExportLayout(cid),
      loadHllColumns(),
    ])
    return NextResponse.json({
      layout: resolved.layout,
      isDefault: resolved.isDefault,
      configName: resolved.configName,
      defaultLayout: defaultLayout(),
      sourceColumns: columns,
      transforms: Object.entries(TRANSFORMS).map(([id, t]) => ({ id, label: t.label })),
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export-layout GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * The leads table's real columns.
 *
 * The same INFORMATION_SCHEMA read /api/distribution/columns does, inlined
 * rather than fetched over HTTP from our own server — this route already holds
 * the guard, and a second hop would just add a failure mode.
 */
async function loadHllColumns(): Promise<{ name: string; type: string }[]> {
  const [db, schema, table] = HLL_TABLE.split(".")
  const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string; DATA_TYPE: string }>(
    `SELECT COLUMN_NAME, DATA_TYPE FROM ${db}.INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${table}'
      ORDER BY ORDINAL_POSITION`
  )
  return rows.map((r) => ({ name: String(r.COLUMN_NAME), type: String(r.DATA_TYPE) }))
}

/**
 * Check a layout without saving it, so the editor can show problems as they
 * are made rather than only on save.
 *
 * Validates against the live column list — the same check the save path runs,
 * because a preview that is more permissive than the saver is worse than no
 * preview at all.
 */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const columns = await loadHllColumns()
    const known = new Set(columns.map((c) => c.name.toUpperCase()))
    const checked = validateLayout(body.layout, known)
    return NextResponse.json(
      checked.ok ? { ok: true, layout: checked.layout } : { ok: false, problems: checked.problems }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export-layout POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
