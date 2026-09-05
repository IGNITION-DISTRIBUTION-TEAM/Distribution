"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw, DatabaseZap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"
import { SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type ChannelRow = { month: string; channel: string; billed: number; paid: number }
type CohortRow = { acquired_month: string; billing_month: string; billed: number }
type Snapshot = { monthly_by_channel: ChannelRow[]; cohort: CohortRow[] }

type Live = {
  hasData: true
  refreshedAt: string | null
  totalSales: number
  totalRevenue: number
  monthly_by_channel: { month: string; channel: string; sales: number }[]
  cohort: { cohort: string; aging: number; active: number; m0Sales: number }[]
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const agingMonths = (acq: string, bill: string) => {
  const [ay, am] = acq.split("-").map(Number)
  const [by, bm] = bill.split("-").map(Number)
  return (by - ay) * 12 + (bm - am)
}
const rand = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

export function SpotReportCohort({ override }: { override?: Snapshot } = {}) {
  const chartMotion = useChartMotion()
  const { user } = useAuth()
  const { data: snap, loading, error, reload } = useReportData<Snapshot>(null, "/spot-report/data/15_subscriptions_cohort.json", override)

  const [live, setLive] = useState<Live | null>(null)
  const [liveLoading, setLiveLoading] = useState(!override)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  const loadLive = useCallback(async () => {
    if (override) { setLiveLoading(false); return }
    try {
      const r = await fetch("/api/spot-report/cohort")
      const d = r.ok ? await r.json() : null
      setLive(d?.hasData ? (d as Live) : null)
    } catch {
      setLive(null)
    } finally {
      setLiveLoading(false)
    }
  }, [override])
  useEffect(() => { loadLive() }, [loadLive])

  const refresh = async () => {
    setRefreshing(true)
    setRefreshMsg("Starting rebuild…")
    try {
      const r = await fetch("/api/spot-report/cohort-refresh", { method: "POST" })
      const d = await r.json()
      if (!r.ok || !d.handle) throw new Error(d.error || `Could not start (${r.status})`)
      setRefreshMsg("Rebuilding cohort table in Snowflake… (~1–2 min, runs in the background)")
      for (let i = 0; i < 90; i++) {
        await new Promise((res) => setTimeout(res, 5000))
        const sr = await fetch(`/api/spot-report/cohort-refresh?handle=${encodeURIComponent(d.handle)}`)
        const sd = await sr.json()
        if (sd.status === "done") {
          setRefreshMsg("Done — loading latest…")
          await loadLive()
          setRefreshing(false)
          setRefreshMsg(null)
          return
        }
        if (sd.status === "error") throw new Error(sd.error || "Refresh failed")
      }
      throw new Error("Timed out waiting for the rebuild")
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : String(e))
      setRefreshing(false)
    }
  }

  // ── Live model (from materialised SPOT_COHORT) ──────────────────────────
  const liveModel = useMemo(() => {
    if (!live) return null
    const months = Array.from(new Set(live.monthly_by_channel.map((r) => r.month))).sort()
    const channels = Array.from(new Set(live.monthly_by_channel.map((r) => r.channel)))
    const cell = new Map<string, number>()
    for (const r of live.monthly_by_channel) cell.set(`${r.month}|${r.channel}`, r.sales)
    const stacked = months.map((m) => {
      const row: Record<string, string | number> = { month: monthLabel(m) }
      for (const c of channels) row[c] = cell.get(`${m}|${c}`) ?? 0
      return row
    })
    const cohortMonths = Array.from(new Set(live.cohort.map((r) => r.cohort))).sort()
    let maxAging = 0
    const grid = new Map<string, { active: number; pct: number }>()
    for (const r of live.cohort) {
      maxAging = Math.max(maxAging, r.aging)
      const pct = r.m0Sales > 0 ? (r.active / r.m0Sales) * 100 : 0
      grid.set(`${r.cohort}|${r.aging}`, { active: r.active, pct })
    }
    const agings = Array.from({ length: maxAging + 1 }, (_, i) => i)
    return { months, channels, stacked, cohortMonths, agings, grid }
  }, [live])

  // ── Snapshot model ───────────────────────────────────────────────────────
  const snapModel = useMemo(() => {
    if (!snap) return null
    const months = Array.from(new Set(snap.monthly_by_channel.map((r) => r.month))).sort()
    const channels = Array.from(new Set(snap.monthly_by_channel.map((r) => r.channel)))
    const cell = new Map<string, number>()
    for (const r of snap.monthly_by_channel) cell.set(`${r.month}|${r.channel}`, r.billed)
    const stacked = months.map((m) => {
      const row: Record<string, string | number> = { month: monthLabel(m) }
      for (const c of channels) row[c] = cell.get(`${m}|${c}`) ?? 0
      return row
    })
    const totalBilled = snap.monthly_by_channel.reduce((a, r) => a + r.billed, 0)
    const totalPaid = snap.monthly_by_channel.reduce((a, r) => a + r.paid, 0)
    const acqMonths = Array.from(new Set(snap.cohort.map((r) => r.acquired_month))).sort()
    const grid = new Map<string, number>()
    let maxAging = 0
    let maxBilled = 0
    for (const r of snap.cohort) {
      const a = agingMonths(r.acquired_month, r.billing_month)
      if (a < 0) continue
      maxAging = Math.max(maxAging, a)
      maxBilled = Math.max(maxBilled, r.billed)
      grid.set(`${r.acquired_month}|${a}`, (grid.get(`${r.acquired_month}|${a}`) ?? 0) + r.billed)
    }
    return { months, channels, stacked, totalBilled, totalPaid, acqMonths, grid, agings: Array.from({ length: maxAging + 1 }, (_, i) => i), maxBilled }
  }, [snap])

  if ((loading || liveLoading) && !snap) return <SkeletonReport tiles={6} charts={4} chartHeight={320} />
  if (error && !live) return <Banner tone="error" className="m-6"><span>{error}</span></Banner>

  const isLive = !!live && !!liveModel

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <PageHeading>Subscriptions Cohort Analysis</PageHeading>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
            {isLive ? "● Live · Snowflake" : "● Snapshot"}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {isLive ? "Sales by campaign and a cohort retention heatmap (active base ÷ cohort size)." : "Billed subscriptions by channel and a cohort retention heatmap by acquisition month."}
        </p>
        {isLive && live!.refreshedAt && <p className="mt-1 text-xs text-muted-foreground">Data as of <span className="font-medium text-foreground">{live!.refreshedAt}</span></p>}
      </div>
      <div className="flex items-center gap-2">
        {user?.isSuperAdmin && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DatabaseZap className="mr-2 h-4 w-4" />}
            {isLive ? "Rebuild" : "Build live"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => { reload(); loadLive() }}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>
    </div>
  )

  const refreshBanner = refreshMsg && (
    <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-200">
      {refreshing ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{refreshMsg}</span>
    </div>
  )

  // ── LIVE render ────────────────────────────────────────────────────────
  if (isLive) {
    const m = liveModel!
    return (
      <ReportPage>
        {header}
        {refreshBanner}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Total sales (cohorts)" value={fmt(live!.totalSales)} sub="live" accent="text-emerald-300" />
          <StatTile label="Total revenue" value={rand(live!.totalRevenue)} sub="live" accent="text-emerald-300" />
          <StatTile label="Campaigns" value={String(m.channels.length)} />
        </div>

        <ChartCard title="Sales by campaign" subtitle="Monthly · live · Snowflake">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={m.stacked} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              {m.channels.map((c, i) => (
                <Bar key={c} dataKey={c} stackId="ch" fill={SERIES[i % SERIES.length]} {...chartMotion} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <Legend items={m.channels.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
        </ChartCard>

        <ChartCard title="Cohort retention heatmap" subtitle="% of cohort still active (active base ÷ cohort sales) · rows = acquisition month · M0..Mn · live">
          <div className="overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th className="px-2 py-1 text-right text-[11px] font-medium text-muted-foreground">Cohort</th>
                  {m.agings.map((a) => (<th key={a} className="px-1 py-1 text-center text-[11px] font-medium text-muted-foreground" style={{ minWidth: 40 }}>M{a}</th>))}
                </tr>
              </thead>
              <tbody>
                {m.cohortMonths.map((cm) => (
                  <tr key={cm}>
                    <td className="whitespace-nowrap px-2 py-1 text-right text-[11px] text-foreground">{monthLabel(cm)}</td>
                    {m.agings.map((a) => {
                      const v = m.grid.get(`${cm}|${a}`)
                      if (v == null) return <td key={a} />
                      const ratio = Math.min(v.pct / 100, 1)
                      const alpha = 0.14 + 0.78 * ratio
                      return (
                        <td key={a} className="rounded text-center text-[10px] font-medium tabular-nums" style={{ minWidth: 40, padding: "6px 4px", backgroundColor: `rgba(25,158,112,${alpha.toFixed(3)})`, color: ratio > 0.45 ? "#0b1220" : "hsl(var(--foreground))" }} title={`${monthLabel(cm)} · M${a}: ${v.pct.toFixed(1)}% (${fmt(v.active)} active)`}>
                          {v.pct.toFixed(0)}%
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Each row is an acquisition cohort; cells show the % of that cohort&apos;s sales still active at each month of age (M0 = acquisition month).</p>
        </ChartCard>

        <p className="text-xs text-muted-foreground">
          Live from Snowflake — materialised from VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES (a ~90s 5-way join) into a
          compact table on refresh, so the page loads instantly. {user?.isSuperAdmin ? "Use “Rebuild” to re-run the source query in the background." : "An admin can rebuild it from the latest source."}
        </p>
      </ReportPage>
    )
  }

  // ── SNAPSHOT render ──────────────────────────────────────────────────────
  if (!snapModel) return <div className="m-6 text-sm text-muted-foreground">No data.</div>
  const s = snapModel
  const collectionRate = s.totalBilled > 0 ? (s.totalPaid / s.totalBilled) * 100 : 0
  return (
    <ReportPage>
      {header}
      {refreshBanner}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Total billed" value={fmt(s.totalBilled)} sub="across window" />
        <StatTile label="Total paid" value={fmt(s.totalPaid)} sub="across window" />
        <StatTile label="Collection rate" value={`${collectionRate.toFixed(1)}%`} sub="paid ÷ billed" accent={collectionRate >= 50 ? "text-emerald-300" : "text-amber-300"} />
      </div>

      <ChartCard title="Monthly billed subscriptions by channel" subtitle="Snapshot">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={s.stacked} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
            <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            {s.channels.map((c, i) => (<Bar key={c} dataKey={c} stackId="ch" fill={SERIES[i % SERIES.length]} {...chartMotion} />))}
          </BarChart>
        </ResponsiveContainer>
        <Legend items={s.channels.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>

      <ChartCard title="Cohort retention heatmap" subtitle="Billed count · rows = acquisition month · columns = months since acquisition · snapshot">
        <div className="overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 3 }}>
            <thead>
              <tr>
                <th className="px-2 py-1 text-right text-[11px] font-medium text-muted-foreground">Acquired</th>
                {s.agings.map((a) => (<th key={a} className="px-1 py-1 text-center text-[11px] font-medium text-muted-foreground" style={{ minWidth: 40 }}>M{a}</th>))}
              </tr>
            </thead>
            <tbody>
              {s.acqMonths.map((acq) => (
                <tr key={acq}>
                  <td className="whitespace-nowrap px-2 py-1 text-right text-[11px] text-foreground">{monthLabel(acq)}</td>
                  {s.agings.map((a) => {
                    const v = s.grid.get(`${acq}|${a}`)
                    if (v == null) return <td key={a} />
                    const ratio = s.maxBilled > 0 ? v / s.maxBilled : 0
                    const alpha = 0.14 + 0.78 * ratio
                    return (
                      <td key={a} className="rounded text-center text-[10px] font-medium tabular-nums" style={{ minWidth: 40, padding: "6px 4px", backgroundColor: `rgba(25,158,112,${alpha.toFixed(3)})`, color: ratio > 0.45 ? "#0b1220" : "hsl(var(--foreground))" }} title={`${monthLabel(acq)} · M${a}: ${fmt(v)} billed`}>
                        {fmt(v)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Each row is an acquisition cohort; M0 is the acquisition month, M1 the next, and so on. Cell = billed count, shaded by volume.</p>
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Snapshot. {user?.isSuperAdmin ? "Click “Build live” to materialise the live cohort view in the background (~1–2 min), then the page switches to live campaign sales + retention." : "An admin can build the live version from the cohort source."} The live view is richer (real campaigns, active-base retention, revenue).
      </p>
    </ReportPage>
  )
}
