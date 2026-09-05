"use client"

import { useMemo } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, AMBER, SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, useReportData, useMonthRange, MonthRangeControl } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"
import { ReportPage } from "@/components/kit/page"

type Payload = {
  kpis: { this_month: number; last_month: number; last_7: number; early_churn: number }
  monthly_churn: { month: string; terminated: number }[]
  churn_reasons: { reason: string; count: number }[]
  age_at_churn: { band: string; count: number }[]
}
const monthLabel = (s: string) => { const [y, m] = s.split("-"); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}` }

export function SpotReportWastage({ override }: { override?: Payload } = {}) {
  const chartMotion = useChartMotion()
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/17_wastage.json", override)
  const months = useMemo(() => (data ? Array.from(new Set(data.monthly_churn.map((r) => String(r.month)))).sort() : []), [data])
  const { range, setRange, inRange } = useMonthRange(months)
  if (loading && !data) return <SkeletonReport charts={3} chartHeight={300} />
  if (error || !data) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  const k = data.kpis
  const monthly = data.monthly_churn.filter((r) => inRange(String(r.month))).map((r) => ({ month: monthLabel(r.month), Terminated: r.terminated }))
  const ages = data.age_at_churn.map((r) => ({ band: r.band, Count: r.count }))
  const reasons = [...data.churn_reasons].sort((a, b) => b.count - a.count).slice(0, 10)
  const reasonsMeaningful = reasons.length > 1 || (reasons[0] && reasons[0].reason.toLowerCase() !== "unknown")

  return (
    <ReportPage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Wastage</PageHeading>
            <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Subscription terminations — volume, recency and age at churn.</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthRangeControl months={months} range={range} onChange={setRange} />
          <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Terminated this month" value={fmt(k.this_month)} sub="MTD" />
        <StatTile label="Terminated last month" value={fmt(k.last_month)} />
        <StatTile label="Last 7 days" value={fmt(k.last_7)} />
        <StatTile label="Early churn ≤30d" value={fmt(k.early_churn)} sub="prev 2 months" accent="text-amber-300" />
      </div>

      <ChartCard title="Monthly terminations" subtitle="Last 13 months · snapshot">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={monthly} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
            <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            <Bar dataKey="Terminated" fill={SERIES[4]} radius={[3, 3, 0, 0]} {...chartMotion} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Age at churn" subtitle="Distribution · snapshot">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={ages} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="band" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Count" fill={BLUE} radius={[3, 3, 0, 0]} {...chartMotion} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Churn reasons" subtitle="Last 6 months · snapshot">
          {reasonsMeaningful ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={reasons.map((r) => ({ reason: r.reason, Count: r.count }))} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
                <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="reason" tick={axisTick} axisLine={false} tickLine={false} width={160} />
                <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
                <Bar dataKey="Count" fill={AMBER} radius={[0, 3, 3, 0]} maxBarSize={22} {...chartMotion} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[280px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
              <p>Churn reasons aren&apos;t captured in the source.</p>
              <p className="text-xs">{reasons[0] ? `All ${fmt(reasons[0].count)} terminations are recorded as "${reasons[0].reason}".` : "No reason data."}</p>
            </div>
          )}
        </ChartCard>
      </div>

      <p className="text-xs text-muted-foreground">Baked snapshot from the terminations/churn source. Churn-reason capture is largely &quot;Unknown&quot; in source, so that breakdown is limited.</p>
    </ReportPage>
  )
}
