"use client"

import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, axisTick, MONTHS, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type MonthRow = { month: string } & Record<string, number | string>
type Payload = { monthly: MonthRow[] }
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)
const STREAMS = [
  { key: "cellc", label: "Cell C" }, { key: "voucher", label: "Voucher" }, { key: "app", label: "App" },
  { key: "billrun", label: "Bill run" }, { key: "postpaid", label: "Postpaid" }, { key: "website", label: "Website" },
]

export function SpotReportRechargeTrend({ override }: { override?: Payload } = {}) {
  const chartMotion = useChartMotion()
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/20_recharge_trend_type.json", override)
  const months = useMemo(() => (data ? Array.from(new Set(data.monthly.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(months)
  const m = useMemo(() => {
    if (!data) return null
    const monthly = data.monthly.filter((r) => inRange(String(r.month)))
    const qtyStreams = STREAMS.filter((s) => monthly.some((r) => Number(r[`${s.key}_qty`] ?? 0) > 0))
    const valStreams = STREAMS.filter((s) => monthly.some((r) => Number(r[`${s.key}_val`] ?? 0) > 0))
    const qty = monthly.map((r) => { const row: Record<string, string | number> = { month: monthLabel(String(r.month)) }; for (const s of qtyStreams) row[s.label] = Math.round(Number(r[`${s.key}_qty`] ?? 0)); return row })
    const val = monthly.map((r) => { const row: Record<string, string | number> = { month: monthLabel(String(r.month)) }; for (const s of valStreams) row[s.label] = Math.round(Number(r[`${s.key}_val`] ?? 0)); return row })
    return { qtyStreams, valStreams, qty, val }
  }, [data, inRange])
  if (loading && !data) return <SkeletonReport tiles={0} chartHeight={320} />
  if (error || !data || !m) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>
  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><PageHeading>Recharge Trend by Type</PageHeading><span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span></div>
          <p className="mt-1 text-sm text-muted-foreground">Monthly recharge quantity and revenue by recharge type.</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={months} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>
      <ChartCard title="Monthly recharge quantity by type" subtitle="Stacked · snapshot">
        <ResponsiveContainer width="100%" height={320}><BarChart data={m.qty} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.qtyStreams.map((s, i) => <Bar key={s.label} dataKey={s.label} stackId="q" fill={SERIES[i % SERIES.length]} {...chartMotion} />)}</BarChart></ResponsiveContainer>
        <Legend items={m.qtyStreams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>
      <ChartCard title="Monthly revenue by type" subtitle="Stacked · snapshot">
        <ResponsiveContainer width="100%" height={320}><BarChart data={m.val} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.valStreams.map((s, i) => <Bar key={s.label} dataKey={s.label} stackId="v" fill={SERIES[i % SERIES.length]} {...chartMotion} />)}</BarChart></ResponsiveContainer>
        <Legend items={m.valStreams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>
      <p className="text-xs text-muted-foreground">Baked snapshot of recharge quantity and revenue by type.</p>
    </ReportPage>
  )
}
