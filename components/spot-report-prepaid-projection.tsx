"use client"

import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts"
import { Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, AMBER, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"

type Payload = { monthly: { month: string; qty: number; value: number }[] }
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)
function nextMonth(s: string, k: number) { const [y, m] = s.split("-").map(Number); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01` }
// Least-squares linear projection for the next `ahead` points.
function project(ys: number[], ahead: number) {
  const n = ys.length
  if (n < 2) return [] as number[]
  let sx = 0, sy = 0, sxy = 0, sxx = 0
  ys.forEach((y, i) => { sx += i; sy += y; sxy += i * y; sxx += i * i })
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
  const intercept = (sy - slope * sx) / n
  return Array.from({ length: ahead }, (_, j) => Math.max(0, Math.round(intercept + slope * (n + j))))
}

export function SpotReportPrepaidProjection({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/23_prepaid_recharge_projection.json", override)
  const monthOpts = useMemo(() => (data ? Array.from(new Set(data.monthly.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(monthOpts)
  const m = useMemo(() => {
    if (!data || !data.monthly.length) return null
    const months = data.monthly.filter((r) => inRange(String(r.month)))
    if (!months.length) return null
    const qtyProj = project(months.map((r) => r.qty), 6)
    const valProj = project(months.map((r) => r.value), 6)
    const build = (metric: "qty" | "value", proj: number[]) => {
      const rows: { month: string; Actual: number | null; Projected: number | null }[] = months.map((r, i) => ({ month: monthLabel(r.month), Actual: r[metric], Projected: i === months.length - 1 ? r[metric] : null }))
      const lastMonth = months[months.length - 1].month
      proj.forEach((v, j) => rows.push({ month: monthLabel(nextMonth(lastMonth, j + 1)), Actual: null, Projected: v }))
      return rows
    }
    const last = months[months.length - 1]
    return { qty: build("qty", qtyProj), val: build("value", valProj), lastQty: last.qty, lastVal: last.value }
  }, [data, inRange])
  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !m) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>
  const proj = (title: string, subtitle: string, rows: { month: string; Actual: number | null; Projected: number | null }[], fmtY: (v: number) => string) => (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
          <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60} tickFormatter={(v) => fmtY(Number(v))} />
          <RTooltip content={<ChartTip />} />
          <Line type="monotone" dataKey="Actual" stroke={BLUE} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="Projected" stroke={AMBER} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <Legend items={[{ label: "Actual", color: BLUE }, { label: "Projected (linear trend)", color: AMBER }]} />
    </ChartCard>
  )
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><PageHeading>Prepaid Recharge Projection</PageHeading><span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span></div>
          <p className="mt-1 text-sm text-muted-foreground">Prepaid recharge volume and revenue, with a 6-month trend projection.</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={monthOpts} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile label="Recharges last month" value={fmt(m.lastQty)} />
        <StatTile label="Revenue last month" value={rand(m.lastVal)} />
      </div>
      {proj("Prepaid recharge qty — actual + 6-month projection", "Snapshot · linear trend", m.qty, (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)))}
      {proj("Recharge revenue — actual + 6-month projection", "Snapshot · linear trend", m.val, rand)}
      <p className="text-xs text-muted-foreground">Baked snapshot. Projection is a simple least-squares linear trend over the actuals — indicative only, not a forecast model.</p>
    </div>
  )
}
