"use client"

// Shared building blocks for native Spot Report pages: validated dark palette,
// date helpers, stat tiles, chart card + tooltip, a searchable multiselect, and
// a live-first/snapshot-fallback data loader. Reused across report pages so they
// stay visually consistent with the app.

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Check, ChevronsUpDown, Search } from "lucide-react"

// Categorical steps validated for contrast + CVD against the app card surface.
export const SERIES = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767", "#d55181", "#008300", "#d95926"]
export const BLUE = SERIES[0]
export const AMBER = "#c98500"
export const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 11 }

export const pad = (n: number) => String(n).padStart(2, "0")
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export function parseIso(s: string) {
  const [y, m, d] = s.split("-").map(Number)
  return new Date(y, m - 1, d)
}
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export function shortDay(s: string): string {
  const [, m, d] = s.split("-")
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`
}
export function mondayOf(s: string): string {
  const d = parseIso(s)
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  return iso(d)
}
export const fmt = (n: number) => Math.round(n).toLocaleString()

// ── Month-range filter ─────────────────────────────────────────────────────
// Per-report month filter. `months` is a sorted list of month keys (any format
// that sorts lexically, e.g. "YYYY-MM-DD" or "YYYY-MM"). Defaults to the full
// span; inRange(m) trims a report's time-series to the picked window.
export type MonthRange = { from: string; to: string }
export function useMonthRange(months: string[]) {
  const [range, setRange] = useState<MonthRange | null>(null)
  useEffect(() => {
    if (!months.length) return
    setRange((prev) =>
      prev && months.includes(prev.from) && months.includes(prev.to) ? prev : { from: months[0], to: months[months.length - 1] }
    )
  }, [months])
  const inRange = useCallback((m: string) => !range || (m >= range.from && m <= range.to), [range])
  return { range, setRange, inRange }
}

export function MonthRangeControl({
  months,
  range,
  onChange,
}: {
  months: string[]
  range: MonthRange | null
  onChange: (r: MonthRange) => void
}) {
  if (months.length < 2 || !range) return null
  const label = (m: string) => {
    const [y, mo] = m.split("-")
    return `${MONTHS[Number(mo) - 1] ?? mo} ${(y ?? "").slice(2)}`
  }
  const sel = "rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span>Range</span>
      <select className={sel} value={range.from} onChange={(e) => onChange({ from: e.target.value, to: e.target.value > range.to ? e.target.value : range.to })}>
        {months.map((m) => (<option key={m} value={m}>{label(m)}</option>))}
      </select>
      <span aria-hidden>→</span>
      <select className={sel} value={range.to} onChange={(e) => onChange({ to: e.target.value, from: e.target.value < range.from ? e.target.value : range.from })}>
        {months.map((m) => (<option key={m} value={m}>{label(m)}</option>))}
      </select>
    </div>
  )
}

export function StatTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className={`mt-0.5 text-xs ${accent ?? "text-muted-foreground"}`}>{sub}</p>}
    </div>
  )
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-2">
        <h3 className="font-medium text-foreground">{title}</h3>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export function ChartTip({
  active,
  payload,
  label,
  fmtLabel,
  suffix,
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number | string; color?: string }[]
  label?: string | number
  fmtLabel?: (s: string) => string
  suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-foreground">{fmtLabel ? fmtLabel(String(label)) : String(label)}</p>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: String(p.color) }} />
          <span className="text-muted-foreground">{String(p.dataKey)}</span>
          <span className="ml-auto pl-3 font-mono text-foreground">
            {typeof p.value === "number" ? Math.round(p.value).toLocaleString() : String(p.value)}
            {suffix ?? ""}
          </span>
        </div>
      ))}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

export function MultiSelect({
  all,
  selected,
  onChange,
  noun = "items",
}: {
  all: string[]
  selected: Set<string>
  onChange: (s: Set<string>) => void
  noun?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const shown = q ? all.filter((g) => g.toLowerCase().includes(q.toLowerCase())) : all
  const allOn = selected.size === all.length
  const toggle = (g: string) => {
    const next = new Set(selected)
    if (next.has(g)) next.delete(g)
    else next.add(g)
    onChange(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-56 justify-between">
          <span className="truncate">
            {allOn ? `All ${noun}` : selected.size === 0 ? `No ${noun}` : `${selected.size} of ${all.length} ${noun}`}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${noun}…`}
            className="w-full bg-transparent text-sm text-foreground outline-none"
          />
        </div>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
          <button className="text-primary hover:underline" onClick={() => onChange(new Set(all))}>Select all</button>
          <button className="text-muted-foreground hover:underline" onClick={() => onChange(new Set())}>Clear</button>
        </div>
        <div className="max-h-64 overflow-auto py-1">
          {shown.map((g) => {
            const on = selected.has(g)
            return (
              <button key={g} onClick={() => toggle(g)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/40">
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="truncate text-foreground">{g}</span>
              </button>
            )
          })}
          {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Load a report payload live-first (from `liveUrl`) with a snapshot fallback
// (the baked JSON). Returns { data, live, loading, error, reload }.
export function useReportData<T>(liveUrl: string | null, snapshotUrl: string, override?: T) {
  const [data, setData] = useState<T | null>(override ?? null)
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(!override)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (override) return
    setLoading(true)
    setError(null)
    try {
      let payload: T | null = null
      let isLive = false
      if (liveUrl) {
        try {
          const r = await fetch(liveUrl)
          if (r.ok) {
            payload = await r.json()
            isLive = true
          }
        } catch {
          /* fall through to snapshot */
        }
      }
      if (!payload) {
        const r = await fetch(snapshotUrl)
        if (!r.ok) throw new Error(`Could not load data (${r.status})`)
        payload = await r.json()
      }
      setData(payload)
      setLive(isLive)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [liveUrl, snapshotUrl, override])

  useEffect(() => {
    load()
  }, [load])

  return { data, live, loading, error, reload: load }
}
