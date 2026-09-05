"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, MONTHS, shortDay, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"

type Kpis = {
  book_size: number; ftc_pct: number | null; month2_pct?: number | null; active_users?: number
  sales_yday: number; sales_mtd: number; sales_l30: number; sales_l7: number
}
type Payload = {
  kpis: Kpis
  monthly: { month: string; sales: number }[]
  daily: { date: string; sales: number }[]
  collected: { month: string; deal: string; billed: number }[]
  deals_yday: { deal: string; sales: number }[] | number
  deals_l30: { deal: string; sales: number }[] | number
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(1)}%`)
const asRows = (v: { deal: string; sales: number }[] | number) => (Array.isArray(v) ? v : [])
const TOP_DEALS = 8

type LiveSales = {
  hasData: boolean
  monthly: { month: string; sales: number }[]
  daily: { date: string; sales: number }[]
  sales_yday: number; sales_mtd: number; sales_l30: number; sales_l7: number
}

export function SpotReportSubscriptions({
  file,
  title,
  channel,
  liveChannel,
  variant = "billing",
  override,
}: {
  file: string
  title: string
  channel: string
  liveChannel?: string
  variant?: "billing" | "app"
  override?: Payload
}) {
  const { data: snap, loading, error, reload } = useReportData<Payload>(null, `/spot-report/data/${file}`, override)

  // Overlay live subscription SALES (trends + sales KPIs) when derivable for
  // this channel; book/FTC/Month-2/collected/deals stay on the snapshot.
  const [liveSales, setLiveSales] = useState<LiveSales | null>(null)
  useEffect(() => {
    if (override || !liveChannel) return
    fetch(`/api/spot-report/subscriptions?channel=${encodeURIComponent(liveChannel)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LiveSales | null) => { if (d?.hasData && d.monthly?.length) setLiveSales(d) })
      .catch(() => {})
  }, [liveChannel, override])
  const salesLive = !!liveSales

  const data: Payload | null = snap
    ? {
        ...snap,
        monthly: salesLive ? liveSales!.monthly : snap.monthly,
        daily: salesLive ? liveSales!.daily : snap.daily,
        kpis: salesLive
          ? { ...snap.kpis, sales_yday: liveSales!.sales_yday, sales_mtd: liveSales!.sales_mtd, sales_l30: liveSales!.sales_l30, sales_l7: liveSales!.sales_l7 }
          : snap.kpis,
      }
    : null

  const monthOpts = useMemo(() => (data ? Array.from(new Set((data.monthly ?? []).map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(monthOpts)
  const monthKey = (d: string) => `${d.slice(0, 7)}-01`

  const collected = useMemo(() => {
    if (!data?.collected?.length) return null
    const src = data.collected.filter((r) => inRange(String(r.month)))
    const months = Array.from(new Set(src.map((r) => r.month))).sort()
    const dealTotal = new Map<string, number>()
    for (const r of src) dealTotal.set(r.deal, (dealTotal.get(r.deal) ?? 0) + r.billed)
    const ranked = Array.from(dealTotal.entries()).sort((a, b) => b[1] - a[1])
    const top = ranked.slice(0, TOP_DEALS).map(([deal]) => deal)
    const topSet = new Set(top)
    const cell = new Map<string, number>()
    for (const r of src) {
      const key = topSet.has(r.deal) ? r.deal : "Other"
      cell.set(`${r.month}|${key}`, (cell.get(`${r.month}|${key}`) ?? 0) + r.billed)
    }
    const hasOther = ranked.length > TOP_DEALS
    const series = hasOther ? [...top, "Other"] : top
    const rows = months.map((m) => {
      const row: Record<string, string | number> = { month: monthLabel(m) }
      for (const d of series) row[d] = Math.round(cell.get(`${m}|${d}`) ?? 0)
      return row
    })
    return { rows, series }
  }, [data, inRange])

  if (loading && !snap) return <SkeletonReport tiles={10} charts={4} chartHeight={260} />
  if (error || !data) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  const k = data.kpis
  const monthlyData = data.monthly.filter((r) => inRange(String(r.month))).map((r) => ({ label: monthLabel(r.month), Sales: r.sales }))
  const dailyData = data.daily.filter((r) => inRange(monthKey(String(r.date)))).map((r) => ({ label: shortDay(r.date), Sales: r.sales }))
  const dealsYday = asRows(data.deals_yday)
  const dealsL30 = asRows(data.deals_l30)

  const DealTable = ({ rows }: { rows: { deal: string; sales: number }[] }) =>
    rows.length ? (
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-2 font-medium">Product</th>
              <th className="py-2 pr-2 text-right font-medium">Sales</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.deal}-${i}`} className="border-b border-border/50">
                <td className="py-1.5 pr-2 text-foreground">{r.deal}</td>
                <td className="py-1.5 pr-2 text-right font-mono text-foreground">{fmt(r.sales)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className="py-4 text-sm text-muted-foreground">No sales in this window.</p>
    )

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>{title}</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${salesLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {salesLive ? "● Sales live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{channel} subscription sales{salesLive ? " (live)" : ""}, book and card-collected billings (snapshot).</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={monthOpts} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {variant === "app" ? (
          <>
            <StatTile label="Active registered app users" value={fmt(k.active_users ?? 0)} />
            <StatTile label="Subscription book" value={fmt(k.book_size)} />
            <StatTile label="FTC %" value={pct(k.ftc_pct)} sub="first-time collection" />
          </>
        ) : (
          <>
            <StatTile label="Subscription book" value={fmt(k.book_size)} />
            <StatTile label="FTC %" value={pct(k.ftc_pct)} sub="first-time collection" />
            <StatTile label="Month 2 %" value={pct(k.month2_pct)} sub="retained to month 2" />
          </>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Monthly new sales" subtitle={salesLive ? "Live · Snowflake" : "Snapshot"}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={monthlyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="label" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} />
              <RTooltip content={<ChartTip />} />
              <Line type="monotone" dataKey="Sales" stroke={SERIES[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Daily new sales" subtitle={salesLive ? "Live · Snowflake · recent" : "Snapshot · recent"}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={dailyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="label" tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} />
              <RTooltip content={<ChartTip />} />
              <Line type="monotone" dataKey="Sales" stroke={BLUE} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {variant === "app" && dealsL30.length > 0 && (
        <ChartCard title="Top products — last 30 days" subtitle="By sales · snapshot">
          <ResponsiveContainer width="100%" height={Math.max(220, Math.min(dealsL30.length, 12) * 28 + 30)}>
            <BarChart data={[...dealsL30].sort((a, b) => b.sales - a.sales).slice(0, 12)} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="deal" tick={axisTick} axisLine={false} tickLine={false} width={220} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="sales" fill={BLUE} radius={[0, 3, 3, 0]} maxBarSize={20} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {variant === "billing" && collected && (
        <ChartCard title="Collected book trend via card" subtitle={`Billed by deal, by month · top ${TOP_DEALS} deals · snapshot`}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={collected.rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              {collected.series.map((d, i) => (
                <Bar key={d} dataKey={d} stackId="c" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <Legend items={collected.series.map((d, i) => ({ label: d.length > 42 ? d.slice(0, 40) + "…" : d, color: SERIES[i % SERIES.length] }))} />
        </ChartCard>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sales yesterday" value={fmt(k.sales_yday)} />
        <StatTile label="Sales MTD" value={fmt(k.sales_mtd)} />
        <StatTile label="Sales L30 days" value={fmt(k.sales_l30)} />
        <StatTile label="L7-day avg / day" value={(k.sales_l7 / 7).toFixed(1)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Sales yesterday" subtitle="By product">
          <DealTable rows={dealsYday} />
        </ChartCard>
        <ChartCard title="Sales last 30 days" subtitle="By product">
          <DealTable rows={dealsL30} />
        </ChartCard>
      </div>

      <p className="text-xs text-muted-foreground">
        {salesLive
          ? "Sales trends and sales KPIs are live from Snowflake (VW_SILVER_SURFER_SALES_SIM_INFO, same source as OKR). "
          : "Sales are on the snapshot. "}
        Book, FTC% and Month-2% (cohort measures from DATAWAREHOUSE.BILLING.COHORTSUCONNECT) and the card-collected billing
        (SMARTCONNECT_DBO.SUBSCRIBERBILLINGHISTORY) stay on the snapshot — the collected query is defined in the map but its
        schema isn&apos;t granted, and the book/FTC/Month-2 measures are PBI-defined.
      </p>
    </div>
  )
}
