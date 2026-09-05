"use client"

import { useEffect, useState } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, LabelList, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"
import { SkeletonReport } from "@/components/kit/skeleton"

type Monthly = { month: string; reward_qty: number; reward_value: number }
type Payload = {
  monthly: Monthly[]
  retention_by_reward: { group: string; total: number; still_active: number }[]
  revenue_per_recipient: { month: string; recipients: number; recipient_revenue: number }[]
}

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const rand = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

export function SpotReportRetainUsers({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/40_retain_users_airtime.json", override)
  const [live, setLive] = useState<{ monthly: Monthly[]; dataThrough: string | null } | null>(null)
  useEffect(() => {
    if (override) return
    fetch("/api/spot-report/retain-users")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.hasData && Array.isArray(d.monthly) && d.monthly.length) setLive({ monthly: d.monthly, dataThrough: d.dataThrough ?? null }) })
      .catch(() => {})
  }, [override])
  const rewardsLive = !!live

  if (loading && !data) return <SkeletonReport charts={4} chartHeight={280} />
  if (error || !data) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  // Monthly reward series: live when available, else snapshot.
  const monthly = rewardsLive ? live!.monthly : data.monthly
  const qtyData = monthly.map((r) => ({ month: monthLabel(r.month), Qty: r.reward_qty }))
  const valData = monthly.map((r) => ({ month: monthLabel(r.month), Value: Math.round(r.reward_value) }))
  // The campaign is intermittent (many zero months, incl. the trailing one), so
  // anchor the headline KPIs to the latest month that actually paid rewards
  // rather than a possibly-empty "current" month.
  const latestActive = [...monthly].reverse().find((r) => r.reward_qty > 0) ?? null
  const totalQty = monthly.reduce((a, r) => a + r.reward_qty, 0)
  const totalSpend = monthly.reduce((a, r) => a + r.reward_value, 0)

  // Retention (snapshot): % still active, recipients vs no reward.
  const retention = data.retention_by_reward.map((r) => ({
    group: r.group,
    pct: r.total > 0 ? Math.round((r.still_active / r.total) * 1000) / 10 : 0,
    total: r.total,
    still: r.still_active,
  }))
  const recip = retention.find((r) => /reward recipient/i.test(r.group))
  const noReward = retention.find((r) => /no reward/i.test(r.group))
  const lift = recip && noReward ? Math.round((recip.pct - noReward.pct) * 10) / 10 : null

  // Revenue per recipient (snapshot).
  const roi = data.revenue_per_recipient
    .filter((r) => r.recipients > 0)
    .map((r) => ({ month: monthLabel(r.month), "R / recipient": Math.round(r.recipient_revenue / r.recipients) }))

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Retain Users via Free Airtime</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${rewardsLive ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {rewardsLive ? "● Rewards live · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Free-airtime retention rewards — volume, spend, and downstream retention.</p>
          {rewardsLive && live!.dataThrough && (
            <p className="mt-1 text-xs text-muted-foreground">
              Rewards through <span className="font-medium text-foreground">{monthLabel(live!.dataThrough)}</span> (latest month may be partial)
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Latest reward month (qty)"
          value={latestActive ? fmt(latestActive.reward_qty) : "—"}
          sub={latestActive ? monthLabel(latestActive.month) : undefined}
        />
        <StatTile
          label="Reward value that month"
          value={latestActive ? rand(latestActive.reward_value) : "—"}
          sub={latestActive ? monthLabel(latestActive.month) : undefined}
        />
        <StatTile label="Rewards paid (13M qty)" value={fmt(totalQty)} />
        <StatTile label="Total reward spend (13M)" value={rand(totalSpend)} sub={rewardsLive ? "live" : "snapshot"} accent={rewardsLive ? "text-emerald-300" : undefined} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Free airtime rewards paid" subtitle={`Monthly qty (13 months) · ${rewardsLive ? "live" : "snapshot"}`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={qtyData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Qty" fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Free airtime reward value" subtitle={`Monthly (ZAR) · ${rewardsLive ? "live" : "snapshot"}`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={valData} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="Value" fill={BLUE} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard
          title="Retention: reward recipients vs no reward"
          subtitle={lift != null ? `Recipients ${lift >= 0 ? "+" : ""}${lift}pp still active · snapshot` : "% still active · snapshot"}
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={retention} margin={{ top: 16, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis dataKey="group" tick={axisTick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} domain={[0, 100]} width={40} tickFormatter={(v) => `${v}%`} />
              <RTooltip content={<ChartTip suffix="%" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="pct" radius={[3, 3, 0, 0]} maxBarSize={90} isAnimationActive={false}>
                <LabelList dataKey="pct" position="top" formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} style={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                {retention.map((r) => (
                  <Cell key={r.group} fill={/reward recipient/i.test(r.group) ? SERIES[1] : SERIES[2]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">
            &ldquo;Still active&rdquo; = usage in the last 7 days (VW_ACTIVE_SUBSCRIPTIONS_USAGE_DETAILS).
          </p>
        </ChartCard>

        <ChartCard title="Revenue per reward recipient" subtitle="Same-month non-reward revenue ÷ recipients · snapshot">
          {roi.length ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={roi} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => rand(Number(v))} />
                <RTooltip content={<ChartTip />} />
                <Line type="monotone" dataKey="R / recipient" stroke={SERIES[3]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">No recipient-revenue months in the snapshot.</div>
          )}
        </ChartCard>
      </div>

      <p className="text-xs text-muted-foreground">
        Monthly reward qty &amp; value {rewardsLive ? "are live from Snowflake" : "show the baked snapshot"} (VW_SC_TRANSACTION_REPORT,
        retentions sub-wallet, free-airtime bundle benefits). Retention and revenue-per-recipient stay on the snapshot — the
        map doesn&apos;t fully define those as queries.
      </p>
    </div>
  )
}
