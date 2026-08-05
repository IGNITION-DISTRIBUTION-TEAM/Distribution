"use client"

import { useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, axisTick, MONTHS, shortDay, fmt, StatTile, ChartCard, ChartTip, useReportData } from "@/components/spot-report-kit"

type MRow = { month: string; channel: string; cnt: number }
type WRow = { week: string; channel: string; cnt: number }
type DRow = { date: string; channel: string; cnt: number }
type TRow = { tenant: string; channel: string; this_month: number; last_month: number }
type Payload = {
  monthly_by_channel: MRow[]
  weekly_by_channel: WRow[]
  last7_by_channel: DRow[]
  top_tenants_by_channel: TRow[]
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const CHANNEL_ORDER = ["F2F", "Telesales", "Digital", "OTHER"]

function aggregate<T extends { channel: string; cnt: number }>(rows: T[], key: keyof T, active: Set<string>) {
  const buckets = new Map<string, number>()
  for (const r of rows) {
    if (!active.has(r.channel)) continue
    const k = String(r[key])
    buckets.set(k, (buckets.get(k) ?? 0) + r.cnt)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, cnt]) => ({ period, cnt }))
}

export function SpotReportTradingStoreTrend({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/12_trading_store_trend.json", override)

  const channels = useMemo(() => {
    if (!data) return CHANNEL_ORDER
    const found = new Set<string>()
    for (const r of data.monthly_by_channel) found.add(r.channel)
    for (const r of data.top_tenants_by_channel) found.add(r.channel)
    const ordered = CHANNEL_ORDER.filter((c) => found.has(c))
    const extra = Array.from(found).filter((c) => !CHANNEL_ORDER.includes(c)).sort()
    return [...ordered, ...extra]
  }, [data])

  const [active, setActive] = useState<Set<string>>(() => new Set(CHANNEL_ORDER))
  const toggle = (c: string) => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data) return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>

  const monthly = aggregate(data.monthly_by_channel, "month", active)
  const weekly = aggregate(data.weekly_by_channel, "week", active).slice(-26)
  const monthlyData = monthly.map((r) => ({ label: monthLabel(r.period), Activations: r.cnt }))
  const weeklyData = weekly.map((r) => ({ label: shortDay(r.period), Activations: r.cnt }))

  const thisM = monthly.length ? monthly[monthly.length - 1].cnt : 0
  const lastM = monthly.length >= 2 ? monthly[monthly.length - 2].cnt : 0
  const delta = thisM - lastM
  const last7 = data.last7_by_channel.filter((r) => active.has(r.channel)).reduce((a, r) => a + r.cnt, 0)
  const activeLabel = active.size === 0 ? "None" : active.size === channels.length ? "All" : Array.from(active).join(", ")

  // Top stores (tenants) for active channels.
  const totals = new Map<string, { tenant: string; this_month: number; last_month: number }>()
  for (const r of data.top_tenants_by_channel) {
    if (!active.has(r.channel)) continue
    const t = totals.get(r.tenant) ?? { tenant: r.tenant, this_month: 0, last_month: 0 }
    t.this_month += r.this_month
    t.last_month += r.last_month
    totals.set(r.tenant, t)
  }
  const topRows = Array.from(totals.values()).sort((a, b) => b.this_month - a.this_month).slice(0, 20)

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">Trading Store Trend</h2>
            <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Trading-store activations by sales channel — monthly, weekly, and top stores.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales channel:</span>
        {channels.map((c) => {
          const on = active.has(c)
          return (
            <button
              key={c}
              onClick={() => toggle(c)}
              className={[
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                on ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {c}
            </button>
          )
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="This month" value={fmt(thisM)} />
        <StatTile
          label="Last month"
          value={fmt(lastM)}
          sub={monthly.length >= 2 ? `${delta >= 0 ? "▲" : "▼"} ${fmt(Math.abs(delta))} vs this month` : undefined}
          accent={monthly.length >= 2 ? (delta >= 0 ? "text-emerald-300" : "text-rose-300") : undefined}
        />
        <StatTile label="Last 7 days" value={fmt(last7)} />
        <StatTile label="Active channels" value={activeLabel} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Monthly activations" subtitle="Trading stores · last 13 months">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="label" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Weekly activations" subtitle="Trading stores · last 26 weeks">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={weeklyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="label" tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Top stores by activations" subtitle="This month vs last · top 20 for selected channels">
        {topRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">#</th>
                  <th className="py-2 pr-2 font-medium">Store</th>
                  <th className="py-2 pr-2 text-right font-medium">This month</th>
                  <th className="py-2 pr-2 text-right font-medium">Last month</th>
                  <th className="py-2 pr-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {topRows.map((r, i) => {
                  const d = r.this_month - r.last_month
                  return (
                    <tr key={r.tenant} className="border-b border-border/50">
                      <td className="py-1.5 pr-2 text-muted-foreground">{i + 1}</td>
                      <td className="py-1.5 pr-2 text-foreground">{r.tenant}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-emerald-300">{fmt(r.this_month)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-sky-300">{fmt(r.last_month)}</td>
                      <td className={`py-1.5 pr-2 text-right font-mono ${d >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{d >= 0 ? "+" : ""}{fmt(d)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">No store data for the selected channels.</p>
        )}
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Baked snapshot. The PBI map doesn&apos;t define how trading-store sales channels (F2F / Telesales / Digital / OTHER)
        are classified from source, so this stays on the snapshot rather than risk mis-bucketing a live channel split.
      </p>
    </div>
  )
}
