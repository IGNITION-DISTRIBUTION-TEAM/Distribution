#!/usr/bin/env node
/**
 * <CompactStat|SyncStat|SummaryCard … accent=… /> → <StatTile … tone=… />
 *
 *   node scripts/codemods/rename-stat-tiles.mjs <file.tsx> [...]
 *
 * AST-based for the same reason as replace-jsx.mjs: `accent=` must only be
 * renamed on these three components, and a prop value can legally contain the
 * characters a regex would trip on. CompactStat rendered its value at
 * text-base, so it becomes size="sm"; the other two were text-2xl, the default.
 */
import ts from "typescript"
import { readFileSync, writeFileSync } from "node:fs"

const MAP = { CompactStat: ' size="sm"', SyncStat: "", SummaryCard: "" }
const IMPORT = 'import { StatTile } from "@/components/kit/stat-tile"'

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  let n = 0
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf)
      if (tag in MAP) {
        n++
        edits.push({ start: node.tagName.getStart(sf), end: node.tagName.getEnd(), text: `StatTile${MAP[tag]}` })
        for (const a of node.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name.getText(sf) === "accent") {
            edits.push({ start: a.name.getStart(sf), end: a.name.getEnd(), text: "tone" })
          }
        }
      }
    }
    if (ts.isJsxClosingElement(node) && node.tagName.getText(sf) in MAP) {
      edits.push({ start: node.tagName.getStart(sf), end: node.tagName.getEnd(), text: "StatTile" })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!n) { console.log(`${file}: nothing to do`); continue }
  if (!src.includes(IMPORT)) {
    const last = sf.statements.filter(ts.isImportDeclaration).at(-1)
    edits.push({ start: last.getEnd(), end: last.getEnd(), text: `\n${IMPORT}` })
  }
  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  writeFileSync(file, out)
  console.log(`${file}: ${n} tile(s) → StatTile`)
}
