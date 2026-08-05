"use client"

import { useEffect, useState } from "react"
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Info, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, AMBER, axisTick, MONTHS, StatTile, ChartCard, ChartTip, Legend } from "@/components/spot-report-kit"
import { SpotReportPlaceholder } from "@/components/spot-report-placeholder"

type Row = { month: string; actual: number | null; target: number | null }
const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const one = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 })

export function SpotReportOkrTrends() {
  const [series, setSeries] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetch("/api/spot-report/okr-trends")
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `Failed (${r.status})`)
        setSeries(d.series ?? [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }
  if (error) {
    return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
  }

  // No income statement uploaded yet → honest placeholder.
  if (!series || series.length === 0) {
    return (
      <SpotReportPlaceholder
        title="OKR Trends"
        subtitle="Average subscription sales per day — target vs actual over time."
        note="No data yet. This reads the 'Average subscription sales per day' actual (Telco fin) and target (Goal sheet) from the uploaded income statement. Upload it under Financials → Upload."
        kpis={["Latest actual", "Latest target", "Months on target", "Trend"]}
        charts={["Subscription sales per day — actual vs target"]}
      />
    )
  }

  const chart = series.map((r) => ({
    month: monthLabel(r.month),
    Actual: r.actual,
    Target: r.target,
  }))
  const withBoth = series.filter((r) => r.actual != null && r.target != null)
  const onTarget = withBoth.filter((r) => (r.actual as number) >= (r.target as number)).length
  const latest = [...series].reverse().find((r) => r.actual != null)
  const latestTarget = [...series].reverse().find((r) => r.target != null)?.target ?? null

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">OKR Trends</h2>
            <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">● Income statement</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Average subscription sales per day — actual vs target.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Actual and target both from the uploaded income statement (Telco fin &amp; Goal sheet).</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Latest actual (subs/day)" value={latest?.actual != null ? one(latest.actual) : "—"} />
        <StatTile label="Latest target (subs/day)" value={latestTarget != null ? one(latestTarget) : "not set"} />
        <StatTile label="Months on/above target" value={`${onTarget} / ${withBoth.length}`} />
        <StatTile
          label="Latest vs target"
          value={latest?.actual != null && latestTarget != null ? `${latest.actual - latestTarget >= 0 ? "+" : ""}${one(latest.actual - latestTarget)}` : "—"}
          accent={latest?.actual != null && latestTarget != null ? (latest.actual >= latestTarget ? "text-emerald-300" : "text-rose-300") : undefined}
        />
      </div>

      <ChartCard title="Subscription sales per day" subtitle="Actual vs target by month">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chart} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={12} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} />
            <RTooltip content={<ChartTip />} />
            <Line type="monotone" dataKey="Actual" stroke={BLUE} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="Target" stroke={AMBER} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        <Legend items={[{ label: "Actual", color: BLUE }, { label: "Target", color: AMBER }]} />
      </ChartCard>
    </div>
  )
}
