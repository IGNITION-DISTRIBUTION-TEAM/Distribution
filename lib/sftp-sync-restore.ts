/**
 * Turning a stored sync configuration back into wizard state, and back again.
 *
 * PURE. NO REACT. This lives outside the component deliberately: the first cut
 * of "Open in wizard" put this arithmetic inline in a `useEffect`, where it
 * could not be tested, and it silently DROPPED any column that came after a
 * skipped source field. A config mapping ordinals 1 and 3 reopened as a config
 * mapping only ordinal 1, and redeploying it wrote a sync that loaded one
 * column instead of two — with no error and no warning.
 *
 * The two functions here are inverses across the wizard's state, and
 * scripts/task-automation/restore-tests.ts asserts that a round trip through
 * them regenerates byte-identical SQL.
 */
import { SKIP_VALUE, type TargetColumn } from "@/lib/column-mapping"
import type { ColumnMap, SyncConfig } from "@/lib/sftp-sync-codegen"

export type RestoredWizardState = {
  /**
   * Source column names by POSITION, not packed.
   *
   * `ColumnMap.ordinal` is 1-based and refers to the field's position in the
   * FILE, so a mapping of ordinals 1 and 3 has to restore to three headers with
   * a placeholder in the middle. Packing them into two is what lost a column.
   */
  headers: string[]
  /** Dense: every index 0..headers.length-1 has a target or SKIP_VALUE. */
  mapping: Record<number, string>
  newTypes: Record<string, string>
  destMode: "existing" | "new"
  destTable: string
}

/** A stand-in name for a file field the operator chose not to map. */
function placeholder(index: number): string {
  return `COL${index + 1}`
}

export function restoreFromConfig(cfg: SyncConfig): RestoredWizardState {
  const width = cfg.columns.reduce((n, c) => Math.max(n, c.ordinal), 0)
  const headers: string[] = []
  const mapping: Record<number, string> = {}

  for (let i = 0; i < width; i++) {
    headers.push(placeholder(i))
    // Explicitly SKIP, not left blank. The wizard's auto-match effect fills any
    // blank it finds, which would quietly re-add a column that was deliberately
    // excluded the first time round.
    mapping[i] = SKIP_VALUE
  }
  for (const c of cfg.columns) {
    const i = c.ordinal - 1
    if (i < 0 || i >= width) continue
    headers[i] = c.source || placeholder(i)
    mapping[i] = c.target
  }

  const newTypes: Record<string, string> = {}
  for (const c of cfg.columns) newTypes[c.target] = c.type

  return {
    headers,
    mapping,
    newTypes,
    destMode: cfg.createTable ? "new" : "existing",
    destTable: `${cfg.targetDb}.${cfg.targetSchema}.${cfg.targetTable}`,
  }
}

/**
 * The column list the wizard sends to the generator.
 *
 * Exported and used by the component rather than duplicated there, so the
 * round-trip test exercises the real code path instead of a copy of it.
 *
 * The ordinal is the position in the FILE (`i + 1`), never the position among
 * the mapped columns — a skipped field must not shift the ones after it, which
 * is the whole point of the placeholder headers above.
 */
export function rebuildColumns(
  headers: string[],
  mapping: Record<number, string>,
  newTypes: Record<string, string>,
  destMode: "existing" | "new",
  targetColumns: TargetColumn[]
): ColumnMap[] {
  return headers
    .map((h, i) => ({
      h,
      i,
      target: destMode === "new" ? targetColumns[i]?.COLUMN_NAME : mapping[i],
    }))
    .filter((m) => m.target && m.target !== SKIP_VALUE)
    .map((m) => ({
      source: m.h,
      ordinal: m.i + 1,
      target: m.target as string,
      type: newTypes[m.target as string] ?? "VARCHAR(1000)",
    }))
}
