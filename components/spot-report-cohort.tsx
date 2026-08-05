"use client"

import { useMemo } from "react"
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, axisTick, MONTHS, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"

type ChannelRow = { month: string; channel: string; billed: number; paid: number }
type CohortRow = { acquired_month: string; billing_month: string; billed: number }
type Payload = { monthly_by_channel: ChannelRow[]; cohort: CohortRow[] }

const monthLabel = (s: string) => {
  const [y, m] = s.split("-")
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`
}
const agingMonths = (acq: string, bill: string) => {
  const [ay, am] = acq.split("-").map(Number)
  const [by, bm] = bill.split("-").map(Number)
  return (by - ay) * 12 + (bm - am)
}

export function SpotReportCohort({ override }: { override?: Payload } = {}) {
  const { data, loading, error, reload } = useReportData<Payload>(null, "/spot-report/data/15_subscriptions_cohort.json", override)

  const model = useMemo(() => {
    if (!data) return null
    // Monthly billed by channel (stacked).
    const months = Array.from(new Set(data.monthly_by_channel.map((r) => r.month))).sort()
    const channels = Array.from(new Set(data.monthly_by_channel.map((r) => r.channel)))
    const cell = new Map<string, number>()
    for (const r of data.monthly_by_channel) cell.set(`${r.month}|${r.channel}`, r.billed)
    const stacked = months.map((m) => {
      const row: Record<string, string | number> = { month: monthLabel(m) }
      for (const c of channels) row[c] = cell.get(`${m}|${c}`) ?? 0
      return row
    })
    const totalBilled = data.monthly_by_channel.reduce((a, r) => a + r.billed, 0)
    const totalPaid = data.monthly_by_channel.reduce((a, r) => a + r.paid, 0)

    // Cohort: acquired month rows × aging (months since acquisition) columns.
    const acqMonths = Array.from(new Set(data.cohort.map((r) => r.acquired_month))).sort()
    const grid = new Map<string, number>() // `${acq}|${aging}` -> billed
    let maxAging = 0
    let maxBilled = 0
    for (const r of data.cohort) {
      const a = agingMonths(r.acquired_month, r.billing_month)
      if (a < 0) continue
      maxAging = Math.max(maxAging, a)
      maxBilled = Math.max(maxBilled, r.billed)
      grid.set(`${r.acquired_month}|${a}`, (grid.get(`${r.acquired_month}|${a}`) ?? 0) + r.billed)
    }
    const agings = Array.from({ length: maxAging + 1 }, (_, i) => i)

    return { months, channels, stacked, totalBilled, totalPaid, acqMonths, grid, agings, maxBilled }
  }, [data])

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !model) return <div className="m-6 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error ?? "No data"}</span></div>

  const collectionRate = model.totalBilled > 0 ? (model.totalPaid / model.totalBilled) * 100 : 0

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">Subscriptions Cohort Analysis</h2>
            <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">● Snapshot</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Billed subscriptions by channel, and a cohort retention heatmap by acquisition month.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Total billed" value={fmt(model.totalBilled)} sub="across window" />
        <StatTile label="Total paid" value={fmt(model.totalPaid)} sub="across window" />
        <StatTile label="Collection rate" value={`${collectionRate.toFixed(1)}%`} sub="paid ÷ billed" accent={collectionRate >= 50 ? "text-emerald-300" : "text-amber-300"} />
      </div>

      <ChartCard title="Monthly billed subscriptions by channel" subtitle="Snapshot">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={model.stacked} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis dataKey="month" tick={axisTick} tickLine={false} minTickGap={8} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} width={56} />
            <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            {model.channels.map((c, i) => (
              <Bar key={c} dataKey={c} stackId="ch" fill={SERIES[i % SERIES.length]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <Legend items={model.channels.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>

      <ChartCard title="Cohort retention heatmap" subtitle="Billed count · rows = acquisition month · columns = months since acquisition · snapshot">
        <div className="overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 3 }}>
            <thead>
              <tr>
                <th className="px-2 py-1 text-right text-[11px] font-medium text-muted-foreground">Acquired</th>
                {model.agings.map((a) => (
                  <th key={a} className="px-1 py-1 text-center text-[11px] font-medium text-muted-foreground" style={{ minWidth: 40 }}>M{a}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.acqMonths.map((acq) => (
                <tr key={acq}>
                  <td className="whitespace-nowrap px-2 py-1 text-right text-[11px] text-foreground">{monthLabel(acq)}</td>
                  {model.agings.map((a) => {
                    const v = model.grid.get(`${acq}|${a}`)
                    if (v == null) return <td key={a} />
                    const ratio = model.maxBilled > 0 ? v / model.maxBilled : 0
                    const alpha = 0.14 + 0.78 * ratio
                    return (
                      <td
                        key={a}
                        className="rounded text-center text-[10px] font-medium tabular-nums"
                        style={{
                          minWidth: 40,
                          padding: "6px 4px",
                          backgroundColor: `rgba(25,158,112,${alpha.toFixed(3)})`,
                          color: ratio > 0.45 ? "#0b1220" : "hsl(var(--foreground))",
                        }}
                        title={`${monthLabel(acq)} · M${a}: ${fmt(v)} billed`}
                      >
                        {fmt(v)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Each row is an acquisition cohort; M0 is the acquisition month, M1 the next month, and so on. Cell = billed count,
          shaded by volume.
        </p>
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        Baked snapshot. The cohort/billing source (DATAWAREHOUSE.BILLING.COHORTSUCONNECT and the billing channel view) isn&apos;t
        granted and the measures are PBI-defined, so this isn&apos;t wired live. Channels shown are the raw billing CHANNEL
        values (the original&apos;s per-channel Telesales/App cohort split was never resolved in source).
      </p>
    </div>
  )
}
