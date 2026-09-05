"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import type { DateRange } from "react-day-picker"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts"
import { CalendarDays, Check, ChevronsUpDown, Loader2, RefreshCw, Search } from "lucide-react"
import { Banner } from "@/components/kit/banner"
import { Card } from "@/components/ui/card"
import { StatTile, ChartCard, ChartTip } from "@/components/spot-report-kit"

// Validated dark categorical steps (contrast + CVD checked against the app card
// surface earlier this session). Activations = blue; the 7-day average
// reference line = amber (a highly separable pair).
const BLUE = "#3987e5"
const AMBER = "#c98500"
const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 11 }

type Daily = { date: string; activations: number }
type ByGroup = { date: string; group: string; activations: number }
type Payload = {
  daily: Daily[]
  daily_by_group: ByGroup[]
  defined_groups: string[]
  _live?: boolean
}

const pad = (n: number) => String(n).padStart(2, "0")
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d)
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const shortDay = (s: string) => {
  const [, m, d] = s.split("-")
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`
}
function mondayOf(s: string): string {
  const d = parseIso(s)
  const dow = (d.getDay() + 6) % 7 // Mon=0
  d.setDate(d.getDate() - dow)
  return iso(d)
}

function fmt(n: number): string {
  return n.toLocaleString()
}


// Searchable checkbox multiselect for the tenant/group filter.
function GroupFilter({
  all,
  selected,
  onChange,
}: {
  all: string[]
  selected: Set<string>
  onChange: (s: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const shown = q ? all.filter((g) => g.toLowerCase().includes(q.toLowerCase())) : all
  const allOn = selected.size === all.length
  const toggle = (g: string) => {
    const next = new Set(selected)
    if (next.has(g)) next.delete(g)
    else next.add(g)
    onChange(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-56 justify-between">
          <span className="truncate">
            {allOn ? "All tenants" : selected.size === 0 ? "No tenants" : `${selected.size} of ${all.length} tenants`}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tenants…"
            className="w-full bg-transparent text-sm text-foreground outline-none"
          />
        </div>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
          <button className="text-primary hover:underline" onClick={() => onChange(new Set(all))}>
            Select all
          </button>
          <button className="text-muted-foreground hover:underline" onClick={() => onChange(new Set())}>
            Clear
          </button>
        </div>
        <div className="max-h-64 overflow-auto py-1">
          {shown.map((g) => {
            const on = selected.has(g)
            return (
              <button
                key={g}
                onClick={() => toggle(g)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border ${
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate text-foreground">{g}</span>
              </button>
            )
          })}
          {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------- Page ---------------------------------- */

export function SpotReportSalesTrends({ dataOverride }: { dataOverride?: Payload } = {}) {
  const [payload, setPayload] = useState<Payload | null>(dataOverride ?? null)
  const [live, setLive] = useState(!!dataOverride?._live)
  const [loading, setLoading] = useState(!dataOverride)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [range, setRange] = useState<DateRange | undefined>(undefined)
  const [calOpen, setCalOpen] = useState(false)

  const load = useCallback(async () => {
    if (dataOverride) return // preview/test mode — no fetch
    setLoading(true)
    setError(null)
    try {
      // Live-first, fall back to the baked snapshot.
      let data: Payload | null = null
      let isLive = false
      try {
        const r = await fetch("/api/spot-report/sales-trends")
        if (r.ok) {
          data = await r.json()
          isLive = !!data?._live
        }
      } catch {
        /* fall through */
      }
      if (!data) {
        const r = await fetch("/spot-report/data/01_sales_trends.json")
        data = await r.json()
      }
      setPayload(data)
      setLive(isLive)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [dataOverride])

  useEffect(() => {
    load()
  }, [load])

  // Groups present, ordered by the defined list then "Other Tenants".
  const groups = useMemo(() => {
    if (!payload) return []
    const present = new Set(payload.daily_by_group.map((r) => r.group))
    const ordered = payload.defined_groups.filter((g) => present.has(g))
    if (present.has("Other Tenants")) ordered.push("Other Tenants")
    return ordered
  }, [payload])

  const activeGroups = selected ?? new Set(groups)

  // Group-filtered daily total (full series, sorted).
  const byDate = useMemo(() => {
    const m = new Map<string, number>()
    if (payload) {
      for (const r of payload.daily_by_group) {
        if (!activeGroups.has(r.group)) continue
        m.set(r.date, (m.get(r.date) ?? 0) + r.activations)
      }
    }
    return m
  }, [payload, activeGroups])

  const sortedDates = useMemo(() => Array.from(byDate.keys()).sort(), [byDate])

  // 7-day trailing average over the full series.
  const rolling = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < sortedDates.length; i++) {
      const start = Math.max(0, i - 6)
      let sum = 0
      for (let j = start; j <= i; j++) sum += byDate.get(sortedDates[j]) ?? 0
      m.set(sortedDates[i], sum / (i - start + 1))
    }
    return m
  }, [sortedDates, byDate])

  // KPI cards (from full series, group-filtered).
  const kpis = useMemo(() => {
    if (sortedDates.length === 0) return null
    const last = sortedDates[sortedDates.length - 1]
    const today = byDate.get(last) ?? 0
    const last7 = sortedDates.slice(-7).reduce((a, d) => a + (byDate.get(d) ?? 0), 0)
    const lastD = parseIso(last)
    const thisKey = `${lastD.getFullYear()}-${pad(lastD.getMonth() + 1)}`
    const prev = new Date(lastD.getFullYear(), lastD.getMonth() - 1, 1)
    const prevKey = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`
    let thisMonth = 0
    let lastMonth = 0
    for (const d of sortedDates) {
      const k = d.slice(0, 7)
      if (k === thisKey) thisMonth += byDate.get(d) ?? 0
      else if (k === prevKey) lastMonth += byDate.get(d) ?? 0
    }
    return { today, last7, thisMonth, delta: thisMonth - lastMonth }
  }, [sortedDates, byDate])

  // Default the calendar range to the last 60 days once data loads.
  useEffect(() => {
    if (sortedDates.length && !range) {
      const to = parseIso(sortedDates[sortedDates.length - 1])
      const from = parseIso(sortedDates[Math.max(0, sortedDates.length - 60)])
      setRange({ from, to })
    }
  }, [sortedDates, range])

  const inRange = useCallback(
    (d: string) => {
      if (!range?.from) return true
      const t = parseIso(d).getTime()
      if (range.from && t < range.from.getTime()) return false
      if (range.to && t > range.to.getTime()) return false
      return true
    },
    [range]
  )

  const comboData = useMemo(
    () =>
      sortedDates
        .filter(inRange)
        .map((d) => ({ date: d, Activations: byDate.get(d) ?? 0, "7-day avg": Math.round((rolling.get(d) ?? 0) * 10) / 10 })),
    [sortedDates, inRange, byDate, rolling]
  )

  const last7Data = useMemo(
    () => sortedDates.slice(-7).map((d) => ({ date: d, Activations: byDate.get(d) ?? 0 })),
    [sortedDates, byDate]
  )

  const weeklyData = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of sortedDates) {
      const w = mondayOf(d)
      m.set(w, (m.get(w) ?? 0) + (byDate.get(d) ?? 0))
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-13)
      .map(([w, v]) => ({ week: w, Activations: v }))
  }, [sortedDates, byDate])

  const monthlyData = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of sortedDates) {
      const k = d.slice(0, 7)
      m.set(k, (m.get(k) ?? 0) + (byDate.get(d) ?? 0))
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-13)
      .map(([k, v]) => {
        const [y, mo] = k.split("-")
        return { month: `${MONTHS[Number(mo) - 1]} ${y.slice(2)}`, Activations: v }
      })
  }, [sortedDates, byDate])

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Sales Trends…
      </div>
    )
  }
  if (error) {
    return (
      <Banner tone="error" className="m-6">
        <span>{error}</span>
      </Banner>
    )
  }

  const rangeLabel =
    range?.from && range?.to
      ? `${shortDay(iso(range.from))} – ${shortDay(iso(range.to))}`
      : "All dates"

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Sales Trends</PageHeading>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                live
                  ? "bg-emerald-500/12 text-emerald-300"
                  : "bg-amber-500/12 text-amber-300"
              }`}
            >
              {live ? "● Live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Daily SIM activations by tenant.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {/* KPI cards */}
      {kpis && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Today" value={fmt(kpis.today)} />
          <StatTile label="Last 7 days" value={fmt(kpis.last7)} />
          <StatTile label="This month" value={fmt(kpis.thisMonth)} />
          <StatTile
            label="vs last month"
            value={`${kpis.delta >= 0 ? "+" : ""}${fmt(kpis.delta)}`}
            sub={kpis.delta >= 0 ? "up on last month" : "down on last month"}
            accent={kpis.delta >= 0 ? "text-emerald-300" : "text-rose-300"}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Filters:</span>
        <GroupFilter all={groups} selected={activeGroups} onChange={(s) => setSelected(s)} />
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <CalendarDays className="mr-2 h-4 w-4" />
              {rangeLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={2}
              defaultMonth={range?.from}
            />
            <div className="flex justify-end gap-2 border-t border-border p-2">
              <Button variant="ghost" size="sm" onClick={() => setRange(undefined)}>
                All dates
              </Button>
              <Button size="sm" onClick={() => setCalOpen(false)}>
                Done
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Main combo */}
      <ChartCard title="Daily activations & 7-day rolling average" subtitle={rangeLabel}>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={comboData} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="date" tickFormatter={shortDay} tick={axisTick} tickLine={false} minTickGap={28}
              axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
            <RTooltip content={<ChartTip fmtLabel={shortDay} />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
            <Line type="monotone" dataKey="7-day avg" stroke={AMBER} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: BLUE }} /> Activations</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: AMBER }} /> 7-day avg</span>
        </div>
      </ChartCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Last 7 days" subtitle="Daily activations">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={last7Data} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="date" tickFormatter={shortDay} tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
              <RTooltip content={<ChartTip fmtLabel={shortDay} />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Weekly activations" subtitle="Last 13 weeks">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weeklyData} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="week" tickFormatter={shortDay} tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
              <RTooltip content={<ChartTip fmtLabel={(s) => `Week of ${shortDay(s)}`} />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Monthly activations" subtitle="Last 13 months">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyData} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Daily activations" subtitle="Rolling 13 months (7-day avg)">
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart
              data={sortedDates.map((d) => ({ date: d, "7-day avg": Math.round(rolling.get(d) ?? 0) }))}
              margin={{ top: 6, right: 12, bottom: 0, left: -12 }}
            >
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="date" tickFormatter={shortDay} tick={axisTick} tickLine={false} minTickGap={40} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
              <RTooltip content={<ChartTip fmtLabel={shortDay} />} />
              <Line type="monotone" dataKey="7-day avg" stroke={BLUE} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  )
}
