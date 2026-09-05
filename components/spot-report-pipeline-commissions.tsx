"use client"

import { useMemo } from "react"
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"
import { Info, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SERIES, BLUE, axisTick, fmt, StatTile, ChartCard, ChartTip, Legend, useReportData } from "@/components/spot-report-kit"
import { PageHeading } from "@/components/kit/heading"
import { Banner } from "@/components/kit/banner"

type Row = { stage: string; sort: number; category: string; count: number }
type Payload = { snapshot_date: string; rows: Row[]; uploadedAt?: string | null; uploadedBy?: string | null }

const WON = "Live and Trading"
const LOST = "Not interested or deal lost"


export function SpotReportPipelineCommissions({ override }: { override?: Payload } = {}) {
  const { data, live, loading, error, reload } = useReportData<Payload>("/api/spot-report/pipeline", "/spot-report/data/13_pipeline_commissions.json", override)

  const model = useMemo(() => {
    if (!data) return null
    const rows = data.rows
    const stageSort = new Map<string, number>()
    const stageTotal = new Map<string, number>()
    const catTotal = new Map<string, number>()
    for (const r of rows) {
      stageSort.set(r.stage, r.sort)
      stageTotal.set(r.stage, (stageTotal.get(r.stage) ?? 0) + r.count)
      catTotal.set(r.category, (catTotal.get(r.category) ?? 0) + r.count)
    }
    const stagesAsc = Array.from(stageTotal.keys()).sort((a, b) => (stageSort.get(a)! - stageSort.get(b)!))
    const cats = Array.from(catTotal.keys()).sort((a, b) => (catTotal.get(b)! - catTotal.get(a)!))

    const total = rows.reduce((a, r) => a + r.count, 0)
    const won = stageTotal.get(WON) ?? 0
    const lost = stageTotal.get(LOST) ?? 0
    const active = total - won - lost
    const winRate = won + lost ? (won / (won + lost)) * 100 : 0

    // Pipeline by stage, drawn as a centered CSS funnel (bar width ∝ count,
    // centred) in progression order. fill: won green, lost red, else blue.
    const maxStage = Math.max(1, ...stagesAsc.map((s) => stageTotal.get(s) ?? 0))
    const byStage = stagesAsc.map((s) => {
      const value = stageTotal.get(s) ?? 0
      return { name: s, value, fill: s === WON ? SERIES[1] : s === LOST ? SERIES[4] : BLUE }
    })
    // Pipeline by category.
    const byCat = cats.map((c) => ({ category: c, count: catTotal.get(c) ?? 0 }))
    // Stage x category stacked (stages as rows).
    const cell = new Map<string, number>()
    for (const r of rows) cell.set(`${r.stage}|${r.category}`, r.count)
    const stacked = stagesAsc.map((s) => {
      const row: Record<string, string | number> = { stage: s }
      for (const c of cats) row[c] = cell.get(`${s}|${c}`) ?? 0
      return row
    })
    // Win rate by category (won / won+lost).
    const winByCat = cats
      .map((c) => {
        const w = cell.get(`${WON}|${c}`) ?? 0
        const l = cell.get(`${LOST}|${c}`) ?? 0
        return { category: c, won: w, lost: l, rate: w + l ? Math.round((w / (w + l)) * 1000) / 10 : null }
      })
      .filter((r) => r.rate != null)
      .sort((a, b) => (b.rate! - a.rate!)) as { category: string; won: number; lost: number; rate: number }[]

    return { total, won, lost, active, winRate, byStage, maxStage, byCat, cats, stacked, winByCat }
  }, [data])

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  if (error || !data || !model) return <Banner tone="error" className="m-6"><span>{error ?? "No data"}</span></Banner>

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <PageHeading>Pipeline &amp; Provisional Commissions</PageHeading>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${live ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300"}`}>
              {live ? "● Uploaded · Snowflake" : "● Snapshot"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">BDM new-business pipeline by stage and category — counts only.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>

      {live ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            From the uploaded BDM pipeline workbook{data.uploadedAt ? <> · uploaded <b>{data.uploadedAt}</b></> : null}
            {data.uploadedBy ? ` by ${data.uploadedBy}` : ""}. <b>Provisional commissions still aren&apos;t shown</b> — the
            workbook has no Rand-value or commission column, only pipeline-stage counts.
          </span>
        </div>
      ) : (
        <Banner tone="warning">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Baked snapshot dated <b>{data.snapshot_date}</b> — no workbook uploaded yet. An admin can upload the current
            Pipeline.xlsx (Financials → Upload pipeline) to make this live. <b>Provisional commissions aren&apos;t shown</b>:
            this workbook has no Rand-value or commission column, only pipeline-stage counts.
          </span>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total pipeline" value={fmt(model.total)} sub="this snapshot" />
        <StatTile label="Active (in progress)" value={fmt(model.active)} sub="excl. won & lost" />
        <StatTile label="Live and trading (won)" value={fmt(model.won)} accent="text-emerald-300" />
        <StatTile label="Win rate" value={`${model.winRate.toFixed(1)}%`} sub={`${fmt(model.won)} won / ${fmt(model.lost)} lost`} accent={model.winRate >= 50 ? "text-emerald-300" : "text-amber-300"} />
      </div>

      <ChartCard title="Pipeline by stage" subtitle="Funnel · initial contact → live and trading (won green, lost red)">
        <div className="flex flex-col gap-1.5 py-1">
          {model.byStage.map((s) => (
            <div key={s.name} className="flex items-center gap-3" title={`${s.name}: ${fmt(s.value)}`}>
              <div className="w-52 shrink-0 text-right text-xs leading-tight text-muted-foreground">{s.name}</div>
              <div className="flex-1">
                <div
                  className="mx-auto flex h-7 items-center justify-end rounded"
                  style={{ width: `${Math.max((s.value / model.maxStage) * 100, 1.5)}%`, backgroundColor: s.fill }}
                />
              </div>
              <div className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{fmt(s.value)}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Point-in-time stage occupancy (deals currently at each stage), not a cumulative conversion funnel — so widths
          don&apos;t strictly narrow, and &ldquo;not interested / lost&rdquo; can exceed earlier stages.
        </p>
      </ChartCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Pipeline by category" subtitle="All stages">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={model.byCat} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="category" tick={axisTick} axisLine={false} tickLine={false} width={130} />
              <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
              <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={26} isAnimationActive={false}>
                <LabelList dataKey="count" position="right" style={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                {model.byCat.map((r, i) => (
                  <Cell key={r.category} fill={SERIES[i % SERIES.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Win rate by category" subtitle="Won ÷ (won + lost)">
          {model.winByCat.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={model.winByCat} layout="vertical" margin={{ top: 4, right: 44, bottom: 0, left: 8 }}>
                <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis type="number" domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="category" tick={axisTick} axisLine={false} tickLine={false} width={130} />
                <RTooltip content={<ChartTip suffix="%" />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
                <Bar dataKey="rate" radius={[0, 3, 3, 0]} maxBarSize={26} isAnimationActive={false}>
                  <LabelList dataKey="rate" position="right" formatter={(v: unknown) => `${Number(v).toFixed(0)}%`} style={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  {model.winByCat.map((r) => (
                    <Cell key={r.category} fill={r.rate >= 50 ? SERIES[1] : SERIES[2]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">No won/lost outcomes recorded yet.</div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Stage by category" subtitle="Stacked · where each category sits in the funnel">
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={model.stacked} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
            <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="stage" tick={axisTick} axisLine={false} tickLine={false} width={230} />
            <RTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.25 }} />
            {model.cats.map((c, i) => (
              <Bar key={c} dataKey={c} stackId="s" fill={SERIES[i % SERIES.length]} isAnimationActive={false} maxBarSize={26} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <Legend items={model.cats.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
      </ChartCard>

      <p className="text-xs text-muted-foreground">
        {live
          ? "Read from the uploaded BDM pipeline workbook (stored in Snowflake). Counts only — no decision-maker details, and the workbook carries no commission values."
          : "Baked snapshot — the source is a hand-maintained SharePoint workbook with no Snowflake feed, so it's kept current by admin upload (Financials → Upload pipeline) rather than a live query."}
      </p>
    </div>
  )
}
