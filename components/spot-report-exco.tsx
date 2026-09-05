"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BLUE, SERIES, axisTick, MONTHS, fmt,
  StatTile, ChartCard, ChartTip, useReportData,
} from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type Payload = {
  kpis: { active_sims: number; act_mtd: number; act_lm: number; rev_mtd: number }
  monthly_activations: { month: string; activations: number }[]
  monthly_revenue: { month: string; revenue: number }[]
  channel_mix: { channel: string; sims: number }[]
  churn_reasons: { reason: string; count: number }[]
  enps: { period: string; enps: number; pending: boolean }[]
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
function rand(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

export function SpotReportExco({ override }: { override?: Payload } = {}) {
  const chartMotion = useChartMotion()
  const { data, live, loading, error, reload } = useReportData<Payload>(
    null, // activations/eNPS still snapshot; revenue is overlaid live below
    "/spot-report/data/33_exco_scorecard.json",
    override
  )

  // Revenue overlay from the uploaded income statement (last 14 months).
  const [rev, setRev] = useState<{
    monthly: { month: string; revenue: number }[]
    mtd: number | null
    dataThrough: string | null
    uploadedAt: string | null
  } | null>(null)
  useEffect(() => {
    if (override) return
    fetch("/api/spot-report/exco-revenue")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.hasData)
          setRev({
            monthly: d.monthly_revenue.slice(-14),
            mtd: d.rev_mtd,
            dataThrough: d.dataThrough ?? null,
            uploadedAt: d.uploadedAt ?? null,
          })
      })
      .catch(() => {})
  }, [override])
  const revLive = !!rev

  if (loading && !data) {
    return <SkeletonReport charts={4} chartHeight={260} />
  }
  if (error || !data) {
    return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>
  }

  const actData = data.monthly_activations.map((r) => ({ month: monthLabel(r.month), Activations: r.activations }))
  // Revenue: live income-statement overlay when available, else the snapshot.
  const revSource = revLive ? rev!.monthly : data.monthly_revenue
  const revData = revSource.map((r) => ({ month: monthLabel(r.month), Revenue: Math.round(r.revenue) }))
  const revMtd = revLive && rev!.mtd != null ? rev!.mtd : data.kpis.rev_mtd
  const channelData = [...data.channel_mix].sort((a, b) => b.sims - a.sims).map((r) => ({ channel: r.channel, SIMs: r.sims }))
  const churnData = [...data.churn_reasons].sort((a, b) => b.count - a.count).map((r) => ({ reason: r.reason, Count: r.count }))
  const enpsData = data.enps.map((r) => ({ period: r.period, eNPS: r.pending ? null : r.enps }))
  const deltaMtd = data.kpis.act_mtd - data.kpis.act_lm

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Exco Scorecard</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Executive summary — activations, revenue, channel mix and eNPS.</p>
          {revLive && rev!.dataThrough && (
            <p className="mt-1 text-xs text-muted-foreground">
              Income statement: data through{" "}
              <span className="font-medium text-foreground">{monthLabel(rev!.dataThrough)}</span>
              {rev!.uploadedAt ? ` · uploaded ${rev!.uploadedAt}` : ""}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Active SIMs" value={fmt(data.kpis.active_sims)} />
        <StatTile
          label="Activations MTD"
          value={fmt(data.kpis.act_mtd)}
          sub={`${deltaMtd >= 0 ? "+" : ""}${fmt(deltaMtd)} vs last month`}
          accent={deltaMtd >= 0 ? "text-emerald-300" : "text-rose-300"}
        />
        <StatTile label="Activations last month" value={fmt(data.kpis.act_lm)} />
        <StatTile
          label="Revenue MTD"
          value={rand(revMtd)}
          sub={revLive ? "live · income statement" : undefined}
          accent={revLive ? "text-emerald-300" : undefined}
        />
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

        <ChartCard
          title="Monthly revenue"
          subtitle={
            revLive
              ? `Live · income statement (ZAR)${rev!.dataThrough ? ` · through ${monthLabel(rev!.dataThrough)}` : ""}`
              : "Last 14 months (ZAR) · snapshot"
          }
        >
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

        <ChartCard title="Channel mix" subtitle="Active SIMs by acquisition channel">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={channelData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis type="category" dataKey="channel" tick={axisTick} tickLine={false} axisLine={false} width={80} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="SIMs" radius={[0, 3, 3, 0]} {...chartMotion}>
                {channelData.map((_, i) => (
                  <Cell key={i} fill={SERIES[i % SERIES.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="eNPS" subtitle="Quarterly employee net promoter score">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={enpsData} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="period" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={40} />
              <RTooltip content={<ChartTip />} />
              <Line type="monotone" dataKey="eNPS" stroke={BLUE} strokeWidth={2} connectNulls dot={{ r: 3 }} {...chartMotion} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {churnData.length > 0 && (
        <ChartCard title="Churn reasons" subtitle="Deactivations by stated reason">
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={churnData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis type="category" dataKey="reason" tick={axisTick} tickLine={false} axisLine={false} width={80} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Count" fill={SERIES[4]} radius={[0, 3, 3, 0]} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <p className="text-xs text-muted-foreground">
        {revLive
          ? "Revenue is live from the uploaded income statement (Revenue lines in the Format Is sheet). Activations, channel mix and eNPS are still from the snapshot."
          : "Showing the baked snapshot. Upload the income statement (Financials → Upload) to make revenue live; activations and eNPS remain snapshot until their sources are wired."}
      </p>
    </ReportPage>
  )
}
