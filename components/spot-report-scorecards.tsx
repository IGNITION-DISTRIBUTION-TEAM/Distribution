"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, AMBER, axisTick, MONTHS, shortDay, iso, parseIso, fmt, StatTile, ChartCard, ChartTip } from "@/components/spot-report-kit"

type Quality = {
  active_1_count: number; total_sims: number; active_1_pct: number
  sims_never_used: number; registered_base_35_60: number
  qos_proxy_pct: number; sims_never_used_pct: number
}
type Scorecard = {
  name: string
  monthly: { month: string; activations: number }[]
  daily: { date: string; activations: number }[]
  quality: Quality
  ros_7day: number | null
  ros_threshold: number | null
  wastage_rate: number | null
  stores: { tenant: string; this_month: number; last_month: number }[]
}

// Store group → snapshot file (public/spot-report/data, gated by middleware).
const STORES: { label: string; file: string }[] = [
  { label: "Spar", file: "03_spar_scorecard.json" },
  { label: "Build It", file: "04_build_it_scorecard.json" },
  { label: "Mica", file: "05_mica_scorecard.json" },
  { label: "Pet Pool & Home", file: "06_pet_pool_scorecard.json" },
  { label: "Aheers", file: "07_aheers_scorecard.json" },
  { label: "Fashion Fusion", file: "08_fashion_fusion_scorecard.json" },
  { label: "Progas", file: "09_progas_scorecard.json" },
  { label: "Midas", file: "10_midas_scorecard.json" },
]

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`)
const rand = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

// Fill gaps in the daily series and add a trailing 7-day rolling average.
function dailyWithRolling(daily: { date: string; activations: number }[]) {
  if (!daily.length) return [] as { date: string; value: number; rolling: number }[]
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const map = new Map(sorted.map((r) => [r.date, r.activations]))
  const start = parseIso(sorted[0].date)
  const end = parseIso(sorted[sorted.length - 1].date)
  const dense: { date: string; value: number }[] = []
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = iso(d)
    dense.push({ date: k, value: map.get(k) ?? 0 })
  }
  return dense.map((r, i) => {
    const window = dense.slice(Math.max(0, i - 6), i + 1)
    const avg = window.reduce((a, x) => a + x.value, 0) / window.length
    return { ...r, rolling: Math.round(avg * 10) / 10 }
  })
}

export function SpotReportScorecards({ overrides }: { overrides?: Record<string, Scorecard> } = {}) {
  const [store, setStore] = useState(STORES[0].label)
  const [cache, setCache] = useState<Record<string, Scorecard>>(overrides ?? {})
  const [loading, setLoading] = useState(!overrides)
  const [error, setError] = useState<string | null>(null)

  const current = STORES.find((s) => s.label === store)!

  const load = () => {
    if (overrides) return
    if (cache[store]) return
    setLoading(true)
    setError(null)
    fetch(`/spot-report/data/${current.file}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load ${current.label} (${r.status})`)
        const d = (await r.json()) as Scorecard
        setCache((c) => ({ ...c, [store]: d }))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [store]) // eslint-disable-line react-hooks/exhaustive-deps

  const data = cache[store]

  const dailyData = useMemo(() => {
    if (!data) return []
    return dailyWithRolling(data.daily)
      .slice(-90)
      .map((r) => ({ date: shortDay(r.date), Daily: r.value, "7-day avg": r.rolling }))
  }, [data])

  const selector = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Store:</span>
      {STORES.map((s) => {
        const on = s.label === store
        return (
          <button
            key={s.label}
            onClick={() => setStore(s.label)}
            className={[
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              on ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {s.label}
          </button>
        )
      })}
    </div>
  )

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold text-foreground">Store Scorecards</h2>
          <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Activation volume and SIM quality per store group.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => { setCache((c) => { const n = { ...c }; delete n[store]; return n }); }}>
        <RefreshCw className="mr-2 h-4 w-4" /> Refresh
      </Button>
    </div>
  )

  if (loading && !data) {
    return <div className="flex flex-col gap-5 p-6">{header}{selector}<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading {store}…</div></div>
  }
  if (error && !data) {
    return <div className="flex flex-col gap-5 p-6">{header}{selector}<div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div></div>
  }
  if (!data) return <div className="flex flex-col gap-5 p-6">{header}{selector}</div>

  const monthly = data.monthly
  const thisM = monthly.length ? monthly[monthly.length - 1].activations : 0
  const lastM = monthly.length >= 2 ? monthly[monthly.length - 2].activations : 0
  const delta = thisM - lastM
  const q = data.quality
  const monthlyData = monthly.map((r) => ({ month: monthLabel(r.month), Activations: r.activations }))
  const storeRows = [...data.stores].sort((a, b) => b.this_month - a.this_month)
  const wastageCost = data.wastage_rate != null ? q.sims_never_used * data.wastage_rate : null

  return (
    <div className="flex flex-col gap-5 p-6">
      {header}
      {selector}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="This month" value={fmt(thisM)} sub="activations · MTD" />
        <StatTile
          label="Last month"
          value={fmt(lastM)}
          sub={monthly.length >= 2 ? `${delta >= 0 ? "▲" : "▼"} ${fmt(Math.abs(delta))} vs this month` : undefined}
          accent={monthly.length >= 2 ? (delta >= 0 ? "text-emerald-300" : "text-rose-300") : undefined}
        />
        <StatTile label="Active 1%" value={pct(q.active_1_pct)} sub="used SIM within 30 days" />
        <StatTile label="SIMs never used (35–60d)" value={fmt(q.sims_never_used)} sub={`${pct(q.sims_never_used_pct)} of base`} accent="text-amber-300" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="QoS proxy" value={pct(q.qos_proxy_pct)} sub="quality of sales (proxy)" />
        <StatTile label="Total SIMs" value={fmt(q.total_sims)} sub={`${fmt(q.active_1_count)} active-1`} />
        <StatTile
          label="ROS 7-day avg"
          value={data.ros_7day != null ? data.ros_7day.toFixed(1) : "—"}
          sub={data.ros_7day != null && data.ros_threshold != null ? (data.ros_7day < data.ros_threshold ? `below target (${data.ros_threshold})` : `on target (${data.ros_threshold})`) : "not built for this store"}
          accent={data.ros_7day != null && data.ros_threshold != null ? (data.ros_7day < data.ros_threshold ? "text-rose-300" : "text-emerald-300") : undefined}
        />
        <StatTile label="Cost of wastage" value={wastageCost != null ? rand(wastageCost) : "—"} sub={wastageCost != null ? "never-used SIMs" : "no wastage rate"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title={`Daily activations & 7-day avg — ${data.name}`} subtitle="Last 90 days · snapshot">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={dailyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={24} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Daily" fill={BLUE} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Line dataKey="7-day avg" stroke={SERIES[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={`Monthly activations — ${data.name}`} subtitle="Last 13 months · snapshot">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={AMBER} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Store performance" subtitle={`${data.name} · this month vs last · ${storeRows.length} stores`}>
        {storeRows.length ? (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 font-medium">#</th>
                  <th className="py-2 pr-2 font-medium">Store</th>
                  <th className="py-2 pr-2 text-right font-medium">This month</th>
                  <th className="py-2 pr-2 text-right font-medium">Last month</th>
                  <th className="py-2 pr-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {storeRows.map((r, i) => {
                  const d = r.this_month - r.last_month
                  return (
                    <tr key={`${r.tenant}-${i}`} className="border-b border-border/50">
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
          <p className="py-6 text-center text-sm text-muted-foreground">No store data for {data.name}.</p>
        )}
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Baked snapshot per store group. Activation volume, Active-1%, SIMs-never-used and ROS come from the snapshot; the
        original per-store QoS/ROS/voucher columns and cohort-revenue panels were never wired to a source, so they&apos;re
        omitted rather than shown as empty placeholders.
      </p>
    </div>
  )
}
