"use client"

import { useMemo, useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import type { DateRange } from "react-day-picker"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, CalendarDays, Loader2, RefreshCw } from "lucide-react"
import {
  SERIES, axisTick, iso, parseIso, shortDay, fmt,
  StatTile, ChartCard, ChartTip, Legend, MultiSelect, useReportData,
} from "@/components/spot-report-kit"

type GroupDaily = { date: string; activations: number; active1_pct: number }
type Payload = { groups: { label: string; daily: GroupDaily[] }[] }

export function SpotReportSimActivations({ file, part, override }: { file: string; part: string; override?: Payload }) {
  const { data, live, loading, error, reload } = useReportData<Payload>(
    null, // no live endpoint yet — needs the original activations/active-1 query
    `/spot-report/data/${file}`,
    override
  )
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [range, setRange] = useState<DateRange | undefined>(undefined)
  const [calOpen, setCalOpen] = useState(false)

  const groups = useMemo(() => (data ? data.groups.map((g) => g.label) : []), [data])
  const active = selected ?? new Set(groups)
  const colorFor = (label: string) => SERIES[groups.indexOf(label) % SERIES.length]

  // All dates across selected groups.
  const dates = useMemo(() => {
    if (!data) return []
    const set = new Set<string>()
    for (const g of data.groups) if (active.has(g.label)) for (const r of g.daily) set.add(r.date)
    return Array.from(set).sort()
  }, [data, active])

  useEffect(() => {
    if (dates.length && !range) {
      setRange({ from: parseIso(dates[Math.max(0, dates.length - 45)]), to: parseIso(dates[dates.length - 1]) })
    }
  }, [dates, range])

  const inRange = (d: string) => {
    if (!range?.from) return true
    const t = parseIso(d).getTime()
    if (range.from && t < range.from.getTime()) return false
    if (range.to && t > range.to.getTime()) return false
    return true
  }
  const shownDates = dates.filter(inRange)

  // date -> group -> {activations, active1_pct}
  const lookup = useMemo(() => {
    const m = new Map<string, Map<string, GroupDaily>>()
    if (data) {
      for (const g of data.groups) {
        if (!active.has(g.label)) continue
        for (const r of g.daily) {
          if (!m.has(r.date)) m.set(r.date, new Map())
          m.get(r.date)!.set(g.label, r)
        }
      }
    }
    return m
  }, [data, active])

  const selGroups = groups.filter((g) => active.has(g))

  const activationsData = shownDates.map((d) => {
    const row: Record<string, number | string> = { date: d }
    for (const g of selGroups) row[g] = lookup.get(d)?.get(g)?.activations ?? 0
    return row
  })
  const utilData = shownDates.map((d) => {
    const row: Record<string, number | string> = { date: d }
    for (const g of selGroups) {
      const v = lookup.get(d)?.get(g)?.active1_pct
      row[g] = v == null ? 0 : Math.round(v * 1000) / 10
    }
    return row
  })

  // KPIs across selected groups.
  const kpis = useMemo(() => {
    if (dates.length === 0) return null
    const totalOn = (d: string) => selGroups.reduce((a, g) => a + (lookup.get(d)?.get(g)?.activations ?? 0), 0)
    const last = dates[dates.length - 1]
    const today = totalOn(last)
    const last7 = dates.slice(-7).reduce((a, d) => a + totalOn(d), 0)
    const lastD = parseIso(last)
    const mk = `${lastD.getFullYear()}-${String(lastD.getMonth() + 1).padStart(2, "0")}`
    const thisMonth = dates.filter((d) => d.slice(0, 7) === mk).reduce((a, d) => a + totalOn(d), 0)
    // Latest-day activation-weighted average active-1 %.
    let wSum = 0, w = 0
    for (const g of selGroups) {
      const r = lookup.get(last)?.get(g)
      if (r) { wSum += (r.active1_pct ?? 0) * r.activations; w += r.activations }
    }
    const util = w > 0 ? (wSum / w) * 100 : 0
    return { today, last7, thisMonth, util }
  }, [dates, selGroups, lookup])

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }
  if (error) {
    return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
  }

  const rangeLabel = range?.from && range?.to ? `${shortDay(iso(range.from))} – ${shortDay(iso(range.to))}` : "All dates"
  const legendItems = selGroups.map((g) => ({ label: g, color: colorFor(g) }))

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">New SIM Activations &amp; Utilisation {part}</h2>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Daily activations and first-month utilisation by tenant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      {kpis && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Activations today" value={fmt(kpis.today)} />
          <StatTile label="Last 7 days" value={fmt(kpis.last7)} />
          <StatTile label="This month" value={fmt(kpis.thisMonth)} />
          <StatTile label="Active-1 % (latest)" value={`${kpis.util.toFixed(1)}%`} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Filters:</span>
        <MultiSelect all={groups} selected={active} onChange={setSelected} noun="tenants" />
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm"><CalendarDays className="mr-2 h-4 w-4" />{rangeLabel}</Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar mode="range" selected={range} onSelect={setRange} numberOfMonths={2} defaultMonth={range?.from} />
            <div className="flex justify-end gap-2 border-t border-border p-2">
              <Button variant="ghost" size="sm" onClick={() => setRange(undefined)}>All dates</Button>
              <Button size="sm" onClick={() => setCalOpen(false)}>Done</Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <ChartCard title="Daily activations by tenant" subtitle={rangeLabel}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={activationsData} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="date" tickFormatter={shortDay} tick={axisTick} tickLine={false} minTickGap={24} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
            <RTooltip content={<ChartTip fmtLabel={shortDay} />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            {selGroups.map((g, i) => (
              <Bar key={g} dataKey={g} stackId="a" fill={colorFor(g)} radius={i === selGroups.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <Legend items={legendItems} />
      </ChartCard>

      <ChartCard title="First-month utilisation (active-1 %)" subtitle="Share of activations still active in month 1">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={utilData} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="date" tickFormatter={shortDay} tick={axisTick} tickLine={false} minTickGap={24} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} />
            <RTooltip content={<ChartTip fmtLabel={shortDay} suffix="%" />} />
            {selGroups.map((g) => (
              <Line key={g} type="monotone" dataKey={g} stroke={colorFor(g)} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <Legend items={legendItems} />
      </ChartCard>

      {!live && (
        <p className="text-xs text-muted-foreground">
          Showing the baked snapshot. Live wiring for this page needs the original activations/active-1 query
          (see docs/telco-pbi-page-table-map.md) — the map lists its source but not the derived active-1 definition.
        </p>
      )}
    </div>
  )
}
