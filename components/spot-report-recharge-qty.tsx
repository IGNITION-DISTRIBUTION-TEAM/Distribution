"use client"

import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, axisTick, MONTHS, shortDay, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"

type Row = { month?: string; week?: string; type: string; qty: number; value: number }
type Payload = { kpis: { qty_mtd: number; value_mtd: number; qty_lm: number; value_lm: number }; monthly: Row[]; weekly: Row[] }
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)

function stack(rows: Row[], key: "month" | "week", metric: "qty" | "value", label: (s: string) => string) {
  const periods = Array.from(new Set(rows.map((r) => r[key] as string))).sort()
  const types = Array.from(new Set(rows.map((r) => r.type)))
  const cell = new Map<string, number>()
  for (const r of rows) cell.set(`${r[key]}|${r.type}`, (cell.get(`${r[key]}|${r.type}`) ?? 0) + r[metric])
  const data = periods.map((p) => { const row: Record<string, string | number> = { period: label(p) }; for (const t of types) row[t] = Math.round(cell.get(`${p}|${t}`) ?? 0); return row })
  return { data, types }
}

export function SpotReportRechargeQty({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/19_recharge_qty_dash.json", override)
  const months = useMemo(() => (data ? Array.from(new Set(data.monthly.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(months)
  const monthKey = (d: string) => `${d.slice(0, 7)}-01`
  const m = useMemo(() => {
    if (!data) return null
    const monthly = data.monthly.filter((r) => inRange(String(r.month)))
    const weekly = data.weekly.filter((r) => inRange(monthKey(String(r.week))))
    return {
      mQty: stack(monthly, "month", "qty", monthLabel),
      mVal: stack(monthly, "month", "value", monthLabel),
      wQty: (() => { const s = stack(weekly, "week", "qty", shortDay); return { data: s.data.slice(-26), types: s.types } })(),
    }
  }, [data, inRange])
  if (loading && !data) return <SkeletonReport charts={3} chartHeight={280} />
  if (error || !data || !m) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>
  const k = data.kpis
  const legend = (types: string[]) => types.map((t, i) => ({ label: t, color: SERIES[i % SERIES.length] }))
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><PageHeading>Recharge Qty Dash</PageHeading><span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span></div>
          <p className="mt-1 text-sm text-muted-foreground">Recharge volume and revenue by type — monthly and weekly.</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={months} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Recharges this month" value={fmt(k.qty_mtd)} sub="MTD" />
        <StatTile label="Revenue this month" value={rand(k.value_mtd)} sub="MTD" />
        <StatTile label="Recharges last month" value={fmt(k.qty_lm)} />
        <StatTile label="Revenue last month" value={rand(k.value_lm)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Monthly recharge qty by type" subtitle="Snapshot">
          <ResponsiveContainer width="100%" height={280}><BarChart data={m.mQty.data} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="period" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.mQty.types.map((t, i) => <Bar key={t} dataKey={t} stackId="s" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
          <Legend items={legend(m.mQty.types)} />
        </ChartCard>
        <ChartCard title="Monthly recharge revenue by type" subtitle="Snapshot">
          <ResponsiveContainer width="100%" height={280}><BarChart data={m.mVal.data} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="period" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.mVal.types.map((t, i) => <Bar key={t} dataKey={t} stackId="s" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
          <Legend items={legend(m.mVal.types)} />
        </ChartCard>
      </div>
      <ChartCard title="Weekly recharge qty by type" subtitle="Last 26 weeks · snapshot">
        <ResponsiveContainer width="100%" height={280}><BarChart data={m.wQty.data} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="period" tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.wQty.types.map((t, i) => <Bar key={t} dataKey={t} stackId="s" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
        <Legend items={legend(m.wQty.types)} />
      </ChartCard>
      <p className="text-xs text-muted-foreground">Baked snapshot of recharge transactions by type.</p>
    </div>
  )
}
