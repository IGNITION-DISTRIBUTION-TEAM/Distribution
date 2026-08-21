"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Download,
  LineChart as LineChartIcon,
  Loader2,
  LogOut,
  ShieldCheck,
} from "lucide-react"
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts"
import {
  DistributedDashboardPanel,
  SalesDashboardPanel,
  DiallerDashboardPanel,
} from "@/components/distribution-dashboard"
import { cn } from "@/lib/utils"


const isoDaysAgo = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * Fetch JSON, but survive a response that is not JSON.
 *
 * A function that dies at the platform level — timeout, memory, cold-start
 * failure — returns an HTML or plain-text error page, and JSON.parse on that
 * produces "Unexpected token 'A'..." which says nothing about what happened.
 * This surfaces the status and a snippet of the real body instead, and returns
 * the parsed payload alongside it so callers can still read `notConfigured`.
 */
async function fetchJson<T>(url: string): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  let res: Response
  try {
    res = await fetch(url, { cache: "no-store" })
  } catch (e) {
    return { ok: false, status: 0, data: null, error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
  const text = await res.text()
  let data: T | null = null
  try {
    data = text ? (JSON.parse(text) as T) : null
  } catch {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 160)
    const hint =
      res.status === 504 || /timeout|timed out/i.test(text)
        ? " The query took too long — narrow the date range or filter to fewer products."
        : ""
    return {
      ok: false,
      status: res.status,
      data: null,
      error: `Server returned ${res.status} (not JSON).${hint}${snippet ? ` Response began: ${snippet}` : ""}`,
    }
  }
  const errFromBody =
    data && typeof data === "object" && "error" in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error)
      : null
  return {
    ok: res.ok,
    status: res.status,
    data,
    error: res.ok ? null : errFromBody ?? `HTTP ${res.status}`,
  }
}

/**
 * States how far the feed reaches, and flags the two ways a recent month goes
 * missing: the source has no sales that late, or those sales exist but have not
 * had a first collection yet so they are outside the FTC/FID base.
 */
function FreshnessNote({
  dataThrough,
  endDate,
}: {
  dataThrough: NonNullable<QualityPayload["dataThrough"]>
  endDate: string
}) {
  const { sales, billing, lastSaleInWindow, lastSaleWithFirstCollection } = dataThrough
  const gap = !!sales && sales < endDate
  const notYetBilled =
    dataThrough.salesInWindow - dataThrough.withFirstCollection

  return (
    <div
      className={cn(
        "mt-4 rounded-lg border p-4 text-xs",
        gap ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <span className={gap ? "text-amber-100" : "text-muted-foreground"}>
          Sales data through{" "}
          <span className="font-mono text-foreground">{sales ?? "unknown"}</span>
        </span>
        <span className="text-muted-foreground">
          Billing through <span className="font-mono text-foreground">{billing ?? "unknown"}</span>
        </span>
        {lastSaleInWindow && (
          <span className="text-muted-foreground">
            Latest sale in this window{" "}
            <span className="font-mono text-foreground">{lastSaleInWindow}</span>
          </span>
        )}
      </div>
      {gap && (
        <p className="mt-2 text-amber-100/80">
          The window runs to {endDate} but the feed stops at {sales}, so there is nothing to show
          after that date — the months are absent from the source, not dropped by the report.
        </p>
      )}
      {notYetBilled > 0 && (
        <p className="mt-2 text-muted-foreground">
          {fmtInt(notYetBilled)} account{notYetBilled === 1 ? "" : "s"} in this window have no first
          collection yet, so they carry no FTC/FID and contribute no cohort row
          {lastSaleWithFirstCollection
            ? `; the newest sale that has billed is ${lastSaleWithFirstCollection}`
            : ""}
          .
        </p>
      )}
    </div>
  )
}

const fmtInt = (n: number) => n.toLocaleString()
const fmtPct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(v * 100 >= 10 ? 1 : 2)}%`

// Sidebar navigation, same shape as the other departments. `view` is the
// in-app report to render; null means the report isn't built yet (shown as
// "soon" and not selectable), which is how the quality reports appear until the
// sales and billing feed lands.
type ReportItem = { label: string; view: ReportView | null }
type ReportView = "quality" | "distributed" | "sales" | "dialler"

const SECTIONS: { title: string; items: ReportItem[] }[] = [
  {
    title: "Customer quality",
    items: [
      // One report covers score mix, FTC/FID and VAS attachment — they share a
      // base (accounts written) and reading them apart invites wrong compares.
      { label: "Quality mix (FTC / FID)", view: "quality" },
    ],
  },
  {
    // Moved out of the Distribution department's Dashboard tab, which no longer
    // exists — reporting belongs in one place.
    title: "Distribution",
    items: [
      { label: "Distributed", view: "distributed" },
      { label: "Sales", view: "sales" },
      { label: "Dialler", view: "dialler" },
    ],
  },
]

export function ReportingDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()
  const [active, setActive] = useState<ReportItem>(SECTIONS[0].items[0])
  // Only two sections here, so both start open rather than collapsed.
  const [openSections, setOpenSections] = useState<Set<string>>(
    new Set(SECTIONS.map((s) => s.title))
  )
  const toggleSection = (title: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <LineChartIcon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Reporting</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent className="gap-0.5">
          {SECTIONS.map((section) => {
            const isOpen = openSections.has(section.title)
            const hasActive = section.items.some((it) => it.label === active.label)
            return (
              <SidebarGroup key={section.title} className="py-0.5">
                <button
                  type="button"
                  onClick={() => toggleSection(section.title)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
                      isOpen ? "rotate-90" : ""
                    }`}
                  />
                  <span className="flex-1 truncate text-left">{section.title}</span>
                  {hasActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                </button>
                {isOpen && (
                  <SidebarGroupContent className="pl-1.5">
                    <SidebarMenu>
                      {section.items.map((item) => {
                        const selectable = item.view !== null
                        return (
                          <SidebarMenuItem key={item.label}>
                            <SidebarMenuButton
                              onClick={() => selectable && setActive(item)}
                              isActive={active.label === item.label}
                              disabled={!selectable}
                              tooltip={
                                selectable ? item.label : `${item.label} (awaiting sales/billing data)`
                              }
                              className={selectable ? "" : "opacity-50"}
                            >
                              <span className="truncate">{item.label}</span>
                              {!selectable && (
                                <span className="ml-auto text-[10px] text-muted-foreground">soon</span>
                              )}
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            )
          })}
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3">
            <div className="px-2 text-sm">
              <p className="font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="w-full justify-start text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <span className="truncate text-sm font-medium text-foreground">{active.label}</span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="w-full px-6 py-8">
            {active.view === "quality" && <QualityMixReport />}
            {active.view === "distributed" && <DistributedDashboardPanel />}
            {active.view === "sales" && <SalesDashboardPanel />}
            {active.view === "dialler" && <DiallerDashboardPanel />}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * Customer quality mix — FTC (first time collection) and FID (first time
 * default) by credit-score band, plus VAS attachment and margin over CAC.
 *
 * Awaiting the sales + billing feed. Until those land this documents the agreed
 * scope and the exact fields required, so the spec lives where the business can
 * see it rather than only in email.
 */
type BandRow = {
  band: string
  bandSort: number
  accounts: number
  base: number
  ftc: number
  fid: number
  pending: number
  ftcRate: number | null
  fidRate: number | null
  vasRate: number | null
  avgPrice: number | null
  mixShare: number | null
  collected: number
  collectedPerAccount: number | null
  paidCollections: number
}
type CohortRow = {
  cohort: string
  band: string
  bandSort: number
  accounts: number
  base: number
  ftc: number
  fid: number
  pending: number
  ftcRate: number | null
  fidRate: number | null
}
type QualityPayload = {
  startDate: string
  endDate: string
  sourceTable?: string
  usingDefaultSource?: boolean
  bandOrder: string[]
  bands: BandRow[]
  cohorts: CohortRow[]
  reasons: { reason: string; accounts: number }[]
  reasonsByMonth: { month: string; reason: string; accounts: number }[]
  productGroups: string[]
  brands: string[]
  brandProducts: { brand: string; product: string }[]
  bandOptions: string[]
  filters?: {
    bands: string[]
    products: string[]
    campaignName: string | null
    brand: string | null
  }
  dataThrough?: {
    sales: string | null
    salesFrom: string | null
    billing: string | null
    lastSaleInWindow: string | null
    lastSaleWithFirstCollection: string | null
    salesInWindow: number
    withFirstCollection: number
  }
  bandMode: "derived" | "scoregroup"
  totals: {
    accounts: number
    base: number
    ftc: number
    fid: number
    pending: number
    ftcRate: number | null
    fidRate: number | null
    vasRate: number | null
    collected: number
    collectedPerAccount: number | null
    bandsCounted: number
    ftcRateOverall: number | null
    fidRateOverall: number | null
  }
}

// Colour ramp low -> high score, so the mix bar reads at a glance.
const BAND_COLOUR: Record<string, string> = {
  "<600": "bg-rose-500",
  "600-649": "bg-orange-500",
  "650-699": "bg-amber-500",
  "700-749": "bg-yellow-500",
  "750-799": "bg-lime-500",
  "800-849": "bg-emerald-500",
  "850-899": "bg-teal-500",
  "900+": "bg-sky-500",
  unknown: "bg-zinc-600",
}

// Ramp used when the labels are not the round bands (e.g. SCOREGROUP's
// "662 to 672"), applied in the order the API returns them — which is score
// order, so low scores still read warm and high scores cool.
const BAND_RAMP = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-yellow-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-indigo-500",
]

const bandColour = (band: string, order: string[]): string => {
  if (BAND_COLOUR[band]) return BAND_COLOUR[band]
  if (band === "unknown" || band === "0") return "bg-zinc-600"
  const i = order.indexOf(band)
  if (i < 0) return "bg-zinc-600"
  // spread the ramp across however many bands there are
  const span = Math.max(1, order.filter((b) => b !== "unknown" && b !== "0").length - 1)
  return BAND_RAMP[Math.round((i / span) * (BAND_RAMP.length - 1))] ?? "bg-zinc-600"
}

const REASON_COLOURS = ["#0284c7", "#ea580c", "#7c3aed", "#059669"]
const TOP_REASONS = 4

const FTC_COLOUR = "#0284c7"
const FID_COLOUR = "#ea580c"

// A band whose matured base is tiny gives a rate that swings on a couple of
// accounts. Mark those points rather than hide them.
const MATURITY_FLOOR = 0.5
const MIN_RELIABLE_BASE = 30

type TrendPoint = {
  band: string
  ftcPct: number | null
  fidPct: number | null
  accounts: number
  base: number
  pending: number
  thin: boolean
}

function FtcFidByBandChart({ points }: { points: TrendPoint[] }) {
  const thinCount = points.filter((p) => p.thin).length
  // Many percentile labels ("662 to 672") crowd the axis, so angle them once
  // there are more than a handful.
  const crowded = points.length > 8

  // Direct-label only the final point of each line, so identity does not rest
  // on colour alone without putting a number on every point.
  // Recharts' renderer types want an element, never null — hence the empty <g/>.
  const endLabel = (colour: string) =>
    function EndLabel(props: { x?: number; y?: number; index?: number; value?: number }) {
      const { x, y, index, value } = props
      if (index !== points.length - 1 || value == null || x == null || y == null) return <g />
      return (
        <text x={x + 8} y={y + 4} fill={colour} fontSize={11} fontWeight={600}>
          {Number(value).toFixed(1)}%
        </text>
      )
    }

  // Hollow dot for a cohort that is not matured enough to trust.
  const dot = (colour: string) =>
    function Dot(props: { cx?: number; cy?: number; index?: number }) {
      const { cx, cy, index } = props
      if (cx == null || cy == null) return <g />
      const thin = index != null && points[index]?.thin
      return (
        <circle
          cx={cx}
          cy={cy}
          r={4}
          fill={thin ? "hsl(var(--card))" : colour}
          stroke={colour}
          strokeWidth={2}
        />
      )
    }

  return (
    <div className="mt-5 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">FTC and FID rate by score band</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Share of each band&apos;s matured accounts whose first collection paid (FTC) or did not
            (FID), lowest score on the left. The two are complementary by definition, so the lines
            mirror each other about 50%.
          </p>
        </div>
      </div>

      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points}
            margin={{ top: 8, right: 48, bottom: crowded ? 48 : 0, left: -12 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="band"
              interval={0}
              angle={crowded ? -35 : 0}
              textAnchor={crowded ? "end" : "middle"}
              height={crowded ? 56 : 30}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            />
            <RTooltip
              cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "0.5rem",
                fontSize: "0.8125rem",
              }}
              labelStyle={{ color: "hsl(var(--foreground))" }}
              formatter={(value: number | string, name: string) => [
                value == null ? "—" : `${Number(value).toFixed(1)}%`,
                name,
              ]}
              // Volume is a different scale, so it belongs in the tooltip rather
              // than as a second axis on the plot.
              labelFormatter={(label: string) => {
                const p = points.find((x) => x.band === label)
                if (!p) return label
                return `${label} — ${p.base.toLocaleString()} of ${p.accounts.toLocaleString()} matured${
                  p.pending > 0 ? `, ${p.pending.toLocaleString()} pending` : ""
                }`
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: "0.75rem", color: "hsl(var(--muted-foreground))" }}
            />
            <Line
              type="monotone"
              dataKey="ftcPct"
              name="FTC %"
              stroke={FTC_COLOUR}
              strokeWidth={2}
              dot={dot(FTC_COLOUR)}
              activeDot={{ r: 6 }}
              connectNulls
              label={endLabel(FTC_COLOUR)}
            />
            <Line
              type="monotone"
              dataKey="fidPct"
              name="FID %"
              stroke={FID_COLOUR}
              strokeWidth={2}
              dot={dot(FID_COLOUR)}
              activeDot={{ r: 6 }}
              connectNulls
              label={endLabel(FID_COLOUR)}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {thinCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Hollow points mark {thinCount} band{thinCount === 1 ? "" : "s"} with too few matured
          accounts to read a rate from — treat those points as indicative only.
        </p>
      )}
    </div>
  )
}

/**
 * Customer quality mix — FTC / FID by credit score band from the billing
 * extract. Bands are derived from the raw score in 50-point buckets to match
 * how the business talks about them.
 */
function QualityMixReport() {
  const [startDate, setStartDate] = useState(isoDaysAgo(180))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [products, setProducts] = useState<string[]>([])
  const [productOpen, setProductOpen] = useState(false)
  const [bandFilter, setBandFilter] = useState<string[]>([])
  const [bandOpen, setBandOpen] = useState(false)
  const [brand, setBrand] = useState("")
  const [data, setData] = useState<QualityPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (products.length > 0) params.set("products", products.join(","))
      if (bandFilter.length > 0) params.set("bands", bandFilter.join(","))
      if (brand) params.set("brand", brand)
      params.set("bandMode", "scoregroup")
      const r = await fetchJson<QualityPayload & { notConfigured?: boolean }>(
        `/api/reporting/quality-mix?${params.toString()}`
      )
      if (!r.ok || !r.data) {
        setNotConfigured(!!r.data?.notConfigured)
        throw new Error(r.error ?? "Request failed")
      }
      setNotConfigured(false)
      setData(r.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, products, brand, bandFilter])

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cohort rows arrive as cohort x band; roll up to a per-month view plus the
  // focus band's share, which is what "is the spread balancing out?" needs.
  const cohortSummary = useMemo(() => {
    if (!data) return []
    const byCohort = new Map<
      string,
      { cohort: string; accounts: number; base: number; ftc: number; pending: number; bands: Map<string, number> }
    >()
    for (const r of data.cohorts) {
      const e =
        byCohort.get(r.cohort) ??
        { cohort: r.cohort, accounts: 0, base: 0, ftc: 0, pending: 0, bands: new Map<string, number>() }
      e.accounts += r.accounts
      e.base += r.base
      e.ftc += r.ftc
      e.pending += r.pending
      e.bands.set(r.band, (e.bands.get(r.band) ?? 0) + r.accounts)
      byCohort.set(r.cohort, e)
    }
    return [...byCohort.values()].sort((a, b) => a.cohort.localeCompare(b.cohort))
  }, [data])

  // Filters are applied only on Run report, so the controls hold a PENDING
  // selection while the charts below still show the previous run. Anything whose
  // label depends on a filter must therefore read the APPLIED filters off the
  // payload, never this pending state — otherwise a heading describes data that
  // is not on screen.
  const appliedBands = data?.filters?.bands ?? []
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")
  const dirty = !!data && (
    startDate !== data.startDate ||
    endDate !== data.endDate ||
    (brand || null) !== (data.filters?.brand ?? null) ||
    !sameSet(products, data.filters?.products ?? []) ||
    !sameSet(bandFilter, appliedBands)
  )

  // Export exactly the rows the average was taken over, so a spreadsheet check
  // reconciles against the same population rather than a hand-copied subset.
  const exportBandsCsv = () => {
    if (!data) return
    const head = [
      "Score band",
      "Mix %",
      "Accounts",
      "Matured base",
      "FTC",
      "FTC %",
      "FID",
      "FID %",
      "VAS %",
      "Avg price",
    ]
    const pct = (v: number | null) => (v === null ? "" : (v * 100).toFixed(2))
    const lines = [
      head.join(","),
      ...data.bands.map((b) =>
        [
          `"${b.band.replace(/"/g, '""')}"`,
          pct(b.mixShare),
          b.accounts,
          b.base,
          b.ftc,
          pct(b.ftcRate),
          b.fid,
          pct(b.fidRate),
          pct(b.vasRate),
          b.avgPrice === null ? "" : b.avgPrice.toFixed(2),
        ].join(",")
      ),
      "",
      `"Average across bands (${data.totals.bandsCounted})",,,,,${pct(
        data.totals.ftcRate
      )},,${pct(data.totals.fidRate)},,`,
      `"All accounts (pooled)",,${data.totals.accounts},${data.totals.base},${
        data.totals.ftc
      },${pct(data.totals.ftcRateOverall)},${data.totals.fid},${pct(
        data.totals.fidRateOverall
      )},,`,
    ]
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `quality-mix-bands-${data.startDate}_to_${data.endDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Blended FTC per sale month, for the over-time chart.
  const ftcTrend = useMemo(
    () =>
      cohortSummary.map((c) => ({
        cohort: c.cohort,
        ftcPct: c.base > 0 ? (c.ftc / c.base) * 100 : null,
        accounts: c.accounts,
        base: c.base,
        pending: c.pending,
        thin: c.accounts > 0 && c.base / c.accounts < MATURITY_FLOOR,
      })),
    [cohortSummary]
  )

  // Chart series: FTC/FID by score band, in the score order the API returns.
  // Rates are over the MATURED base, so a band whose accounts have not billed
  // yet contributes no misleading 0%.
  const trend = useMemo<TrendPoint[]>(
    () =>
      (data?.bands ?? []).map((b) => ({
        band: b.band,
        ftcPct: b.ftcRate == null ? null : b.ftcRate * 100,
        fidPct: b.fidRate == null ? null : b.fidRate * 100,
        accounts: b.accounts,
        base: b.base,
        pending: b.pending,
        thin:
          b.base < MIN_RELIABLE_BASE ||
          (b.accounts > 0 && b.base / b.accounts < MATURITY_FLOOR),
      })),
    [data]
  )

  // Products available for the selected brand. Falls back to every product when
  // no brand is chosen, or when the pairs are missing for some reason.
  const productOptions = useMemo(() => {
    const pairs = data?.brandProducts ?? []
    if (!brand || pairs.length === 0) return data?.productGroups ?? []
    return [...new Set(pairs.filter((p) => p.brand === brand).map((p) => p.product))].sort()
  }, [data, brand])

  // Changing brand can strip chosen products out of the list; drop those so the
  // filters can never describe a combination that returns nothing.
  useEffect(() => {
    if (products.length === 0 || productOptions.length === 0) return
    const kept = products.filter((p) => productOptions.includes(p))
    if (kept.length !== products.length) setProducts(kept)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productOptions])

    // Full band list for the picker, kept even while a band filter is active.
  const bandChoices = useMemo(() => data?.bandOptions ?? [], [data])

  // Rank the lines by period total so the same reasons stay on the chart as the
  // month-by-month ordering wobbles — colour follows the reason, not its rank
  // within a month.
  const topReasons = useMemo(
    () => (data?.reasons ?? []).slice(0, TOP_REASONS).map((r) => r.reason),
    [data]
  )

  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Customer quality mix</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            FTC and FID by credit score band, on sale cohorts. Banded on SCOREGROUP, the
            business&rsquo;s own labels.
          </p>
        </div>
      </div>

      {/* ---- filters ---- */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">Sales from</Label>
            <Input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">Sales to</Label>
            <Input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div className="min-w-[240px]">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Product</Label>
            <Popover open={productOpen} onOpenChange={setProductOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-between font-normal">
                  <span className="truncate">
                    {products.length === 0
                      ? "All products"
                      : products.length === 1
                      ? products[0]
                      : products.length + " products"}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 flex-shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[300px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search products..." />
                  <CommandList>
                    <CommandEmpty>No product found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem onSelect={() => setProducts([])}>
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            products.length === 0 ? "opacity-100" : "opacity-0"
                          )}
                        />
                        All products
                      </CommandItem>
                      {productOptions.map((p) => (
                        <CommandItem
                          key={p}
                          value={p}
                          onSelect={() =>
                            setProducts((prev) =>
                              prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                            )
                          }
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              products.includes(p) ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="truncate">{p}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div className="min-w-[200px]">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Brand</Label>
            <Select value={brand || "__all"} onValueChange={(v) => setBrand(v === "__all" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="All brands" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All brands</SelectItem>
                {(data?.brands ?? []).map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[220px]">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Score band</Label>
            <Popover open={bandOpen} onOpenChange={setBandOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-between font-normal">
                  <span className="truncate">
                    {bandFilter.length === 0
                      ? "All bands"
                      : bandFilter.length === 1
                      ? bandFilter[0]
                      : bandFilter.length + " bands"}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 flex-shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[280px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search bands..." />
                  <CommandList>
                    <CommandEmpty>No band found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem onSelect={() => setBandFilter([])}>
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            bandFilter.length === 0 ? "opacity-100" : "opacity-0"
                          )}
                        />
                        All bands
                      </CommandItem>
                      {bandChoices.map((b) => (
                        <CommandItem
                          key={b}
                          value={b}
                          onSelect={() =>
                            setBandFilter((prev) =>
                              prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]
                            )
                          }
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              bandFilter.includes(b) ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="truncate">{b}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <Button onClick={run} disabled={loading} className={cn(dirty && "ring-2 ring-primary/60")}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run report
          </Button>
        </div>
        {dirty && (
          <p className="mt-3 text-xs text-amber-200">
            Filters changed — the figures below are still from the previous run. Click Run report to
            apply.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {[90, 180, 365].map((d) => (
            <button
              key={d}
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                setStartDate(isoDaysAgo(d))
                setEndDate(isoDaysAgo(0))
              }}
            >
              Last {d === 365 ? "12 months" : `${Math.round(d / 30)} months`}
            </button>
          ))}
          <span className="text-xs text-muted-foreground">
            Banded on SCOREGROUP. Its labels cross round boundaries, so a range like 650&ndash;699 spans
            several rows.
          </span>
        </div>
      </div>

      {data?.dataThrough && (
        <FreshnessNote dataThrough={data.dataThrough} endDate={data.endDate} />
      )}

      {notConfigured && <NotConfiguredPanel />}

      {error && !notConfigured && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Connected, but the chosen window holds no sales. Say so plainly and
          point at the range, rather than rendering empty tiles and charts. */}
      {data && data.totals.accounts === 0 && (
        <div className="mt-4 rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-foreground">
            No sales between {data.startDate} and {data.endDate}.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            The source is connected and readable — this window simply has no sales in it. Widen the
            dates (try Last 12 months) or clear the product filter.
          </p>
          {data.sourceTable && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              reading {data.sourceTable}
            </p>
          )}
        </div>
      )}

      {data && data.totals.accounts > 0 && (
        <>
          {/* ---- headline ---- */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-4">
            <StatTile label="Accounts written" value={fmtInt(data.totals.accounts)} />
            <StatTile
              label="FTC rate"
              value={fmtPct(data.totals.ftcRate)}
              sub={`avg of ${fmtInt(data.totals.bandsCounted)} score bands · ${fmtPct(
                data.totals.ftcRateOverall
              )} across all accounts`}
            />
            <StatTile
              label="FID rate"
              value={fmtPct(data.totals.fidRate)}
              sub={`avg of ${fmtInt(data.totals.bandsCounted)} score bands · ${fmtPct(
                data.totals.fidRateOverall
              )} across all accounts`}
            />
            <StatTile
              label="VAS attachment"
              value={fmtPct(data.totals.vasRate)}
              sub={
                data.totals.pending > 0
                  ? `${fmtInt(data.totals.pending)} accounts not yet billed`
                  : "all accounts billed"
              }
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            The headline is the <span className="text-foreground">average across the score bands</span>,
            each band counting once. The second figure pools every account, so it leans towards the
            bands you wrote most of — the two separate when the mix is uneven, and only the pooled one
            describes what the book actually cost.
          </p>

          {data.totals.pending > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {fmtInt(data.totals.pending)} account
              {data.totals.pending === 1 ? " has" : "s have"} no first collection yet and{" "}
              <span className="text-foreground">are excluded from the FTC/FID rates</span> rather than
              counted as paid — a young cohort must not read as 0% default.
            </p>
          )}

          {/* ---- score mix bar ---- */}
          <div className="mt-5 rounded-xl border border-border bg-card p-5">
            <h3 className="font-medium text-foreground">Score mix of accounts written</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.startDate} to {data.endDate}
            </p>
            <div className="mt-4 flex h-6 w-full overflow-hidden rounded-md">
              {data.bands.map((b) =>
                b.mixShare && b.mixShare > 0 ? (
                  <div
                    key={b.band}
                    className={cn(bandColour(b.band, data.bandOrder), "h-full")}
                    style={{ width: `${b.mixShare * 100}%` }}
                    title={`${b.band}: ${fmtInt(b.accounts)} accounts (${fmtPct(b.mixShare)})`}
                  />
                ) : null
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {data.bands.map((b) => (
                <span key={b.band} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", bandColour(b.band, data.bandOrder))} />
                  {b.band} · {fmtPct(b.mixShare)}
                </span>
              ))}
            </div>
          </div>

          {/* ---- by band ---- */}
          <div className="mt-5 rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h3 className="font-medium text-foreground">FTC / FID by score band</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Base excludes accounts with no first collection yet.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={exportBandsCsv}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Score band</TableHead>
                    <TableHead className="text-right">
                      {appliedBands.length > 0 ? "Mix of selected" : "Mix"}
                    </TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead className="text-right">Matured base</TableHead>
                    <TableHead className="text-right">FTC</TableHead>
                    <TableHead className="text-right">FTC %</TableHead>
                    <TableHead className="text-right">FID</TableHead>
                    <TableHead className="text-right">FID %</TableHead>
                    <TableHead className="text-right">VAS %</TableHead>
                    <TableHead className="text-right">Avg price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.bands.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                        No accounts in this period.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.bands.map((b) => (
                    <TableRow
                      key={b.band}
                      className={undefined}
                    >
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn("h-2 w-2 rounded-full", bandColour(b.band, data.bandOrder))}
                          />
                          <span>
                            {b.band}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtPct(b.mixShare)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.accounts)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.base)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.ftc)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-emerald-300">
                        {fmtPct(b.ftcRate)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.fid)}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-sm",
                          b.fidRate !== null && b.fidRate >= 0.2 ? "text-rose-300" : "text-muted-foreground"
                        )}
                      >
                        {fmtPct(b.fidRate)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {fmtPct(b.vasRate)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {b.avgPrice === null ? "—" : `R${b.avgPrice.toFixed(2)}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  {/* Both headline figures live here too, so the table and the
                      tiles are visibly the same run — copying the column out to
                      a spreadsheet and getting a different mean means a row was
                      missed, not that the report disagrees with itself. */}
                  <TableRow className="border-t-2 border-border">
                    <TableCell className="font-medium text-foreground">
                      Average across bands
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        ({fmtInt(data.totals.bandsCounted)} bands, each counted once)
                      </span>
                    </TableCell>
                    <TableCell colSpan={4} />
                    <TableCell className="text-right font-mono text-sm font-medium text-emerald-300">
                      {fmtPct(data.totals.ftcRate)}
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right font-mono text-sm font-medium text-rose-300">
                      {fmtPct(data.totals.fidRate)}
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">
                      All accounts
                      <span className="ml-1 text-xs text-muted-foreground">
                        (pooled, volume-weighted)
                      </span>
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtInt(data.totals.accounts)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtInt(data.totals.base)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtInt(data.totals.ftc)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtPct(data.totals.ftcRateOverall)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtInt(data.totals.fid)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {fmtPct(data.totals.fidRateOverall)}
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </div>

          {trend.length > 1 && <FtcFidByBandChart points={trend} />}

          <FtcOverTimeChart points={ftcTrend} />

          {/* ---- cohort trend + reasons ---- */}
          <div className="mt-5 grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            <div className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-5 py-4">
                <h3 className="font-medium text-foreground">By sale cohort</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Mix and first-collection outcome per sale month.
                </p>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cohort</TableHead>
                      <TableHead className="min-w-[120px]">Mix</TableHead>
                      <TableHead className="text-right">Accounts</TableHead>
                      <TableHead className="text-right">FTC %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cohortSummary.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-sm text-muted-foreground"
                        >
                          No cohorts in this period.
                        </TableCell>
                      </TableRow>
                    )}
                    {cohortSummary.map((c) => {
                      return (
                        <TableRow key={c.cohort}>
                          <TableCell className="font-mono text-xs">{c.cohort}</TableCell>
                          <TableCell>
                            <div className="flex h-2.5 w-full overflow-hidden rounded-full">
                              {data.bandOrder.map((band) => {
                                const n = c.bands.get(band) ?? 0
                                if (n === 0) return null
                                return (
                                  <div
                                    key={band}
                                    className={cn(bandColour(band, data.bandOrder), "h-full")}
                                    style={{ width: `${(n / c.accounts) * 100}%` }}
                                    title={`${band}: ${n}`}
                                  />
                                )
                              })}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {fmtInt(c.accounts)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-emerald-300">
                            {fmtPct(c.base > 0 ? c.ftc / c.base : null)}
                          </TableCell>

                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-5 py-4">
                <h3 className="font-medium text-foreground">Why first collections failed</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Unpaid reason on the first collection.
                </p>
              </div>
              <div className="p-5">
                {data.reasons.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No first-time defaults in this period.</p>
                ) : (
                  <div className="space-y-3">
                    {data.reasons.map((r) => {
                      const share = data.totals.fid > 0 ? r.accounts / data.totals.fid : 0
                      return (
                        <div key={r.reason}>
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="text-foreground">{r.reason}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {fmtInt(r.accounts)} · {fmtPct(share)}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                            <div
                              className="h-full rounded-full bg-rose-500/70"
                              style={{ width: `${share * 100}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            <PriceByBandPanel bands={data.bands} bandOrder={data.bandOrder} />
          </div>

          {data.reasonsByMonth.length > 0 && topReasons.length > 0 && (
            <ReasonTrendChart rows={data.reasonsByMonth} topReasons={topReasons} />
          )}

          <div className="mt-4 space-y-1.5 text-xs text-muted-foreground">
            <p>
              <span className="text-foreground">FTC</span> is a first collection paid in full;{" "}
              <span className="text-foreground">FID</span> is the exact inverse, so on the matured base
              the two sum to 100% and disputes and suspensions count as defaults (their share is in the
              reason breakdown). The first collection is the earliest row flagged ISFIRSTCOLLECTION per
              account.
            </p>
            <p>
              Bands come from the raw score, not SCOREGROUP — the existing SCOREGROUP labels are
              percentile bands that cross the round boundaries the business uses (887 to 907 straddles
              900).
            </p>
            <p>
              Acquisition cost is not in the billing feed, so margin over CAC is not shown yet. Send
              commission and lead cost per sale and it can be added to this table.
            </p>
            {data.sourceTable && (
              <p className="font-mono">
                reading {data.sourceTable}
                {data.usingDefaultSource ? " (default)" : " (QUALITY_MIX_SOURCE_TABLE)"}
              </p>
            )}
          </div>
        </>
      )}
    </>
  )
}
/**
 * Shown when QUALITY_MIX_SOURCE_TABLE is unset. Rather than only naming the
 * variable, it can search Snowflake's column metadata for objects carrying the
 * billing feed's signature columns, so the table name does not have to be
 * hunted for by hand.
 */
function NotConfiguredPanel() {
  const [candidates, setCandidates] = useState<
    { table: string; matched: number; required: number; missing: string[] }[] | null
  >(null)
  const [searchedVia, setSearchedVia] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const discover = async () => {
    setSearching(true)
    setSearchError(null)
    try {
      const r = await fetchJson<{
        candidates?: { table: string; matched: number; required: number; missing: string[] }[]
        searchedVia?: string
      }>("/api/reporting/quality-mix/discover")
      if (!r.ok || !r.data) throw new Error(r.error ?? "Request failed")
      const json = r.data
      setCandidates(json.candidates ?? [])
      setSearchedVia(json.searchedVia ?? null)
      if ((json.candidates ?? []).length === 0) {
        setSearchError("No object in reach carries these columns. Name the table manually.")
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
      setCandidates(null)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1 text-amber-100">
          <p className="font-medium">Billing source not configured.</p>
          <p className="mt-1 text-amber-100/80">
            Set <span className="font-mono">QUALITY_MIX_SOURCE_TABLE</span> to the billing extract in
            Snowflake (<span className="font-mono">DATABASE.SCHEMA.OBJECT</span>) and redeploy. Expected
            columns: ACCOUNTNO, SALESDATE, SCORE, ISFIRSTCOLLECTION, PAID_FLAG,
            UNPAID_GROUP_DESCRIPTION, VAS_BUTTON_FLAG, PRODUCT_GROUPS, PRODUCTPRICE, SCHEDULEDATE,
            BILLINGDATE.
          </p>
          <p className="mt-2 text-xs text-amber-100/70">
            <span className="font-mono">scripts/quality-mix.sql</span> builds a view with exactly these
            columns if you would rather point at a purpose-made object.
          </p>

          <div className="mt-4 flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={discover} disabled={searching}>
              {searching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {searching ? "Searching..." : "Find the table"}
            </Button>
            <span className="text-xs text-amber-100/60">
              Searches column metadata only — reads no data. Super-admin only.
            </span>
          </div>

          {searchError && <p className="mt-3 text-xs text-rose-300">{searchError}</p>}

          {candidates && candidates.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-amber-100/70">
                Candidates{searchedVia ? ` — searched ${searchedVia}` : ""}. Copy the best match into the
                environment variable.
              </p>
              <div className="mt-2 space-y-1.5">
                {candidates.map((c) => (
                  <div
                    key={c.table}
                    className="rounded-md border border-border bg-background/60 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-xs text-foreground">{c.table}</span>
                      <span
                        className={cn(
                          "text-[11px]",
                          c.missing.length === 0 ? "text-emerald-300" : "text-muted-foreground"
                        )}
                      >
                        {c.matched}/{c.required} columns
                        {c.missing.length === 0 ? " · complete" : ""}
                      </span>
                    </div>
                    {c.missing.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        missing: <span className="font-mono">{c.missing.join(", ")}</span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Average pricing by score band, next to what actually collected per successful
 * collection.
 *
 * Price alone answers little — it is usually near-flat across bands, since the
 * product is priced by product, not by credit score. The pair is the useful bit:
 * if nominal price is flat while realised collection falls with score, the
 * cheaper-to-acquire bands are not cheaper to serve, they simply pay less often.
 */
function PriceByBandPanel({
  bands,
  bandOrder,
}: {
  bands: BandRow[]
  bandOrder: string[]
}) {
  const rows = bands.filter((b) => b.avgPrice !== null && b.accounts > 0)
  if (rows.length === 0) return null

  const maxPrice = Math.max(...rows.map((b) => b.avgPrice ?? 0), 1)
  const prices = rows.map((b) => b.avgPrice ?? 0)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  // Flat pricing is the expected case; say so explicitly rather than leaving the
  // reader to eyeball 20 near-identical bars.
  const spreadPct = hi > 0 ? ((hi - lo) / hi) * 100 : 0
  const flat = spreadPct < 10

  const rand = (v: number | null) =>
    v == null ? "—" : `R${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h3 className="font-medium text-foreground">Average price by score band</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {flat ? (
            <>
              Priced within {spreadPct.toFixed(0)}% across every band — price does not follow score,
              so differences in value come from how often it collects, not what it costs.
            </>
          ) : (
            <>
              Price ranges {rand(lo)} to {rand(hi)} across bands — a {spreadPct.toFixed(0)}% spread,
              so pricing does vary with score.
            </>
          )}
        </p>
      </div>
      <div className="max-h-[420px] overflow-y-auto p-5">
        <div className="space-y-2.5">
          {rows.map((b) => {
            const realised = b.paidCollections > 0 ? b.collected / b.paidCollections : null
            return (
              <div key={b.band}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "h-2 w-2 flex-shrink-0 rounded-full",
                        bandColour(b.band, bandOrder)
                      )}
                    />
                    <span className="truncate text-foreground">{b.band}</span>
                  </span>
                  <span className="flex-shrink-0 font-mono text-muted-foreground">
                    <span className="text-foreground">{rand(b.avgPrice)}</span>
                    {realised !== null && <> · {rand(realised)} collected</>}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("h-full rounded-full", bandColour(b.band, bandOrder))}
                    style={{ width: `${((b.avgPrice ?? 0) / maxPrice) * 100}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        Price is the product&apos;s nominal amount; collected is the average of what a successful
        collection actually took, ex VAT. The two differ through pro-rata, plan changes and
        discounts.
      </div>
    </div>
  )
}

/**
 * Blended FTC rate by sale month — the trend the band curve cannot show.
 *
 * One series, so no legend: the title names it. FID is omitted deliberately;
 * being the exact inverse it would be a mirror line carrying no extra
 * information. Volume is a different scale and stays in the tooltip rather than
 * becoming a second axis.
 *
 * The rate is over each cohort's MATURED base, and cohorts that are mostly not
 * yet billed get a hollow point — the newest month always rests on few accounts
 * and moves as the rest fall due.
 */
function FtcOverTimeChart({
  points,
}: {
  points: {
    cohort: string
    ftcPct: number | null
    accounts: number
    base: number
    pending: number
    thin: boolean
  }[]
}) {
  const withRate = points.filter((p) => p.ftcPct != null)
  if (withRate.length < 2) return null

  const first = withRate[0]
  const last = withRate[withRate.length - 1]
  const delta =
    first.ftcPct != null && last.ftcPct != null ? last.ftcPct - first.ftcPct : null
  const thinCount = points.filter((p) => p.thin).length

  const dot = (props: { cx?: number; cy?: number; index?: number }) => {
    const { cx, cy, index } = props
    if (cx == null || cy == null) return <g />
    const thin = index != null && points[index]?.thin
    return (
      <circle
        cx={cx}
        cy={cy}
        r={4}
        fill={thin ? "hsl(var(--card))" : FTC_COLOUR}
        stroke={FTC_COLOUR}
        strokeWidth={2}
      />
    )
  }

  return (
    <div className="mt-5 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">FTC rate over time</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Blended first-time collection rate per sale month, across every band in the current
            filter. Because it is blended, it moves with the score mix as well as with performance.
          </p>
        </div>
        {delta != null && (
          <p className="text-xs text-muted-foreground">
            {first.cohort} → {last.cohort}{" "}
            <span
              className={cn(
                "font-mono",
                delta > 0.5 ? "text-emerald-300" : delta < -0.5 ? "text-rose-300" : "text-foreground"
              )}
            >
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)} pts
            </span>
          </p>
        )}
      </div>

      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 40, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="cohort"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              minTickGap={16}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            />
            <RTooltip
              cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "0.5rem",
                fontSize: "0.8125rem",
              }}
              labelStyle={{ color: "hsl(var(--foreground))" }}
              formatter={(value: number | string) => [
                value == null ? "—" : `${Number(value).toFixed(1)}%`,
                "FTC %",
              ]}
              labelFormatter={(label: string) => {
                const p = points.find((x) => x.cohort === label)
                if (!p) return label
                return `${label} — ${p.base.toLocaleString()} of ${p.accounts.toLocaleString()} matured${
                  p.pending > 0 ? `, ${p.pending.toLocaleString()} pending` : ""
                }`
              }}
            />
            <Line
              type="monotone"
              dataKey="ftcPct"
              name="FTC %"
              stroke={FTC_COLOUR}
              strokeWidth={2}
              dot={dot}
              activeDot={{ r: 6 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {thinCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Hollow points mark {thinCount} cohort{thinCount === 1 ? "" : "s"} under{" "}
          {Math.round(MATURITY_FLOOR * 100)}% matured — those rates will move as the rest bill.
        </p>
      )}
    </div>
  )
}

/**
 * Failure-reason mix by sale month. Only the largest few reasons are plotted as
 * lines — the tail is long and thin, and an eleven-series chart would need hues
 * that cannot pass a colour-blindness check. Each line is a reason's share of
 * that month's first-time defaults, so a shift in composition is visible even
 * when the total moves.
 */
function ReasonTrendChart({
  rows,
  topReasons,
}: {
  rows: { month: string; reason: string; accounts: number }[]
  topReasons: string[]
}) {
  const { points, months } = useMemo(() => {
    const byMonth = new Map<string, { total: number; byReason: Map<string, number> }>()
    for (const r of rows) {
      const e = byMonth.get(r.month) ?? { total: 0, byReason: new Map<string, number>() }
      e.total += r.accounts
      e.byReason.set(r.reason, (e.byReason.get(r.reason) ?? 0) + r.accounts)
      byMonth.set(r.month, e)
    }
    const months = [...byMonth.keys()].sort()
    const points = months.map((m) => {
      const e = byMonth.get(m)!
      const row: Record<string, string | number | null> = { month: m, total: e.total }
      for (const reason of topReasons) {
        const n = e.byReason.get(reason) ?? 0
        row[reason] = e.total > 0 ? (n / e.total) * 100 : null
        row[`${reason}__n`] = n
      }
      return row
    })
    return { points, months }
  }, [rows, topReasons])

  if (months.length < 2) return null

  return (
    <div className="mt-5 rounded-xl border border-border bg-card p-5">
      <h3 className="font-medium text-foreground">Failure reasons by month</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Each reason as a share of that month&apos;s first-time defaults, by sale month. Top{" "}
        {topReasons.length} reasons shown; hover for counts.
      </p>
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="month"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              minTickGap={16}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            />
            <RTooltip
              cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "0.5rem",
                fontSize: "0.8125rem",
              }}
              labelStyle={{ color: "hsl(var(--foreground))" }}
              formatter={(value: number | string, name: string, item: { payload?: Record<string, unknown> }) => {
                const n = item?.payload?.[`${name}__n`]
                const pct = value == null ? "—" : `${Number(value).toFixed(1)}%`
                return [n == null ? pct : `${pct} (${Number(n).toLocaleString()})`, name]
              }}
              labelFormatter={(label: string) => {
                const p = points.find((x) => x.month === label)
                return p ? `${label} — ${Number(p.total).toLocaleString()} defaults` : label
              }}
            />
            <Legend wrapperStyle={{ fontSize: "0.75rem", color: "hsl(var(--muted-foreground))" }} />
            {topReasons.map((reason, i) => (
              <Line
                key={reason}
                type="monotone"
                dataKey={reason}
                name={reason}
                stroke={REASON_COLOURS[i % REASON_COLOURS.length]}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

