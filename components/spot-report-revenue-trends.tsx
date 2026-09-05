"use client"

import { useEffect, useState } from "react"
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BLUE, SERIES, axisTick, MONTHS, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"

type Monthly = { month: string; total: number; cellc: number; voucher: number; app: number; billrun: number; postpaid: number }
type Payload = { monthly: Monthly[]; tenant_revenue: { tenant: string; revenue: number }[] }

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
function rand(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `R ${(n / 1_000_000_000).toFixed(2)}bn`
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

const STREAMS: { key: keyof Monthly; label: string }[] = [
  { key: "cellc", label: "Cell C" },
  { key: "voucher", label: "Vouchers" },
  { key: "app", label: "App" },
  { key: "postpaid", label: "Postpaid" },
  { key: "billrun", label: "Bill run" },
]

export function SpotReportRevenueTrends({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/37_revenue_trends.json", override)
  const [rev, setRev] = useState<{ monthly: { month: string; revenue: number }[]; dataThrough: string | null; uploadedAt: string | null } | null>(null)
  useEffect(() => {
    if (override) return
    fetch("/api/spot-report/exco-revenue")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.hasData) setRev({ monthly: d.monthly_revenue, dataThrough: d.dataThrough ?? null, uploadedAt: d.uploadedAt ?? null }) })
      .catch(() => {})
  }, [override])
  const revLive = !!rev

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  // Total revenue by month: live income statement when available, else snapshot.
  const totalsSource: { month: string; total: number }[] = revLive
    ? rev!.monthly.map((r) => ({ month: r.month, total: r.revenue }))
    : data.monthly.map((r) => ({ month: r.month, total: r.total }))
  const totalsForChart = totalsSource.slice(-14)
  const totalData = totalsForChart.map((r) => ({ month: monthLabel(r.month), Revenue: Math.round(r.total) }))
  const ltm = totalsSource.slice(-12).reduce((a, r) => a + r.total, 0)
  const latest = totalsSource[totalsSource.length - 1]

  // Streams (snapshot). Keep only streams with any non-zero value.
  const activeStreams = STREAMS.filter((s) => data.monthly.some((m) => (m[s.key] as number) > 0))
  const streamData = data.monthly.map((m) => {
    const row: Record<string, number | string> = { month: monthLabel(m.month) }
    for (const s of activeStreams) row[s.label] = Math.round(m[s.key] as number)
    return row
  })

  // Cumulative for the latest calendar year (from the totals series).
  const latestYear = latest ? latest.month.slice(0, 4) : ""
  let run = 0
  const cumData = totalsSource
    .filter((r) => r.month.startsWith(latestYear))
    .map((r) => { run += r.total; return { month: monthLabel(r.month), Cumulative: Math.round(run) } })

  const tenantData = [...data.tenant_revenue].sort((a, b) => b.revenue - a.revenue)

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Revenue Trends</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${revLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {revLive ? "● Total live · income statement" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Revenue over time — total, by stream, and cumulative.</p>
          {revLive && rev!.dataThrough && (
            <p className="mt-1 text-xs text-muted-foreground">
              Income statement: data through <span className="font-medium text-foreground">{monthLabel(rev!.dataThrough)}</span>
              {rev!.uploadedAt ? ` · uploaded ${rev!.uploadedAt}` : ""}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="LTM revenue" value={rand(ltm)} sub={revLive ? "live · income statement" : undefined} accent={revLive ? "text-emerald-300" : undefined} />
        <StatTile label="Latest month" value={latest ? rand(latest.total) : "—"} />
        <StatTile label="Revenue streams" value={String(activeStreams.length)} />
        <StatTile label="Top tenant" value={tenantData[0] ? tenantData[0].tenant : "—"} sub={tenantData[0] ? rand(tenantData[0].revenue) : undefined} />
      </div>

      <ChartCard
        title="Total revenue by month"
        subtitle={revLive ? `Live · income statement (ZAR)${rev!.dataThrough ? ` · through ${monthLabel(rev!.dataThrough)}` : ""}` : "Last 14 months (ZAR) · snapshot"}
      >
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={totalData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60} tickFormatter={(v) => rand(Number(v))} />
            <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            <Bar dataKey="Revenue" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Revenue by stream" subtitle="Monthly · snapshot">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={streamData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} />
              <RTooltip content={<ChartTip />} />
              {activeStreams.map((s, i) => (
                <Line key={s.label} type="monotone" dataKey={s.label} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <Legend items={activeStreams.map((s, i) => ({ label: s.label, color: SERIES[i % SERIES.length] }))} />
        </ChartCard>

        <ChartCard title={`Cumulative revenue — ${latestYear}`} subtitle={revLive ? "From live totals" : "From snapshot totals"}>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={cumData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="revcum" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES[1]} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={SERIES[1]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={60} tickFormatter={(v) => rand(Number(v))} />
              <RTooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="Cumulative" stroke={SERIES[1]} strokeWidth={2} fill="url(#revcum)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {!revLive && (
        <p className="text-xs text-muted-foreground">
          Showing the baked snapshot. Upload the income statement (Financials → Upload) to make total &amp; cumulative
          revenue live; the per-stream split stays on the snapshot (the map doesn&apos;t define the stream breakdown as a query).
        </p>
      )}
    </div>
  )
}
