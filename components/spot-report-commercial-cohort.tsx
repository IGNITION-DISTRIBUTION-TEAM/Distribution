"use client"

import { useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, DatabaseZap, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"
import { SERIES, BLUE, AMBER, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"

type Payload = {
  acquisitions: { month: string; acquired: number; still_active: number }[]
  revenue_per_cohort: { month: string; revenue: number; accounts: number }[]
  channel_by_month: { month: string; channel: string; count: number }[]
  cohort_aging: { cohort_month: string; age_months: number; acquired: number; active: number; revenue: number }[]
  refreshedAt?: string | null
}
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }
const rand = (n: number) => (Math.abs(n) >= 1e6 ? `R ${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `R ${(n / 1e3).toFixed(0)}K` : `R ${Math.round(n)}`)

export function SpotReportCommercialCohort({ override }: { override?: Payload } = {}) {
  const { user } = useAuth()
  const { data, live, loading, error, reload } = useReportData<Payload>("/api/spot-report/commercial-cohort", "/spot-report/data/16_commercial_cohort.json", override)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  const rebuild = async () => {
    setRefreshing(true); setRefreshMsg("Starting rebuild…")
    try {
      const r = await fetch("/api/spot-report/cohort-refresh", { method: "POST" })
      const d = await r.json()
      if (!r.ok || !d.handle) throw new Error(d.error || `Could not start (${r.status})`)
      setRefreshMsg("Rebuilding cohort table in Snowflake… (~1–2 min, in the background)")
      for (let i = 0; i < 90; i++) {
        await new Promise((res) => setTimeout(res, 5000))
        const sr = await fetch(`/api/spot-report/cohort-refresh?handle=${encodeURIComponent(d.handle)}`)
        const sd = await sr.json()
        if (sd.status === "done") { setRefreshMsg("Done — loading latest…"); reload(); setRefreshing(false); setRefreshMsg(null); return }
        if (sd.status === "error") throw new Error(sd.error || "Refresh failed")
      }
      throw new Error("Timed out waiting for the rebuild")
    } catch (e) { setRefreshMsg(e instanceof Error ? e.message : String(e)); setRefreshing(false) }
  }

  const monthOpts = useMemo(() => (data ? Array.from(new Set(data.acquisitions.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(monthOpts)
  const model = useMemo(() => {
    if (!data) return null
    const acqRows = data.acquisitions.filter((r) => inRange(String(r.month)))
    const revRows = data.revenue_per_cohort.filter((r) => inRange(String(r.month)))
    const chRows = data.channel_by_month.filter((r) => inRange(String(r.month)))
    const agingRows = data.cohort_aging.filter((r) => inRange(String(r.cohort_month)))
    const acq = acqRows.map((r) => ({ month: monthLabel(r.month), Acquired: r.acquired, "Still active": r.still_active, ret: r.acquired > 0 ? (r.still_active / r.acquired) * 100 : 0 }))
    const arpu = revRows.map((r) => ({ month: monthLabel(r.month), ARPU: r.accounts > 0 ? Math.round(r.revenue / r.accounts) : 0 }))
    const chMonths = Array.from(new Set(chRows.map((r) => r.month))).sort()
    const channels = Array.from(new Set(chRows.map((r) => r.channel)))
    const cell = new Map<string, number>()
    for (const r of chRows) cell.set(`${r.month}|${r.channel}`, r.count)
    const chStacked = chMonths.map((m) => { const row: Record<string, string | number> = { month: monthLabel(m) }; for (const c of channels) row[c] = cell.get(`${m}|${c}`) ?? 0; return row })
    // Retention heatmap from aging.
    const cohorts = Array.from(new Set(agingRows.map((r) => r.cohort_month))).sort()
    let maxAge = 0
    const grid = new Map<string, number>()
    for (const r of agingRows) { maxAge = Math.max(maxAge, r.age_months); const pct = r.acquired > 0 ? (r.active / r.acquired) * 100 : 0; grid.set(`${r.cohort_month}|${r.age_months}`, pct) }
    const ages = Array.from({ length: maxAge + 1 }, (_, i) => i)
    const totalAcq = acqRows.reduce((a, r) => a + r.acquired, 0)
    const totalActive = acqRows.reduce((a, r) => a + r.still_active, 0)
    return { acq, arpu, channels, chStacked, cohorts, ages, grid, totalAcq, totalActive }
  }, [data, inRange])

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !model) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  const overallRet = model.totalAcq > 0 ? (model.totalActive / model.totalAcq) * 100 : 0
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Commercial Cohort Analysis</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">SIM acquisition, retention and revenue by cohort month.</p>
          {live && data.refreshedAt && <p className="mt-1 text-xs text-muted-foreground">Data as of <span className="font-medium text-foreground">{data.refreshedAt}</span></p>}
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={monthOpts} range={range} onChange={setRange} />
          {user?.isSuperAdmin && (
            <Button variant="outline" size="sm" onClick={rebuild} disabled={refreshing}>
              {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DatabaseZap className="mr-2 h-4 w-4" />}
              {live ? "Rebuild" : "Build live"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>
      {refreshMsg && (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-200">
          {refreshing ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{refreshMsg}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Total acquired" value={fmt(model.totalAcq)} />
        <StatTile label="Still active" value={fmt(model.totalActive)} />
        <StatTile label="Overall retention" value={`${overallRet.toFixed(1)}%`} accent={overallRet >= 30 ? "text-emerald-300" : "text-amber-300"} />
        <StatTile label="Cohorts tracked" value={String(model.cohorts.length)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Acquired vs still active" subtitle="By cohort month · snapshot">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={model.acq} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Acquired" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="Still active" fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <Legend items={[{ label: "Acquired", color: BLUE }, { label: "Still active", color: SERIES[1] }]} />
        </ChartCard>

        <ChartCard title="SIM retention rate" subtitle="Still active ÷ acquired · by cohort month">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={model.acq} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <RTooltip content={<ChartTip suffix="%" />} />
              <Line type="monotone" dataKey="ret" name="Retention" stroke={SERIES[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Avg revenue per acquired SIM" subtitle="By cohort month · snapshot">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={model.arpu} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="ARPU" fill={AMBER} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Acquisitions by channel" subtitle="Stacked · snapshot">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={model.chStacked} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={52} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              {model.channels.map((c, i) => (<Bar key={c} dataKey={c} stackId="ch" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />))}
            </BarChart>
          </ResponsiveContainer>
          <Legend items={model.channels.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
        </ChartCard>
      </div>

      <ChartCard title="Cohort retention heatmap" subtitle="% still active (active ÷ acquired) · rows = cohort month · M0..Mn · snapshot">
        <div className="overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 3 }}>
            <thead><tr><th className="px-2 py-1 text-right text-[11px] font-medium text-muted-foreground">Cohort</th>{model.ages.map((a) => (<th key={a} className="px-1 py-1 text-center text-[11px] font-medium text-muted-foreground" style={{ minWidth: 40 }}>M{a}</th>))}</tr></thead>
            <tbody>
              {model.cohorts.map((cm) => (
                <tr key={cm}>
                  <td className="whitespace-nowrap px-2 py-1 text-right text-[11px] text-foreground">{monthLabel(cm)}</td>
                  {model.ages.map((a) => { const v = model.grid.get(`${cm}|${a}`); if (v == null) return <td key={a} />; const ratio = Math.min(v / 100, 1); const alpha = 0.14 + 0.78 * ratio; return <td key={a} className="rounded text-center text-[10px] font-medium tabular-nums" style={{ minWidth: 40, padding: "6px 4px", backgroundColor: `rgba(25,158,112,${alpha.toFixed(3)})`, color: ratio > 0.45 ? "#0b1220" : "hsl(var(--foreground))" }} title={`${monthLabel(cm)} · M${a}: ${v.toFixed(1)}%`}>{v.toFixed(0)}%</td> })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        {live
          ? "Live from Snowflake — materialised from the cohort view (VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES) into SPOT_COHORT on rebuild, shared with the subscriptions cohort page."
          : "Snapshot. Runs off the same cohort source as the subscriptions cohort — an admin can “Build live” to materialise it in the background."}
      </p>
    </div>
  )
}
