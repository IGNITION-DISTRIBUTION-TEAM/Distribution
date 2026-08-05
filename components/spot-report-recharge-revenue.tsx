"use client"

import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, MONTHS, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"

type MonthRow = { month: string } & Record<string, number | string>
type Payload = { monthly: MonthRow[] }
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)
const STREAMS: { key: string; label: string }[] = [
  { key: "cellc", label: "Cell C" }, { key: "voucher", label: "Voucher" }, { key: "app", label: "App" },
  { key: "billrun", label: "Bill run" }, { key: "postpaid", label: "Postpaid" }, { key: "website", label: "Website" },
]

export function SpotReportRechargeRevenue({ override }: { override?: Payload } = {}) {
  const { data, live, loading, error, reload } = useReportData<Payload>("/api/spot-report/recharge-revenue", "/spot-report/data/21_recharge_revenue_monthly.json", override)
  const m = useMemo(() => {
    if (!data) return null
    const streams = STREAMS.filter((s) => data.monthly.some((r) => Number(r[s.key] ?? 0) > 0))
    const rows = data.monthly.map((r) => {
      const row: Record<string, string | number> = { month: monthLabel(r.month) }
      let total = 0
      for (const s of streams) { const v = Math.round(Number(r[s.key] ?? 0)); row[s.label] = v; total += v }
      row.Total = total
      return row
    })
    const latest = data.monthly[data.monthly.length - 1]
    const prev = data.monthly[data.monthly.length - 2]
    const sum = (r: MonthRow | undefined) => (r ? streams.reduce((a, s) => a + Number(r[s.key] ?? 0), 0) : 0)
    return { streams, rows, totalThis: sum(latest), totalLast: sum(prev), cellcThis: Number(latest?.cellc ?? 0), appThis: Number(latest?.app ?? 0) }
  }, [data])
  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !m) return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-2xl font-semibold text-foreground">Recharge Revenue Monthly</h2><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>{live ? "● Live · Snowflake" : "● Snapshot"}</span></div>
          <p className="mt-1 text-sm text-muted-foreground">Monthly recharge revenue by stream.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total revenue this month" value={rand(m.totalThis)} />
        <StatTile label="Total revenue last month" value={rand(m.totalLast)} />
        <StatTile label="Cell C this month" value={rand(m.cellcThis)} />
        <StatTile label="App purchases this month" value={rand(m.appThis)} />
      </div>
      <ChartCard title="Monthly revenue by stream" subtitle="Stacked · snapshot">
        <ResponsiveContainer width="100%" height={320}><BarChart data={m.rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />{m.streams.map((s, i) => <Bar key={s.label} dataKey={s.label} stackId="s" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />)}</BarChart></ResponsiveContainer>
        <Legend items={m.streams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>
      <ChartCard title="Total monthly revenue" subtitle="All streams · snapshot">
        <ResponsiveContainer width="100%" height={260}><BarChart data={m.rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} /><XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} /><YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} /><RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} /><Bar dataKey="Total" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer>
      </ChartCard>
      <p className="text-xs text-muted-foreground">{live ? "Live from Snowflake (VW_TELCO_MONTHLY_REVENUE_L13MONTHS)." : "Baked snapshot of recharge revenue by stream."}</p>
    </div>
  )
}
