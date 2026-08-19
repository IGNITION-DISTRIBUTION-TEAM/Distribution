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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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

export function ReportingDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Departments
            </Button>
          )}
          <span className="text-sm font-medium text-muted-foreground">Reporting Department</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs">
            <p className="font-medium text-foreground">{user?.name}</p>
            <p className="text-muted-foreground">{user?.email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-8">
        <Tabs defaultValue="quality" className="w-full">
          <TabsList>
            <TabsTrigger value="quality">Customer quality mix</TabsTrigger>
            <TabsTrigger value="campaign">Campaign performance</TabsTrigger>
          </TabsList>

          <TabsContent value="quality" className="mt-5">
            <QualityMixReport />
          </TabsContent>

          <TabsContent value="campaign" className="mt-5">
            <CampaignPerformanceReport />
          </TabsContent>
        </Tabs>
      </main>
    </div>
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
function QualityMixReport() {
  return (
    <>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h2 className="text-xl font-semibold text-foreground">Customer quality mix</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sales mix by credit score band, with FTC and FID by sale cohort — does the score mix we
            are writing hold up once it bills?
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
          <div className="text-sm text-amber-100">
            <p className="font-medium">Waiting on the sales and billing feed.</p>
            <p className="mt-1 text-amber-100/80">
              The fields needed are listed below. Once the two datasets are available in Snowflake
              this tab renders the report — nothing else is blocking it.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="font-medium text-foreground">What it will show</h3>
          <ul className="mt-3 space-y-2.5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">Score mix over time</span> — share of sales by credit
              score band per day and week, so a shift like 650–699 reaching ~50% of a day is visible
              against its own trend rather than as a one-day surprise.
            </li>
            <li>
              <span className="text-foreground">FTC rate by score band</span> — of the sales in a
              cohort whose first collection has fallen due, how many collected first time.
            </li>
            <li>
              <span className="text-foreground">FID rate by score band</span> — the same cohort base,
              how many defaulted on that first collection.
            </li>
            <li>
              <span className="text-foreground">Cohort maturity</span> — cohorts too young to have a
              first billing date are shown as pending, never as 0% default. This is the difference
              between a report that reassures and one that misleads.
            </li>
            <li>
              <span className="text-foreground">VAS attachment rate</span> — by score band and price
              point, to track the ~60% → ~55% move after the price increase.
            </li>
            <li>
              <span className="text-foreground">Margin over acquisition cost</span> — expected
              revenue net of CAC per score band, so the mix decision is made on profitability and not
              on default rate alone.
            </li>
            <li>
              <span className="text-foreground">6-month rolling score view</span> — FTC/FID and margin
              by score band for the current product over a rolling 6 months, to indicate which bands
              are worth selling into.
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="font-medium text-foreground">Fields required</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            One row per sale, and one row per collection attempt, joined on a common account key.
          </p>

          <p className="mt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Sales — one row per sale
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            <li>Account / sale ID (join key)</li>
            <li>Sale date (and time if available)</li>
            <li>Credit score at time of sale — the raw value, not only the band</li>
            <li>Product / package and price point (monthly recurring amount)</li>
            <li>VAS attached (yes/no), VAS product, VAS amount</li>
            <li>Campaign ID or name, and channel</li>
            <li>Debit order / billing day, and payment method</li>
            <li>Sale status and cancellation date, if cancelled</li>
            <li>Acquisition cost — commission plus lead/media cost</li>
          </ul>

          <p className="mt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Billing — one row per collection attempt
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            <li>Account / sale ID (same key as above)</li>
            <li>Instalment or attempt sequence number — needed to identify the first</li>
            <li>Collection due date and action date</li>
            <li>Amount due and amount actually collected</li>
            <li>Outcome status and reason code (e.g. insufficient funds, disputed)</li>
            <li>Retry indicator, and reversal date/flag if reversed later</li>
          </ul>

          <p className="mt-4 text-xs text-muted-foreground">
            Six months of sales plus their billing outcomes covers the rolling view. No customer
            names, ID numbers or contact details are needed — a hashed account key is enough.
          </p>
        </div>
      </div>
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
