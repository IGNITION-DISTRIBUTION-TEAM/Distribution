#!/usr/bin/env node
/**
 * Replace hand-rolled JSX elements with the shared primitives, by exact match.
 *
 *   node scripts/codemods/replace-jsx.mjs [--dry] <file.tsx> [...]
 *
 * Why a parser and not a regex: turning `<div className="…">` into `<Card>`
 * also has to turn its matching `</div>` into `</Card>`, and only the syntax
 * tree knows which one that is. Uses the TypeScript compiler already in
 * node_modules; nothing to install.
 *
 * Only EXACT className matches are rewritten. A div with the card classes plus
 * anything else is left alone for a person to look at — same visual spec, but
 * the extra classes are why it was different, and that deserves eyes.
 *
 * Run it on one file at a time, read that file's diff, run tsc, commit.
 */
import ts from "typescript"
import { readFileSync, writeFileSync } from "node:fs"

const CARD = { name: "Card", from: "@/components/ui/card" }
const HEADING = (name) => ({ name, from: "@/components/kit/heading" })
const BANNER = { name: "Banner", from: "@/components/kit/banner" }

const ERROR_BANNER =
  "flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"

const RULES = [
  { tag: "div", className: "rounded-xl border border-border bg-card p-6", to: "Card", attrs: "", imp: CARD, extraAttrs: true },
  { tag: "div", className: "rounded-xl border border-border bg-card p-5", to: "Card", attrs: ' padding="dense"', imp: CARD, extraAttrs: true },
  { tag: "div", className: "rounded-xl border border-border bg-card", to: "Card", attrs: ' padding="none"', imp: CARD, extraAttrs: true },
  { tag: "h2", className: "text-2xl font-semibold text-foreground", to: "PageHeading", attrs: "", imp: HEADING("PageHeading") },
  { tag: "h3", className: "font-medium text-foreground", to: "SectionHeading", attrs: "", imp: HEADING("SectionHeading") },
  { tag: "div", className: ERROR_BANNER, to: "Banner", attrs: ' tone="error"', imp: BANNER, dropIcon: "AlertCircle" },
  { tag: "div", className: `m-6 ${ERROR_BANNER}`, to: "Banner", attrs: ' tone="error" className="m-6"', imp: BANNER, dropIcon: "AlertCircle" },
  // The p-3 / rounded-md family used inside Distribution and its Daily Files
  // panels. No icon child to drop; Banner supplies one.
  { tag: "div", className: "rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300", to: "Banner", attrs: ' tone="error"', imp: BANNER },
  { tag: "div", className: "mb-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300", to: "Banner", attrs: ' tone="error" className="mb-3"', imp: BANNER },
  { tag: "div", className: "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200", to: "Banner", attrs: ' tone="warning"', imp: BANNER },
  { tag: "div", className: "mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200", to: "Banner", attrs: ' tone="warning" className="mb-3"', imp: BANNER },
  { tag: "div", className: "rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200", to: "Banner", attrs: ' tone="warning"', imp: BANNER },
  { tag: "div", className: "rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200", to: "Banner", attrs: ' tone="warning"', imp: BANNER },
]

/**
 * Family rules. A banner div whose className carries the tone's colour tokens
 * plus one or two extras (`mt-4`, `whitespace-pre-wrap`, `text-xs`) is still a
 * banner. Match on the colour tokens, drop the tokens Banner supplies, keep the
 * rest as className. Still AST-based, so the closing tag is found, not guessed.
 * A className that is an expression (a conditional tone) is left for a person.
 */
const SUPPLIED = new Set([
  "flex", "items-start", "items-center", "gap-2", "rounded-lg", "rounded-md", "border",
  "px-4", "py-3", "p-3", "p-4", "text-sm", "text-xs",
])
const FAMILIES = [
  { tone: "error", colour: /^(border-rose-500\/(30|40)|bg-rose-500\/(5|10)|text-rose-300)$/, tags: ["div", "p"] },
  { tone: "success", colour: /^(border-emerald-500\/40|bg-emerald-500\/5|text-emerald-(200|300))$/, tags: ["div", "p"] },
  { tone: "warning", colour: /^(border-amber-500\/(30|40)|bg-amber-500\/(5|10)|text-amber-200)$/, tags: ["div", "p"] },
]
const ICONS = new Set(["AlertCircle", "CheckCircle2", "AlertTriangle"])

function familyRule(tag, value) {
  const tokens = value.split(/\s+/).filter(Boolean)
  for (const fam of FAMILIES) {
    if (!fam.tags.includes(tag)) continue
    const colour = tokens.filter((t) => fam.colour.test(t))
    // Needs at least a border colour AND a background tint to count as a banner box.
    if (!colour.some((t) => t.startsWith("border-")) || !colour.some((t) => t.startsWith("bg-"))) continue
    const rest = tokens.filter((t) => !fam.colour.test(t) && !SUPPLIED.has(t))
    const attrs = ` tone="${fam.tone}"` + (rest.length ? ` className="${rest.join(" ")}"` : "")
    return { to: "Banner", attrs, imp: BANNER, dropIcon: ICONS }
  }
  return null
}

const args = process.argv.slice(2)
const dry = args.includes("--dry")
const files = args.filter((a) => a !== "--dry")
if (files.length === 0) {
  console.error("usage: replace-jsx.mjs [--dry] <file> [...]")
  process.exit(2)
}

for (const file of files) rewrite(file)

function rewrite(file) {
  const src = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = [] // { start, end, text }
  const counts = {}
  const imports = new Map() // from -> Set(names)

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const open = node.openingElement
      const tag = open.tagName.getText(sf)
      const attrs = open.attributes.properties
      const cls = attrs.find(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "className" && a.initializer && ts.isStringLiteral(a.initializer)
      )
      if (cls) {
        const value = cls.initializer.text
        const rule = RULES.find((r) => r.tag === tag && r.className === value) ?? familyRule(tag, value)
        const others = attrs.filter((a) => a !== cls)
        if (rule && (rule.extraAttrs || others.length === 0)) {
          const otherText = others.map((a) => " " + a.getText(sf)).join("")
          edits.push({ start: open.getStart(sf), end: open.getEnd(), text: `<${rule.to}${rule.attrs}${otherText}>` })
          const close = node.closingElement
          edits.push({ start: close.getStart(sf), end: close.getEnd(), text: `</${rule.to}>` })
          if (rule.dropIcon) {
            const first = node.children.find((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))
            const iconName = first && ts.isJsxSelfClosingElement(first) ? first.tagName.getText(sf) : null
            const drop = rule.dropIcon instanceof Set ? rule.dropIcon.has(iconName) : iconName === rule.dropIcon
            if (drop) {
              edits.push({ start: first.getStart(sf), end: first.getEnd(), text: "" })
            }
          }
          counts[rule.to] = (counts[rule.to] ?? 0) + 1
          if (!imports.has(rule.imp.from)) imports.set(rule.imp.from, new Set())
          imports.get(rule.imp.from).add(rule.imp.name)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (edits.length === 0) {
    console.log(`${file}: nothing to do`)
    return
  }

  // Imports: merge into an existing import from the same module, else add after
  // the last import declaration.
  const importDecls = sf.statements.filter(ts.isImportDeclaration)
  for (const [from, names] of imports) {
    const existing = importDecls.find((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === from)
    if (existing && existing.importClause?.namedBindings && ts.isNamedImports(existing.importClause.namedBindings)) {
      const have = new Set(existing.importClause.namedBindings.elements.map((e) => e.name.getText(sf)))
      const add = [...names].filter((n) => !have.has(n))
      if (add.length) {
        const nb = existing.importClause.namedBindings
        const lastEl = nb.elements[nb.elements.length - 1]
        edits.push({ start: lastEl.getEnd(), end: lastEl.getEnd(), text: `, ${add.join(", ")}` })
      }
    } else {
      const last = importDecls[importDecls.length - 1]
      const at = last ? last.getEnd() : 0
      edits.push({ start: at, end: at, text: `\nimport { ${[...names].sort().join(", ")} } from "${from}"` })
    }
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)

  const summary = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")
  console.log(`${file}: ${summary}${dry ? "  (dry run)" : ""}`)
  if (!dry) writeFileSync(file, out)
}
