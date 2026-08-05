"use client"

import { useMemo } from "react"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, MONTHS, shortDay, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"

type Kpis = {
  book_size: number; ftc_pct: number | null; month2_pct: number | null
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

export function SpotReportSubscriptions({
  file,
  title,
  channel,
  override,
}: {
  file: string
  title: string
  channel: string
  override?: Payload
}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, `/spot-report/data/${file}`, override)

  const collected = useMemo(() => {
    if (!data?.collected?.length) return null
    const months = Array.from(new Set(data.collected.map((r) => r.month))).sort()
    const dealTotal = new Map<string, number>()
    for (const r of data.collected) dealTotal.set(r.deal, (dealTotal.get(r.deal) ?? 0) + r.billed)
    const ranked = Array.from(dealTotal.entries()).sort((a, b) => b[1] - a[1])
    const top = ranked.slice(0, TOP_DEALS).map(([deal]) => deal)
    const topSet = new Set(top)
    const cell = new Map<string, number>()
    for (const r of data.collected) {
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
  }, [data])

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data) return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>

  const k = data.kpis
  const monthlyData = data.monthly.map((r) => ({ label: monthLabel(r.month), Sales: r.sales }))
  const dailyData = data.daily.map((r) => ({ label: shortDay(r.date), Sales: r.sales }))
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
            <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
            <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{channel} subscription sales, book and card-collected billings.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Subscription book" value={fmt(k.book_size)} />
        <StatTile label="FTC %" value={pct(k.ftc_pct)} sub="first-time collection" />
        <StatTile label="Month 2 %" value={pct(k.month2_pct)} sub="retained to month 2" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Monthly new sales" subtitle="Snapshot">
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

        <ChartCard title="Daily new sales" subtitle="Snapshot · recent">
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

      {collected && (
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
        Baked snapshot. The underlying billing/cohort views live across several Snowflake schemas
        (DATAWAREHOUSE.BILLING, SMARTCONNECT_DBO) and the headline measures (book, FTC%, Month-2%) are
        PBI-defined, so this isn&apos;t wired live yet — see the note in chat for what a live version needs.
      </p>
    </div>
  )
}
