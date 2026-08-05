"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Info, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, AMBER, axisTick, fmt, StatTile, ChartCard, ChartTip, Legend } from "@/components/spot-report-kit"

type Channel = { channel: string; yesterday: number; last7avg: number }

export function SpotReportOkr() {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [live, setLive] = useState(false)
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
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }

  const totalYest = (channels ?? []).reduce((a, c) => a + c.yesterday, 0)
  const totalAvg = (channels ?? []).reduce((a, c) => a + c.last7avg, 0)
  const chartData = (channels ?? []).map((c) => ({ channel: c.channel, Yesterday: c.yesterday, "7-day avg": c.last7avg }))

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">OKR Scorecard</h2>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Subscriptions live · Snowflake" : "● No data"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Subscription sales by channel — yesterday vs 7-day average.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Actuals are live from Snowflake. <b>Targets and RAG status aren&apos;t shown</b> — those come from the
          &quot;Goal sheet&quot; in the finance workbook, which has no target values yet. Populate it (or provide an
          OKR targets source) and the vs-target / RAG view can be added.
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {channels && channels.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Subscriptions yesterday" value={fmt(totalYest)} />
            <StatTile label="7-day avg / working day" value={totalAvg.toLocaleString(undefined, { maximumFractionDigits: 1 })} />
            <StatTile label="Channels" value={String(channels.length)} />
            <StatTile
              label="Yesterday vs 7-day avg"
              value={`${totalYest - totalAvg >= 0 ? "+" : ""}${(totalYest - totalAvg).toLocaleString(undefined, { maximumFractionDigits: 1 })}`}
              accent={totalYest - totalAvg >= 0 ? "text-emerald-300" : "text-rose-300"}
            />
          </div>

          <ChartCard title="Subscriptions by channel" subtitle="Yesterday vs 7-day average">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="channel" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
                <Bar dataKey="Yesterday" fill={BLUE} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false} />
                <Bar dataKey="7-day avg" fill={AMBER} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <Legend items={[{ label: "Yesterday", color: BLUE }, { label: "7-day avg", color: AMBER }]} />
          </ChartCard>
        </>
      )}

      {channels && channels.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No subscription sales returned for the last 7 days.</p>
      )}
    </div>
  )
}
