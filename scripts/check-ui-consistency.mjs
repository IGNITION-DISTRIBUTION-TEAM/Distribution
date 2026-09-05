#!/usr/bin/env node
/**
 * The UI-consistency guard. Runs as part of `npm test`.
 *
 * There are no component tests in this repo and no test runner that can be
 * added without touching the lockfile, so this is the one cheap regression
 * guard available: it greps components/ and app/ for the hand-rolled patterns
 * the redesign retired and fails if any come back. A copy-paste of an old card
 * div or error banner is exactly how the codebase reached 87 cards in 11
 * variants and 41 banners in 3 opacities, and this is what stops the count
 * going back up.
 *
 * Each rule names the primitive to use instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = ["components", "app"]
// The shell and the primitives are allowed to contain what they replace.
const ALLOW = new Set([
  "components/department-shell.tsx",
  "components/ui/card.tsx",
  "components/ui/table.tsx",
  "components/ui/sidebar.tsx",
  "components/kit/banner.tsx",
  "components/kit/heading.tsx",
  "components/kit/stat-tile.tsx",
  "components/kit/chart.tsx",
  "components/kit/skeleton.tsx",
  "components/ui/skeleton.tsx",
  "components/app-loading.tsx",
  "components/kit/page.tsx",
  "lib/motion.ts",
])

/**
 * Is this offset inside a <Button>/<button> that has not closed yet? A
 * heuristic — an unclosed opening tag within the previous 800 characters — so
 * a very long button body could escape it. The failure mode is a false
 * positive at `npm test`, which is visible and cheap to fix.
 */
const inButton = (src, i) =>
  /<[Bb]utton\b(?:(?!<\/[Bb]utton>)[\s\S])*$/.test(src.slice(Math.max(0, i - 800), i))

const RULES = [
  {
    name: "hand-rolled card (use <Card>)",
    re: /className="rounded-xl border border-border bg-card p-(?:5|6)"/g,
  },
  {
    name: "hand-rolled error banner (use <Banner tone=\"error\">)",
    re: /border-rose-500\/(?:40|30) bg-rose-500\/5/g,
  },
  {
    name: "hand-rolled success banner (use <Banner tone=\"success\">)",
    re: /border-emerald-500\/40 bg-emerald-500\/5/g,
  },
  {
    name: "hand-rolled page heading (use <PageHeading>)",
    re: /<h2 className="text-2xl font-semibold text-foreground">/g,
  },
  {
    name: "hand-rolled section heading (use <SectionHeading>)",
    re: /<h3 className="font-medium text-foreground">/g,
  },
  {
    name: "raw <table> with a non-sticky header (use ui/table)",
    re: /<table className="w-full text-sm">\s*<thead>/g,
  },
  {
    name: "a second sidebar shell (use <DepartmentShell>)",
    re: /<SidebarProvider>/g,
  },
  {
    name: "duplicate 'Departments' back button outside the shell",
    re: /<ArrowLeft className="[^"]*" \/>\s*Departments/g,
    // The settings page has no sidebar; its header back button is the only one.
    allowIn: ["components/app-settings.tsx"],
  },
  {
    name: "hover:bg-accent/40 (accent is neutral now; use hover:bg-accent)",
    re: /hover:bg-accent\/40/g,
  },
  {
    name: "private stat tile or spinner copy (use <StatTile> / a kit skeleton)",
    re: /function (?:CompactStat|SyncStat|SummaryCard|StatTile|Spinner)\(/g,
    allowIn: ["components/spot-report-kit.tsx"],
  },
  // ---- loading states: skeletons, not spinners or text ----
  {
    name: "spinner in a table cell (use <SkeletonRows>)",
    re: /<(?:TableCell|td)\b[^>]*colSpan=\{[^}]+\}[^>]*>\s*<Loader2/g,
  },
  {
    name: 'spinner + "Loading…" as a section state (use a kit skeleton)',
    re: /animate-spin[^"]*"\s*\/>\s*Loading\b/g,
    unless: inButton,
  },
  {
    name: 'plain "Loading…" text node (use a kit skeleton)',
    re: />\s*Loading(?:\s[\w\s]+)?(?:\.\.\.|…)\s*</g,
    unless: inButton,
  },
  {
    name: "hand-rolled loading box (use <SkeletonPanel>)",
    re: /bg-card p-1[02] text-muted-foreground">\s*<Loader2/g,
  },
  {
    name: "hand-rolled skeleton (import from @/components/kit/skeleton)",
    re: /className="[^"]*\banimate-pulse\b/g,
  },
  // ---- motion: restrained means restrained ----
  // components/ui/ is vendored shadcn/Radix. It legitimately carries
  // duration-300/500 and zoom-in-95, and normalising it is a separate
  // decision — so the motion rules skip that directory by prefix rather than
  // adding eleven ALLOW entries, which would exempt those files from every
  // other rule too.
  {
    name: "scale on hover/press (motion is colour and opacity only — see lib/motion.ts)",
    re: /\b(?:hover|active|focus|group-hover):scale-/g,
  },
  {
    name: "animation slower than 200ms (the system is 150–200ms; charts are the one exception, in lib/motion.ts)",
    re: /\bduration-(?:2[5-9]\d|[3-9]\d\d|1000|\[)/g,
    skipPrefix: "components/ui/",
  },
  {
    name: "delay-* (no stagger: animate-in has no fill-mode, so a delayed element flashes)",
    re: /\bdelay-\d/g,
    skipPrefix: "components/ui/",
  },
  {
    name: "animate-in with no explicit duration (it silently defaults to 150ms)",
    re: /\banimate-in\b(?![^"'`]*\bduration-)/g,
    skipPrefix: "components/ui/",
  },
  {
    name: "raw isAnimationActive (spread {...chartMotion} from useChartMotion)",
    re: /isAnimationActive=\{/g,
  },
  {
    name: "hand-rolled report page root (use <ReportPage>)",
    re: /className="flex flex-col gap-5 p-6"/g,
  },
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.tsx?$/.test(entry)) yield p
  }
}

let hits = 0
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(".", file)
    if (ALLOW.has(rel)) continue
    const src = readFileSync(file, "utf8")
    for (const rule of RULES) {
      if (rule.allowIn?.includes(rel)) continue
      if (rule.skipPrefix && rel.startsWith(rule.skipPrefix)) continue
      const found = [...src.matchAll(rule.re)].filter((m) => !(rule.unless && rule.unless(src, m.index)))
      if (found.length) {
        hits += found.length
        const line = src.slice(0, found[0].index).split("\n").length
        console.log(`  FAIL ${rel}:${line}  ${found.length}× ${rule.name}`)
      }
    }
  }
}

if (hits) {
  console.log(`\n${hits} retired UI pattern(s) found. Use the shared primitive named above.`)
  process.exit(1)
}
console.log("UI consistency: no retired patterns in components/ or app/.")
