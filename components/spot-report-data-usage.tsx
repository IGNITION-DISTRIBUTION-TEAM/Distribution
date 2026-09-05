"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { SpotReportPlaceholder } from "@/components/spot-report-placeholder"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type Row = { tenant: string; month: string; megs: number; activeUsers: number }
type Payload = { hasData: boolean; rows: Row[]; months: string[]; dataThrough: string | null; error?: string }

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
// MEGS_USED is megabytes. Convert to GB for display; show TB above 1000 GB.
const toGB = (megs: number) => megs / 1024
const cgb = (gb: number) => {
  if (gb === 0) return "0"
  if (Math.abs(gb) >= 1_000_000) return `${(gb / 1_000_000).toFixed(1)}PB`
  if (Math.abs(gb) >= 1_000) return `${(gb / 1_000).toFixed(1)}TB`
  if (Math.abs(gb) >= 1) return `${gb.toFixed(1)}GB`
  return `${(gb * 1024).toFixed(0)}MB`
}
const TOP_N = 8

export function SpotReportDataUsage() {
  const chartMotion = useChartMotion()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetch("/api/spot-report/data-usage")
      .then(async (r) => {
        const d = (await r.json()) as Payload
        if (!r.ok) throw new Error(d.error || `Failed (${r.status})`)
        setData(d)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])
  const monthOpts = useMemo(() => data?.months ?? [], [data])
  const { range, setRange, inRange } = useMonthRange(monthOpts)

  if (loading && !data) {
    return <SkeletonReport charts={4} chartHeight={300} />
  }
  if (error) {
    return <Banner tone="error" className="m-6"><span>{error}</span></Banner>
  }

  // No usage returned (view not granted yet, or genuinely empty) → honest placeholder.
  if (!data || !data.hasData || data.rows.length === 0) {
    return (
      <SpotReportPlaceholder
        title="Data Usage by Tenant"
        subtitle="Data volume and active data users by tenant."
        note="No data usage returned. This reads VW_UC_USAGE (per-account CDR usage) joined to UCONNECT_MAY_MERGE. If it stays empty, the app's Snowflake role likely needs SELECT on UCONNECT_DW.ANALYTICS.VW_UC_USAGE — see scripts/spot-report.sql."
        kpis={["Total data volume", "Active data users", "Avg per user", "Tenants with usage"]}
        charts={["Data volume by tenant", "Active data users by tenant", "Data usage trend (6 months)", "Data per user by tenant"]}
      />
    )
  }

  const months = data.months.filter((m) => inRange(m))
  const latest = months[months.length - 1]
  const rows = data.rows.filter((r) => inRange(r.month))

  // Latest-month totals per tenant.
  const latestRows = rows.filter((r) => r.month === latest)
  const byTenant = new Map<string, { megs: number; users: number }>()
  for (const r of latestRows) {
    const t = byTenant.get(r.tenant) ?? { megs: 0, users: 0 }
    t.megs += r.megs
    t.users += r.activeUsers
    byTenant.set(r.tenant, t)
  }
  const ranked = Array.from(byTenant.entries())
    .map(([tenant, v]) => ({ tenant, ...v }))
    .sort((a, b) => b.megs - a.megs)
  const top = ranked.slice(0, TOP_N)
  const rest = ranked.slice(TOP_N)
  if (rest.length) {
    top.push({
      tenant: `Other (${rest.length})`,
      megs: rest.reduce((a, r) => a + r.megs, 0),
      users: rest.reduce((a, r) => a + r.users, 0),
    })
  }

  const totalMegs = latestRows.reduce((a, r) => a + r.megs, 0)
  const totalUsers = latestRows.reduce((a, r) => a + r.activeUsers, 0)
  const avgGbPerUser = totalUsers > 0 ? toGB(totalMegs) / totalUsers : 0

  const volByTenant = top.map((t) => ({ tenant: t.tenant, "Data (GB)": Math.round(toGB(t.megs)) }))
  const usersByTenant = top.map((t) => ({ tenant: t.tenant, "Active users": t.users }))
  const perUserByTenant = top
    .map((t) => ({ tenant: t.tenant, "GB / user": t.users > 0 ? Number((toGB(t.megs) / t.users).toFixed(2)) : 0 }))
    .sort((a, b) => b["GB / user"] - a["GB / user"])

  // Total data volume by month (trend), in GB.
  const trendMap = new Map<string, number>()
  for (const r of rows) trendMap.set(r.month, (trendMap.get(r.month) ?? 0) + r.megs)
  const trend = months.map((m) => ({ month: monthLabel(m), "Data (GB)": Math.round(toGB(trendMap.get(m) ?? 0)) }))

  const tenantAxisWidth = 130

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Data Usage by Tenant</PageHeading>
            <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">● Live · Snowflake</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Data volume and active data users by tenant.</p>
          {data.dataThrough && (
            <p className="mt-1 text-xs text-muted-foreground">
              Usage through <span className="font-medium text-foreground">{monthLabel(data.dataThrough)}</span> (latest month may be partial)
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={monthOpts} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={`Data volume · ${monthLabel(latest)}`} value={cgb(toGB(totalMegs))} sub="latest month" />
        <StatTile label="Active data users" value={fmt(totalUsers)} sub="accounts with data" />
        <StatTile label="Avg per user" value={cgb(avgGbPerUser)} />
        <StatTile label="Tenants with usage" value={String(ranked.length)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Data volume by tenant" subtitle={`${monthLabel(latest)} · top ${TOP_N} · GB`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={volByTenant} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => cgb(Number(v))} />
              <YAxis type="category" dataKey="tenant" tick={axisTick} axisLine={false} tickLine={false} width={tenantAxisWidth} />
              <RTooltip content={<ChartTip suffix=" GB" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Data (GB)" fill={BLUE} radius={[0, 3, 3, 0]} maxBarSize={22} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Active data users by tenant" subtitle={`${monthLabel(latest)} · top ${TOP_N}`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={usersByTenant} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="tenant" tick={axisTick} axisLine={false} tickLine={false} width={tenantAxisWidth} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Active users" fill={SERIES[1]} radius={[0, 3, 3, 0]} maxBarSize={22} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Data usage trend" subtitle="Total data volume by month (rolling 6 months) · GB">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={64} tickFormatter={(v) => cgb(Number(v))} />
            <RTooltip content={<ChartTip suffix=" GB" />} />
            <Line type="monotone" dataKey="Data (GB)" stroke={BLUE} strokeWidth={2} dot={false} {...chartMotion} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Data per user by tenant" subtitle={`${monthLabel(latest)} · data intensity · GB`}>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={perUserByTenant} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="tenant" tick={axisTick} axisLine={false} tickLine={false} width={tenantAxisWidth} />
            <RTooltip content={<ChartTip suffix=" GB" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            <Bar dataKey="GB / user" fill={SERIES[3]} radius={[0, 3, 3, 0]} maxBarSize={22} {...chartMotion} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Live from Snowflake (VW_UC_USAGE × UCONNECT_MAY_MERGE, MASTER_TENANT = uConnect). Active data user = an account
        with any data usage in the month. Volumes are MEGS_USED converted to GB (÷1024).
      </p>
    </ReportPage>
  )
}
