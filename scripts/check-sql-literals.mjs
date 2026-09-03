#!/usr/bin/env node
/**
 * Flag Python-style implicit string concatenation in SQL position.
 *
 *     COMMENT 'first half '
 *             'second half'      <-- valid Python, SQL syntax error
 *
 * Easy to write by accident in a .sql file that also contains Python stored
 * procedure bodies, which is exactly how it got into 01-bootstrap.sql: Snowflake
 * reported only the first of nine.
 *
 * Text inside $$ ... $$ or $BODY$ ... $BODY$ is a procedure body, where the
 * idiom is correct, so it is skipped.
 *
 *   node scripts/check-sql-literals.mjs                  # all scripts/**\/*.sql
 *   node scripts/check-sql-literals.mjs path/to/one.sql
 *
 * Exits non-zero if anything is found, so it can gate a commit.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"

const DOLLAR_TAG = /^\$[A-Za-z_]*\$;?$/

/** Lines that sit inside a $$-quoted body, which this check must not read as SQL. */
function bodyMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (open === null) {
      if (DOLLAR_TAG.test(t)) { open = t.replace(/;$/, ""); mask[i] = true }
      continue
    }
    mask[i] = true
    if (t === open || t === open + ";") open = null
  }
  return mask
}

export function findAdjacentLiterals(sql) {
  const lines = sql.split("\n")
  const inBody = bodyMask(lines)
  const hits = []

  // Track literal state across lines rather than counting quotes per line.
  // Counting per line was wrong in the obvious direction: a line that CLOSES a
  // literal has an EVEN number of quotes, and that is precisely the case to
  // flag. It also mishandles a literal that legitimately spans lines, which
  // Snowflake allows.
  let open = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const wasOpenAtStart = open

    if (!inBody[i]) {
      for (let c = 0; c < line.length; c++) {
        if (line[c] !== "'") continue
        if (open && line[c + 1] === "'") { c++; continue } // '' escape
        open = !open
      }
    }

    if (open || wasOpenAtStart || inBody[i]) continue

    // Line is complete SQL. Does it end a literal, and does the next line start one?
    const prev = line.replace(/\s+$/, "")
    const next = lines[i + 1]
    if (next === undefined || inBody[i + 1]) continue
    const cur = next.trim()
    if (!/'$/.test(prev) || !cur.startsWith("'")) continue

    hits.push({ line: i + 2, prev: prev.trim(), cur })
  }
  return hits
}

function sqlFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sqlFiles(p))
    else if (extname(p) === ".sql") out.push(p)
  }
  return out
}

const args = process.argv.slice(2)
const files = args.length ? args : sqlFiles("scripts")
let total = 0
for (const f of files) {
  const hits = findAdjacentLiterals(readFileSync(f, "utf8"))
  if (!hits.length) continue
  total += hits.length
  console.error(`\n${f}`)
  for (const h of hits) {
    console.error(`  line ${h.line}: continues a literal from the line above`)
    console.error(`    ${h.prev.slice(-70)}`)
    console.error(`    ${h.cur.slice(0, 70)}`)
  }
}
if (total) {
  console.error(
    `\n${total} adjacent string literal(s) in SQL position across ${files.length} file(s).` +
    `\nSQL has no implicit concatenation — join each into one literal, or move the` +
    `\nprose into a /* */ block if it is a COMMENT clause.`
  )
  process.exit(1)
}
console.log(`No adjacent SQL string literals in ${files.length} file(s).`)
