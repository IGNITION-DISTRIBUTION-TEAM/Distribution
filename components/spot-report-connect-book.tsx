"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, useReportData } from "@/components/spot-report-kit"

type Payload = {
  kpis: { total_sims: number; active_sims: number; ltm_revenue: number }
  monthly_activations: { month: string; activations: number }[]
  monthly_revenue: { month: string; revenue: number }[]
  grouping_mix: { grouping: string; sims: number }[]
  channel_mix: { channel: string; sims: number }[]
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
function rand(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `R ${(n / 1_000_000_000).toFixed(2)}bn`
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

export function SpotReportConnectBook({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(
    null,
    "/spot-report/data/34_spot_connect_book.json",
    override
  )
  const [rev, setRev] = useState<{
    monthly: { month: string; revenue: number }[]; ltm: number; dataThrough: string | null; uploadedAt: string | null
  } | null>(null)
  useEffect(() => {
    if (override) return
    fetch("/api/spot-report/exco-revenue")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.hasData) {
          const all: { month: string; revenue: number }[] = d.monthly_revenue
          const ltm = all.slice(-12).reduce((a, x) => a + x.revenue, 0)
          setRev({ monthly: all.slice(-14), ltm, dataThrough: d.dataThrough ?? null, uploadedAt: d.uploadedAt ?? null })
        }
      })
      .catch(() => {})
  }, [override])
  const revLive = !!rev

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }
  if (error || !data) {
    return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>
  }

  const actData = data.monthly_activations.map((r) => ({ month: monthLabel(r.month), Activations: r.activations }))
  const revSource = revLive ? rev!.monthly : data.monthly_revenue
  const revData = revSource.map((r) => ({ month: monthLabel(r.month), Revenue: Math.round(r.revenue) }))
  const ltm = revLive ? rev!.ltm : data.kpis.ltm_revenue
  const groupingData = [...data.grouping_mix].sort((a, b) => b.sims - a.sims).map((r) => ({ grouping: r.grouping, SIMs: r.sims }))
  const channelData = [...data.channel_mix].sort((a, b) => b.sims - a.sims).map((r) => ({ channel: r.channel, SIMs: r.sims }))

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">Spot Connect Book</h2>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${revLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {revLive ? "● Revenue live" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Book overview — SIM base, activations, revenue and mix.</p>
          {revLive && rev!.dataThrough && (
            <p className="mt-1 text-xs text-muted-foreground">
              Income statement: data through <span className="font-medium text-foreground">{monthLabel(rev!.dataThrough)}</span>
              {rev!.uploadedAt ? ` · uploaded ${rev!.uploadedAt}` : ""}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Total SIMs" value={fmt(data.kpis.total_sims)} />
        <StatTile label="Active SIMs" value={fmt(data.kpis.active_sims)} />
        <StatTile label="LTM revenue" value={rand(ltm)} sub={revLive ? "live · income statement" : undefined} accent={revLive ? "text-emerald-300" : undefined} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Monthly activations" subtitle="Last 14 months">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={actData} margin={{ top: 6, right: 12, bottom: 0, left: -4 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Monthly revenue" subtitle={revLive ? `Live · income statement (ZAR)${rev!.dataThrough ? ` · through ${monthLabel(rev!.dataThrough)}` : ""}` : "Last 14 months (ZAR) · snapshot"}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={revData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60} tickFormatter={(v) => rand(Number(v))} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Revenue" fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="SIM grouping mix" subtitle="SIMs by product grouping">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={groupingData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis type="category" dataKey="grouping" tick={axisTick} tickLine={false} axisLine={false} width={90} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="SIMs" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                {groupingData.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Channel mix" subtitle="SIMs by acquisition channel">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={channelData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis type="category" dataKey="channel" tick={axisTick} tickLine={false} axisLine={false} width={90} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="SIMs" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                {channelData.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {!revLive && (
        <p className="text-xs text-muted-foreground">
          Showing the baked snapshot. Upload the income statement (Financials → Upload) to make revenue &amp; LTM live.
        </p>
      )}
    </div>
  )
}
