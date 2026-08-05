"use client"

import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, axisTick, MONTHS, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"

type MonthRow = { month: string } & Record<string, number | string>
type Payload = { monthly: MonthRow[] }
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)
const STREAMS: { key: string; label: string }[] = [
  { key: "cellc", label: "Cell C" }, { key: "voucher", label: "Voucher" }, { key: "app", label: "App" },
  { key: "billrun", label: "Bill run" }, { key: "postpaid", label: "Postpaid" }, { key: "website", label: "Website" },
]

export function SpotReportRevenueComparisons({ override }: { override?: Payload } = {}) {
  const { data, live, loading, error, reload } = useReportData<Payload>("/api/spot-report/recharge-revenue", "/spot-report/data/22_revenue_comparisons.json", override)
  const months = useMemo(() => (data ? Array.from(new Set(data.monthly.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(months)
  const m = useMemo(() => {
    if (!data) return null
    const monthly = data.monthly.filter((r) => inRange(String(r.month)))
    const streams = STREAMS.filter((s) => monthly.some((r) => Number(r[s.key] ?? 0) > 0))
    const grouped = monthly.map((r) => { const row: Record<string, string | number> = { month: monthLabel(String(r.month)) }; for (const s of streams) row[s.label] = Math.round(Number(r[s.key] ?? 0)); return row })
    const share = monthly.map((r) => {
      const total = streams.reduce((a, s) => a + Number(r[s.key] ?? 0), 0) || 1
      const row: Record<string, string | number> = { month: monthLabel(String(r.month)) }
      for (const s of streams) row[s.label] = Math.round((Number(r[s.key] ?? 0) / total) * 1000) / 10
      return row
    })
    return { streams, grouped, share }
  }, [data, inRange])
  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !m) return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-2xl font-semibold text-foreground">Revenue Comparisons</h2><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>{live ? "● Live · Snowflake" : "● Snapshot"}</span></div>
          <p className="mt-1 text-sm text-muted-foreground">Recharge revenue streams compared side-by-side and by share.</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={months} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>
      <ChartCard title="Revenue by stream — side by side" subtitle="Monthly · snapshot">
        <ResponsiveContainer width="100%" height={320}><BarChart data={m.grouped} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.streams.map((s, i) => <Bar key={s.label} dataKey={s.label} fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
        <Legend items={m.streams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>
      <ChartCard title="Revenue share by stream" subtitle="% of monthly total (100% stacked) · snapshot">
        <ResponsiveContainer width="100%" height={300}><BarChart data={m.share} stackOffset="expand" margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`} /><RTooltip content={<ChartTip suffix="%" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.streams.map((s, i) => <Bar key={s.label} dataKey={s.label} stackId="sh" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
        <Legend items={m.streams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>
      <p className="text-xs text-muted-foreground">{live ? "Live from Snowflake (VW_TELCO_MONTHLY_REVENUE_L13MONTHS)." : "Baked snapshot."} Share chart normalises each month to 100%.</p>
    </div>
  )
}
