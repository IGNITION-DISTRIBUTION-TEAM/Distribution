"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, LabelList, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, shortDay, fmt, StatTile, ChartCard, ChartTip, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type Snap = {
  kpis: { active7_30_35_pct: number; still_using_pct: number; quality_indicator_pct: number }
  daily: { date: string; activations: number; active1_pct: number }[]
}
type Tenant = { tenant: string; sales: number; using: number; qos: number }
type Live = { hasData: boolean; tenants: Tenant[]; totalSales: number; totalUsing: number; overallQos: number }

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const QOS_THRESHOLD = 0.5
const TOP_N = 12

export function SpotReportQualityOfSales({ override }: { override?: Snap } = {}) {
  const chartMotion = useChartMotion()
  const { data, loading, error, reload } = useReportData<Snap>(null, "/spot-report/data/02_quality_of_sales.json", override)
  const [live, setLive] = useState<Live | null>(null)
  useEffect(() => {
    if (override) return
    fetch("/api/spot-report/quality-of-sales")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.hasData && Array.isArray(d.tenants) && d.tenants.length) setLive(d) })
      .catch(() => {})
  }, [override])
  const tenantLive = !!live

  if (loading && !data) return <SkeletonReport charts={3} chartHeight={280} />
  if (error || !data) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  const daily = data.daily
  const asOf = daily.length ? daily[daily.length - 1].date : null
  const actData = daily.map((r) => ({ date: shortDay(r.date), Activations: r.activations }))
  const activeData = daily.map((r) => ({ date: shortDay(r.date), "Active 1%": Math.round(r.active1_pct * 1000) / 10 }))

  // Per-tenant QoS (live): top tenants by sales, rest folded into "Other".
  let tenantBars: { tenant: string; qosPct: number; sales: number; flagged: boolean }[] = []
  if (tenantLive) {
    const sorted = [...live!.tenants].sort((a, b) => b.sales - a.sales)
    const top = sorted.slice(0, TOP_N)
    const rest = sorted.slice(TOP_N)
    const mk = (t: Tenant) => ({ tenant: t.tenant, qosPct: Math.round(t.qos * 1000) / 10, sales: t.sales, flagged: t.qos < QOS_THRESHOLD })
    tenantBars = top.map(mk)
    if (rest.length) {
      const s = rest.reduce((a, r) => a + r.sales, 0)
      const u = rest.reduce((a, r) => a + r.using, 0)
      const q = s > 0 ? u / s : 0
      tenantBars.push({ tenant: `Other (${rest.length})`, qosPct: Math.round(q * 1000) / 10, sales: s, flagged: q < QOS_THRESHOLD })
    }
    // Order bars by QoS so best/worst read top-to-bottom.
    tenantBars.sort((a, b) => b.qosPct - a.qosPct)
  }

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Quality of Sales by Tenant</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tenantLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {tenantLive ? "● Tenant QoS live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Are recent sales actually using their SIMs? Quality of sales by tenant, plus cohort quality trend.</p>
          {asOf && <p className="mt-1 text-xs text-muted-foreground">Cohort trend as of <span className="font-medium text-foreground">{asOf}</span></p>}
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Quality of sales indicator" value={pct(data.kpis.quality_indicator_pct)} sub="cohort · snapshot" />
        <StatTile label="Still using after 1 month" value={pct(data.kpis.still_using_pct)} sub="cohort · snapshot" />
        <StatTile label="Active 7d after 1 month" value={pct(data.kpis.active7_30_35_pct)} sub="cohort · snapshot" />
        <StatTile
          label="Overall QoS (last 7 days)"
          value={tenantLive ? pct(live!.overallQos) : "—"}
          sub={tenantLive ? `${fmt(live!.totalUsing)} of ${fmt(live!.totalSales)} using · live` : "grant / no data"}
          accent={tenantLive ? (live!.overallQos >= QOS_THRESHOLD ? "text-emerald-300" : "text-amber-300") : undefined}
        />
      </div>

      {tenantLive ? (
        <ChartCard
          title="Quality of sales by tenant — last 7 days"
          subtitle="% of accounts activated in the last 7 days with real usage · bar label = sales count · amber below 50%"
        >
          <ResponsiveContainer width="100%" height={Math.max(240, tenantBars.length * 30 + 40)}>
            <BarChart data={tenantBars} layout="vertical" margin={{ top: 4, right: 44, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="tenant" tick={axisTick} axisLine={false} tickLine={false} width={140} />
              <RTooltip content={<ChartTip suffix="%" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="qosPct" radius={[0, 3, 3, 0]} maxBarSize={22} {...chartMotion}>
                <LabelList dataKey="sales" position="right" formatter={(v: unknown) => `n=${fmt(Number(v))}`} style={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                {tenantBars.map((t) => (
                  <Cell key={t.tenant} fill={t.flagged ? SERIES[2] : SERIES[1]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      ) : (
        <Banner tone="warning">
          <span>
            Per-tenant quality of sales is live from Snowflake (UCONNECT_MAY_MERGE × VW_UC_USAGE). It isn&apos;t showing —
            the query returned no rows. The cohort KPIs and trend below are the baked snapshot.
          </span>
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Daily activations" subtitle="Last 31 days · snapshot">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={actData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Activations" fill={BLUE} radius={[3, 3, 0, 0]} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Active 1% — used SIM within 30 days" subtitle="Last 31 days · snapshot · by activation day">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={activeData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={16} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <RTooltip content={<ChartTip suffix="%" />} />
              <Line type="monotone" dataKey="Active 1%" stroke={SERIES[3]} strokeWidth={2} dot={false} {...chartMotion} />
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">Recent days trend down because those activations haven&apos;t had a full 30 days to use yet (right-censored).</p>
        </ChartCard>
      </div>

      <p className="text-xs text-muted-foreground">
        Per-tenant quality of sales is live: of the accounts activated in the last 7 days, the share with any real usage
        (minutes/data/SMS/USSD/MMS) in that window. The map exposes only a tenant dimension — there&apos;s no per-store
        source — and the cohort KPIs/trend stay on the snapshot.
      </p>
    </ReportPage>
  )
}
