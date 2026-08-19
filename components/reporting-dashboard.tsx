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
import { toast } from "sonner"
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Download,
  LineChart as LineChartIcon,
  Loader2,
  LogOut,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"

type Campaign = { id: string; title: string }

type Row = {
  campaignId: string
  title: string
  leadsLoaded: number
  leadsDialled: number
  sales: number
  dialledRate: number | null
  conversionRate: number | null
  salesPerDialled: number | null
  noDiallerMatch: boolean
  noSalesMatch: boolean
}

type Totals = {
  leadsLoaded: number
  leadsDialled: number
  sales: number
  dialledRate: number | null
  conversionRate: number | null
  salesPerDialled: number | null
}

type Payload = {
  startDate: string
  endDate: string
  rows: Row[]
  totals: Totals
  unmatched: { dialler: number; sales: number }
}

type SortKey = keyof Pick<
  Row,
  "title" | "leadsLoaded" | "leadsDialled" | "sales" | "dialledRate" | "conversionRate" | "salesPerDialled"
>

const isoDaysAgo = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

const fmtInt = (n: number) => n.toLocaleString()
const fmtPct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(v * 100 >= 10 ? 1 : 2)}%`

// Sidebar navigation, same shape as the other departments. `view` is the
// in-app report to render; null means the report isn't built yet (shown as
// "soon" and not selectable), which is how the quality reports appear until the
// sales and billing feed lands.
type ReportItem = { label: string; view: ReportView | null }
type ReportView = "quality" | "campaign"

const SECTIONS: { title: string; items: ReportItem[] }[] = [
  {
    title: "Customer quality",
    items: [
      // One report covers score mix, FTC/FID and VAS attachment — they share a
      // base (accounts written) and reading them apart invites wrong compares.
      { label: "Quality mix (FTC / FID)", view: "quality" },
      // Needs commission and lead cost per sale, which the billing feed has not
      // got, so it stays unselectable rather than showing a half-answer.
      { label: "Margin over acquisition cost", view: null },
    ],
  },
  {
    title: "Campaigns",
    items: [{ label: "Campaign performance", view: "campaign" }],
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
          <div className="mx-auto w-full max-w-7xl px-6 py-8">
            {active.view === "quality" && <QualityMixReport />}
            {active.view === "campaign" && <CampaignPerformanceReport />}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function CampaignPerformanceReport() {
  const [startDate, setStartDate] = useState(isoDaysAgo(30))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selected, setSelected] = useState<string[]>([]) // empty = all active
  const [pickerOpen, setPickerOpen] = useState(false)

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sortKey, setSortKey] = useState<SortKey>("leadsLoaded")
  const [sortDesc, setSortDesc] = useState(true)
  const [hideEmpty, setHideEmpty] = useState(true)

  // Campaign list for the filter — same source the other dashboards use.
  useEffect(() => {
    let cancelled = false
    fetch("/api/campaigns", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { campaigns: [] }))
      .then((d) => {
        if (!cancelled) setCampaigns((d.campaigns ?? []) as Campaign[])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const run = useCallback(async () => {
    if (startDate > endDate) {
      toast.error("Start date must be on or before end date")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (selected.length > 0) params.set("campaignIds", selected.join(","))
      const res = await fetch(`/api/reporting/campaign-performance?${params.toString()}`, {
        cache: "no-store",
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json as Payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, selected])

  // Load once on mount with the default 30-day window.
  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visibleRows = useMemo(() => {
    if (!data) return []
    const rows = hideEmpty
      ? data.rows.filter((r) => r.leadsLoaded > 0 || r.leadsDialled > 0 || r.sales > 0)
      : data.rows
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv))
      }
      // Nulls (undefined rates) always sort last regardless of direction.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return av - bv
    })
    return sortDesc && sortKey !== "title" ? sorted.reverse() : sorted
  }, [data, sortKey, sortDesc, hideEmpty])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d)
    } else {
      setSortKey(key)
      setSortDesc(key !== "title")
    }
  }

  const exportCsv = () => {
    if (!data || visibleRows.length === 0) return
    const head = [
      "Campaign ID",
      "Campaign",
      "Leads loaded",
      "Leads dialled",
      "Sales",
      "Dialled rate",
      "Conversion rate",
      "Sales per dialled",
    ]
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = [
      head.join(","),
      ...visibleRows.map((r) =>
        [
          r.campaignId,
          esc(r.title),
          r.leadsLoaded,
          r.leadsDialled,
          r.sales,
          r.dialledRate === null ? "" : (r.dialledRate * 100).toFixed(4),
          r.conversionRate === null ? "" : (r.conversionRate * 100).toFixed(4),
          r.salesPerDialled === null ? "" : (r.salesPerDialled * 100).toFixed(4),
        ].join(",")
      ),
    ]
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `campaign-performance-${data.startDate}_to_${data.endDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectedLabel =
    selected.length === 0
      ? "All active campaigns"
      : selected.length === 1
      ? campaigns.find((c) => c.id === selected[0])?.title ?? "1 campaign"
      : `${selected.length} campaigns`

  const maxLoaded = Math.max(1, ...visibleRows.map((r) => r.leadsLoaded))

  return (
    <>
        <div className="mb-6 flex items-start gap-3">
          <LineChartIcon className="mt-1 h-6 w-6 text-muted-foreground" />
          <div>
            <h2 className="text-xl font-semibold text-foreground">Campaign performance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Leads loaded → dialled → sales for each campaign over the selected period.
            </p>
          </div>
        </div>

        {/* ---- filters ---- */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-[150px]"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-[150px]"
              />
            </div>

            <div className="min-w-[240px] flex-1">
              <Label className="mb-1.5 block text-xs text-muted-foreground">Campaigns</Label>
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between font-normal">
                    <span className="truncate">{selectedLabel}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 flex-shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[340px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search campaigns..." />
                    <CommandList>
                      <CommandEmpty>No campaign found.</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          onSelect={() => {
                            setSelected([])
                            setPickerOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selected.length === 0 ? "opacity-100" : "opacity-0"
                            )}
                          />
                          All active campaigns
                        </CommandItem>
                        {campaigns.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={`${c.title} ${c.id}`}
                            onSelect={() =>
                              setSelected((prev) =>
                                prev.includes(c.id)
                                  ? prev.filter((id) => id !== c.id)
                                  : [...prev, c.id]
                              )
                            }
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selected.includes(c.id) ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <span className="truncate">{c.title}</span>
                            <span className="ml-auto pl-2 font-mono text-xs text-muted-foreground">
                              {c.id}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <Button onClick={run} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run report
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideEmpty}
                onChange={(e) => setHideEmpty(e.target.checked)}
                className="h-3.5 w-3.5 accent-foreground"
              />
              Hide campaigns with no activity in this period
            </label>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  setStartDate(isoDaysAgo(d))
                  setEndDate(isoDaysAgo(0))
                }}
              >
                Last {d} days
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ---- totals ---- */}
        {data && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile label="Leads loaded" value={fmtInt(data.totals.leadsLoaded)} />
            <StatTile
              label="Leads dialled"
              value={fmtInt(data.totals.leadsDialled)}
              sub={`${fmtPct(data.totals.dialledRate)} of loaded`}
            />
            <StatTile
              label="Sales"
              value={fmtInt(data.totals.sales)}
              sub={`${fmtPct(data.totals.conversionRate)} of loaded · ${fmtPct(
                data.totals.salesPerDialled
              )} of dialled`}
            />
          </div>
        )}

        {/* ---- table ---- */}
        {data && (
          <div className="mt-5 rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h3 className="font-medium text-foreground">
                  By campaign{" "}
                  <span className="text-sm text-muted-foreground">
                    ({visibleRows.length} shown)
                  </span>
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.startDate} to {data.endDate}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={exportCsv}
                disabled={visibleRows.length === 0}
              >
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Campaign" k="title" {...{ sortKey, sortDesc, toggleSort }} />
                    <SortHead
                      label="Leads loaded"
                      k="leadsLoaded"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                    <SortHead
                      label="Dialled"
                      k="leadsDialled"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                    <SortHead
                      label="Dialled %"
                      k="dialledRate"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                    <SortHead
                      label="Sales"
                      k="sales"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                    <SortHead
                      label="Conv. %"
                      k="conversionRate"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                    <SortHead
                      label="Sales/dialled"
                      k="salesPerDialled"
                      align="right"
                      {...{ sortKey, sortDesc, toggleSort }}
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                        Loading...
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading && visibleRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                        No campaign activity in this period.
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading &&
                    visibleRows.map((r) => (
                      <TableRow key={r.campaignId}>
                        <TableCell className="max-w-[280px]">
                          <div className="truncate text-foreground" title={r.title}>
                            {r.title}
                          </div>
                          {/* Inline bar gives a quick read of relative volume. */}
                          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
                            <div
                              className="h-full rounded-full bg-emerald-500/60"
                              style={{ width: `${(r.leadsLoaded / maxLoaded) * 100}%` }}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {fmtInt(r.leadsLoaded)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.noDiallerMatch ? (
                            <span
                              className="text-muted-foreground"
                              title="No dialler rows matched this campaign name in this period"
                            >
                              —
                            </span>
                          ) : (
                            fmtInt(r.leadsDialled)
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-muted-foreground">
                          {fmtPct(r.dialledRate)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.noSalesMatch ? (
                            <span
                              className="text-muted-foreground"
                              title="No sales rows matched this campaign name in this period"
                            >
                              —
                            </span>
                          ) : (
                            fmtInt(r.sales)
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono text-sm",
                            r.conversionRate !== null && r.conversionRate > 0
                              ? "text-emerald-300"
                              : "text-muted-foreground"
                          )}
                        >
                          {fmtPct(r.conversionRate)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-muted-foreground">
                          {fmtPct(r.salesPerDialled)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>

            {(data.unmatched.dialler > 0 || data.unmatched.sales > 0) && (
              <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                A dash means no rows matched that campaign&apos;s name in the source for this period —
                either genuinely no activity, or the campaign name differs between the campaign list
                and the dialler/sales views.{" "}
                {data.unmatched.dialler} of {data.rows.length} campaigns had no dialler match,{" "}
                {data.unmatched.sales} had no sales match.
              </div>
            )}
          </div>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Leads loaded counts rows in the history-leads-loaded table by campaign id. Dialled and sales
          come from the dialler and on-air sales views, matched to campaigns by name — the same
          convention the Distribution dashboards use.
        </p>
    </>
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
}
type CohortRow = {
  cohort: string
  band: string
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
  bandOrder: string[]
  bands: BandRow[]
  cohorts: CohortRow[]
  reasons: { reason: string; accounts: number }[]
  productGroups: string[]
  totals: {
    accounts: number
    base: number
    ftc: number
    fid: number
    pending: number
    ftcRate: number | null
    fidRate: number | null
    vasRate: number | null
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

// The band the business is currently asking about — highlighted so it is
// findable without hunting down the table.
const FOCUS_BAND = "650-699"

/**
 * Customer quality mix — FTC / FID by credit score band from the billing
 * extract. Bands are derived from the raw score in 50-point buckets to match
 * how the business talks about them.
 */
function QualityMixReport() {
  const [startDate, setStartDate] = useState(isoDaysAgo(180))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [productGroup, setProductGroup] = useState("")
  const [data, setData] = useState<QualityPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (productGroup) params.set("productGroup", productGroup)
      const res = await fetch(`/api/reporting/quality-mix?${params.toString()}`, {
        cache: "no-store",
      })
      const json = await res.json()
      if (!res.ok) {
        setNotConfigured(!!json.notConfigured)
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setNotConfigured(false)
      setData(json as QualityPayload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, productGroup])

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

  const focus = data?.bands.find((b) => b.band === FOCUS_BAND)

  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Customer quality mix</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            FTC and FID by credit score band, on sale cohorts. Bands are derived from the raw score in
            50-point buckets.
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
          <div className="min-w-[220px]">
            <Label className="mb-1.5 block text-xs text-muted-foreground">Product</Label>
            <Select value={productGroup || "__all"} onValueChange={(v) => setProductGroup(v === "__all" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="All products" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All products</SelectItem>
                {(data?.productGroups ?? []).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={run} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run report
          </Button>
        </div>
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
        </div>
      </div>

      {notConfigured && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
            <div className="text-amber-100">
              <p className="font-medium">Billing source not configured.</p>
              <p className="mt-1 text-amber-100/80">
                Set <span className="font-mono">QUALITY_MIX_SOURCE_TABLE</span> to the billing extract in
                Snowflake (<span className="font-mono">DATABASE.SCHEMA.OBJECT</span>) and redeploy. The
                report expects the columns from the billing feed: ACCOUNTNO, SALESDATE, SCORE,
                ISFIRSTCOLLECTION, PAID_FLAG, UNPAID_GROUP_DESCRIPTION, VAS_BUTTON_FLAG,
                PRODUCT_GROUPS, PRODUCTPRICE, SCHEDULEDATE, BILLINGDATE.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && !notConfigured && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {data && (
        <>
          {/* ---- headline ---- */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Accounts written" value={fmtInt(data.totals.accounts)} />
            <StatTile
              label="FTC rate"
              value={fmtPct(data.totals.ftcRate)}
              sub={`${fmtInt(data.totals.ftc)} of ${fmtInt(data.totals.base)} matured`}
            />
            <StatTile
              label="FID rate"
              value={fmtPct(data.totals.fidRate)}
              sub={`${fmtInt(data.totals.fid)} first-time defaults`}
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
              {focus?.mixShare != null && (
                <>
                  {" · "}
                  <span className="text-amber-200">
                    {FOCUS_BAND} is {fmtPct(focus.mixShare)} of the mix
                  </span>
                </>
              )}
            </p>
            <div className="mt-4 flex h-6 w-full overflow-hidden rounded-md">
              {data.bands.map((b) =>
                b.mixShare && b.mixShare > 0 ? (
                  <div
                    key={b.band}
                    className={cn(BAND_COLOUR[b.band] ?? "bg-zinc-600", "h-full")}
                    style={{ width: `${b.mixShare * 100}%` }}
                    title={`${b.band}: ${fmtInt(b.accounts)} accounts (${fmtPct(b.mixShare)})`}
                  />
                ) : null
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {data.bands.map((b) => (
                <span key={b.band} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", BAND_COLOUR[b.band] ?? "bg-zinc-600")} />
                  {b.band} · {fmtPct(b.mixShare)}
                </span>
              ))}
            </div>
          </div>

          {/* ---- by band ---- */}
          <div className="mt-5 rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h3 className="font-medium text-foreground">FTC / FID by score band</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Base excludes accounts with no first collection yet.
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Score band</TableHead>
                    <TableHead className="text-right">Mix</TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead className="text-right">Matured base</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
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
                      <TableCell colSpan={11} className="text-center text-sm text-muted-foreground">
                        No accounts in this period.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.bands.map((b) => (
                    <TableRow
                      key={b.band}
                      className={b.band === FOCUS_BAND ? "bg-amber-500/5" : undefined}
                    >
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn("h-2 w-2 rounded-full", BAND_COLOUR[b.band] ?? "bg-zinc-600")}
                          />
                          <span className={b.band === FOCUS_BAND ? "font-medium text-foreground" : ""}>
                            {b.band}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtPct(b.mixShare)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.accounts)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtInt(b.base)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {b.pending > 0 ? fmtInt(b.pending) : "—"}
                      </TableCell>
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
              </Table>
            </div>
          </div>

          {/* ---- cohort trend + reasons ---- */}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
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
                      <TableHead className="text-right">{FOCUS_BAND}</TableHead>
                      <TableHead className="text-right">Accounts</TableHead>
                      <TableHead className="text-right">FTC %</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cohortSummary.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                          No cohorts in this period.
                        </TableCell>
                      </TableRow>
                    )}
                    {cohortSummary.map((c) => {
                      const focusN = c.bands.get(FOCUS_BAND) ?? 0
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
                                    className={cn(BAND_COLOUR[band] ?? "bg-zinc-600", "h-full")}
                                    style={{ width: `${(n / c.accounts) * 100}%` }}
                                    title={`${band}: ${n}`}
                                  />
                                )
                              })}
                            </div>
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono text-sm",
                              focusN / c.accounts >= 0.4 ? "text-amber-200" : "text-muted-foreground"
                            )}
                          >
                            {fmtPct(c.accounts > 0 ? focusN / c.accounts : null)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {fmtInt(c.accounts)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-emerald-300">
                            {fmtPct(c.base > 0 ? c.ftc / c.base : null)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-muted-foreground">
                            {c.pending > 0 ? fmtInt(c.pending) : "—"}
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
          </div>

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
          </div>
        </>
      )}
    </>
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

function SortHead({
  label,
  k,
  align,
  sortKey,
  sortDesc,
  toggleSort,
}: {
  label: string
  k: SortKey
  align?: "right"
  sortKey: SortKey
  sortDesc: boolean
  toggleSort: (k: SortKey) => void
}) {
  const active = sortKey === k
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <ArrowUpDown className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")} />
        {active && <span className="sr-only">{sortDesc ? "descending" : "ascending"}</span>}
      </button>
    </TableHead>
  )
}
