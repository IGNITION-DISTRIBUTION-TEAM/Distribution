"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { Info, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, AMBER, axisTick, fmt, StatTile, ChartCard, ChartTip, Legend } from "@/components/spot-report-kit"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type Channel = { channel: string; yesterday: number; last7avg: number }

export function SpotReportOkr() {
  const chartMotion = useChartMotion()
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [live, setLive] = useState(false)
  const [target, setTarget] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetch("/api/spot-report/okr")
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `Failed (${r.status})`)
        setChannels(d.channels ?? [])
        setLive(!!d.hasData)
        setTarget(typeof d.targetPerDay === "number" ? d.targetPerDay : null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  if (loading && !channels) {
    return <SkeletonReport charts={1} chartHeight={300} />
  }

  const totalYest = (channels ?? []).reduce((a, c) => a + c.yesterday, 0)
  const totalAvg = (channels ?? []).reduce((a, c) => a + c.last7avg, 0)
  const chartData = (channels ?? []).map((c) => ({ channel: c.channel, Yesterday: c.yesterday, "7-day avg": c.last7avg }))

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>OKR Scorecard</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Subscriptions live · Snowflake" : "● No data"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Subscription sales by channel — yesterday vs 7-day average.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      {target == null ? (
        <Banner tone="warning">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Actuals are live from Snowflake. <b>No target is set</b> — the target comes from the &quot;Goal sheet&quot;
            in the uploaded income statement. Upload a workbook with a filled-in &quot;Average subscription sales per
            day&quot; target and the vs-target / RAG view appears.
          </span>
        </Banner>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Actuals live from Snowflake; target from the uploaded income statement (Goal sheet). RAG compares the
            7-day average to target.
          </span>
        </div>
      )}

      {error && (
        <Banner tone="error">
          <span>{error}</span>
        </Banner>
      )}

      {channels && channels.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Subscriptions yesterday" value={fmt(totalYest)} />
            <StatTile label="7-day avg / working day" value={totalAvg.toLocaleString(undefined, { maximumFractionDigits: 1 })} />
            <StatTile
              label="Target (subs/day)"
              value={target != null ? target.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "not set"}
              sub={target == null ? "Goal sheet has no target" : undefined}
            />
            <StatTile
              label="vs target (7-day avg)"
              value={
                target != null
                  ? `${totalAvg - target >= 0 ? "+" : ""}${(totalAvg - target).toLocaleString(undefined, { maximumFractionDigits: 1 })}`
                  : "—"
              }
              sub={target != null ? (totalAvg >= target ? "on/above target" : "below target") : undefined}
              accent={target != null ? (totalAvg >= target ? "text-emerald-300" : "text-rose-300") : undefined}
            />
          </div>

          <ChartCard title="Subscriptions by channel" subtitle="Yesterday vs 7-day average">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="channel" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
                <Bar dataKey="Yesterday" fill={BLUE} radius={[3, 3, 0, 0]} maxBarSize={40} {...chartMotion} />
                <Bar dataKey="7-day avg" fill={AMBER} radius={[3, 3, 0, 0]} maxBarSize={40} {...chartMotion} />
              </BarChart>
            </ResponsiveContainer>
            <Legend items={[{ label: "Yesterday", color: BLUE }, { label: "7-day avg", color: AMBER }]} />
          </ChartCard>
        </>
      )}

      {channels && channels.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No subscription sales returned for the last 7 days.</p>
      )}
    </ReportPage>
  )
}
