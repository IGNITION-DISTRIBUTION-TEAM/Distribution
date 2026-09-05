"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

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

// Donut for a composition-of-a-whole mix, with a legend showing share.
function MixDonut({ title, subtitle, data }: { title: string; subtitle: string; data: { name: string; value: number }[] }) {
  const chartMotion = useChartMotion()
  const total = data.reduce((a, d) => a + d.value, 0)
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <div className="flex items-center gap-4">
        <ResponsiveContainer width="50%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2} stroke="hsl(var(--card))" strokeWidth={2} {...chartMotion}>
              {data.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
            </Pie>
            <RTooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          {data.map((d, i) => (
            <li key={d.name} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SERIES[i % SERIES.length] }} />
              <span className="min-w-0 truncate text-foreground">{d.name}</span>
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                {fmt(d.value)}
                <span className="ml-1.5 text-xs">{total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  )
}

export function SpotReportConnectBook({ override }: { override?: Payload } = {}) {
  const chartMotion = useChartMotion()
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

  if (loading && !data) {
    return <SkeletonReport tiles={3} charts={3} chartHeight={200} />
  }
  if (error || !data) {
    return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>
  }

  const actData = data.monthly_activations.map((r) => ({ month: monthLabel(r.month), Activations: r.activations }))
  const revSource = revLive ? rev!.monthly : data.monthly_revenue
  const revData = revSource.map((r) => ({ month: monthLabel(r.month), Revenue: Math.round(r.revenue) }))
  const ltm = revLive ? rev!.ltm : data.kpis.ltm_revenue
  const groupingData = [...data.grouping_mix].sort((a, b) => b.sims - a.sims).map((r) => ({ grouping: r.grouping, SIMs: r.sims }))
  const channelData = [...data.channel_mix].sort((a, b) => b.sims - a.sims).map((r) => ({ channel: r.channel, SIMs: r.sims }))

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Spot Connect Book</PageHeading>
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
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} {...chartMotion} />
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
              <Bar dataKey="Revenue" fill={SERIES[1]} radius={[3, 3, 0, 0]} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <MixDonut
          title="SIM grouping mix"
          subtitle="SIMs by product grouping"
          data={groupingData.map((r) => ({ name: r.grouping, value: r.SIMs }))}
        />
        <MixDonut
          title="Channel mix"
          subtitle="SIMs by acquisition channel"
          data={channelData.map((r) => ({ name: r.channel, value: r.SIMs }))}
        />
      </div>

      {!revLive && (
        <p className="text-xs text-muted-foreground">
          Showing the baked snapshot. Upload the income statement (Financials → Upload) to make revenue &amp; LTM live.
        </p>
      )}
    </ReportPage>
  )
}
