"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  Coins,
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
type ReportView = "quality" | "margin" | "campaign" | "distributed" | "sales" | "dialler"

const SECTIONS: { title: string; items: ReportItem[] }[] = [
  {
    title: "Customer quality",
    items: [
      // One report covers score mix, FTC/FID and VAS attachment — they share a
      // base (accounts written) and reading them apart invites wrong compares.
      { label: "Quality mix (FTC / FID)", view: "quality" },
      // Revenue side is real; acquisition cost is not in the feed, so the report
      // completes margin against an explicit, user-entered assumption.
      { label: "Revenue & margin", view: "margin" },
    ],
  },
  {
    title: "Campaigns",
    items: [{ label: "Campaign performance", view: "campaign" }],
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
            {active.view === "margin" && <MarginReport />}
            {active.view === "campaign" && <CampaignPerformanceReport />}
            {active.view === "distributed" && <DistributedDashboardPanel />}
            {active.view === "sales" && <SalesDashboardPanel />}
            {active.view === "dialler" && <DiallerDashboardPanel />}
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
      const r = await fetchJson<Payload>(
        `/api/reporting/campaign-performance?${params.toString()}`
      )
      if (!r.ok || !r.data) throw new Error(r.error ?? "Request failed")
      setData(r.data)
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

  // Re-run when a dropdown changes, so a heading can never describe stale data.
  // Dates keep the explicit button: a part-typed date would fire a query per
  // keystroke.
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, products, bandFilter])

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
          <span className="text-xs text-muted-foreground">
            Banded on SCOREGROUP. Its labels cross round boundaries, so a range like 650&ndash;699 spans
            several rows.
          </span>
        </div>
      </div>

      {data?.dataThrough && <FreshnessNote dataThrough={data.dataThrough} endDate={endDate} />}

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
                    <TableHead className="text-right">
                      {bandFilter.length > 0 ? "Mix of selected" : "Mix"}
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

/**
 * Revenue per account by score band, and margin once an acquisition cost is
 * supplied.
 *
 * Revenue here is REALISED — what actually collected, ex VAT, across every
 * attempt on the account in the window — not billed and not the nominal product
 * price. Acquisition cost is NOT in the billing feed (no commission, lead or
 * media cost column exists), so margin is computed against a cost the user
 * enters. That is deliberately a modelling assumption and is labelled as one; it
 * is not passed off as measured.
 */
function MarginReport() {
  const [startDate, setStartDate] = useState(isoDaysAgo(180))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [brand, setBrand] = useState("")
  const [cacInput, setCacInput] = useState("")
  // Score order by default: the bands are an ordered scale, and reading the
  // curve matters more than the league table. Ranking stays one click away.
  const [order, setOrder] = useState<"band" | "value">("band")
  const [data, setData] = useState<QualityPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const cac = useMemo(() => {
    const v = Number(cacInput)
    return Number.isFinite(v) && v > 0 ? v : null
  }, [cacInput])

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ startDate, endDate, bandMode: "scoregroup" })
      if (brand) params.set("brand", brand)
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
  }, [startDate, endDate, brand])

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  // Ranked by margin when a cost is given, else by revenue — the question is
  // "which bands are worth selling into", so order by the answer.
  const rows = useMemo(() => {
    const bands = data?.bands ?? []
    const mapped = [...bands]
      .filter((b) => b.accounts > 0)
      .map((b) => ({
        ...b,
        margin: b.collectedPerAccount == null || cac == null ? null : b.collectedPerAccount - cac,
      }))
    if (order === "band") {
      // bandSort is the leading number of the label, so '908+' sorts after
      // '887 to 907' instead of alphabetically before it.
      return mapped.sort((a, b) => a.bandSort - b.bandSort || a.band.localeCompare(b.band))
    }
    return mapped.sort((a, b) =>
      cac == null
        ? (b.collectedPerAccount ?? 0) - (a.collectedPerAccount ?? 0)
        : (b.margin ?? 0) - (a.margin ?? 0)
    )
  }, [data, cac, order])

  const rand = (v: number | null) =>
    v == null ? "—" : `R${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <Coins className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Revenue &amp; margin</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Realised revenue per account by score band. Enter an acquisition cost to see margin and
            rank the bands worth selling into.
          </p>
        </div>
      </div>

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
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">
              Acquisition cost per sale (R)
            </Label>
            <Input
              value={cacInput}
              onChange={(e) => setCacInput(e.target.value)}
              placeholder="e.g. 150"
              inputMode="decimal"
              className="w-[190px] font-mono text-sm"
            />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">Order</Label>
            <div className="flex overflow-hidden rounded-md border border-border">
              {([
                { id: "band", label: "Score band" },
                { id: "value", label: cac == null ? "Revenue" : "Margin" },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setOrder(opt.id)}
                  className={cn(
                    "px-3 py-2 text-xs transition-colors",
                    order === opt.id
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={run} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run report
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Revenue is what actually collected, ex VAT, across every attempt in the window — not billed,
          and not the nominal product price.
        </p>
      </div>

      {data?.dataThrough && <FreshnessNote dataThrough={data.dataThrough} endDate={endDate} />}

      {notConfigured && <NotConfiguredPanel />}

      {error && !notConfigured && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
          <div className="text-amber-100">
            <p className="font-medium">Acquisition cost is not in the billing feed.</p>
            <p className="mt-1 text-amber-100/80">
              No commission, lead or media cost column exists in it, so any margin below is modelled
              against the figure you typed — an <span className="text-amber-50">assumption</span>, not a
              measurement, and flat across every band. Send commission and lead cost per sale and this
              becomes real, per-band and per-product.
            </p>
          </div>
        </div>
      </div>

      {data && data.totals.accounts > 0 && (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Accounts" value={fmtInt(data.totals.accounts)} />
            <StatTile label="Collected (ex VAT)" value={rand(data.totals.collected)} />
            <StatTile
              label="Revenue per account"
              value={rand(data.totals.collectedPerAccount)}
              sub="realised, this window"
            />
            <StatTile
              label="Margin per account"
              value={
                cac == null || data.totals.collectedPerAccount == null
                  ? "—"
                  : rand(data.totals.collectedPerAccount - cac)
              }
              sub={cac == null ? "enter an acquisition cost" : `at R${cac} CAC (assumed)`}
            />
          </div>

          <div className="mt-5 rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h3 className="font-medium text-foreground">
                By score band
                {order === "value" && (
                  <span className="text-muted-foreground">
                    {" "}
                    — ranked by {cac == null ? "revenue" : "margin"} per account
                  </span>
                )}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data.startDate} to {data.endDate}. Bands with more accounts carry more weight in any
                decision; a high per-account figure on a handful of accounts is noise.
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Score band</TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead className="text-right">FTC %</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Revenue / account</TableHead>
                    <TableHead className="text-right">Margin / account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((b) => (
                    <TableRow key={b.band}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span
                            className={cn("h-2 w-2 rounded-full", bandColour(b.band, data.bandOrder))}
                          />
                          {b.band}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {fmtInt(b.accounts)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {fmtPct(b.ftcRate)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {rand(b.collected)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {rand(b.collectedPerAccount)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-sm",
                          b.margin == null
                            ? "text-muted-foreground"
                            : b.margin >= 0
                            ? "text-emerald-300"
                            : "text-rose-300"
                        )}
                      >
                        {rand(b.margin)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Revenue is collected-to-date within the window, so newer sales have had fewer billing
            cycles to accumulate it and will look worse than older ones. Compare bands over the same
            window, and do not read this as lifetime value.
          </p>
        </>
      )}

      {data && data.totals.accounts === 0 && !notConfigured && (
        <div className="mt-4 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No sales between {data.startDate} and {data.endDate}.
        </div>
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
