"use client"

import { BarChart3, Info } from "lucide-react"

// App-styled placeholder for reports that have no data source yet (parity with
// the original static rebuild's placeholder pages, in the portal design).
export function SpotReportPlaceholder({
  title,
  subtitle,
  note,
  kpis = [],
  charts = [],
}: {
  title: string
  subtitle?: string
  note: string
  kpis?: string[]
  charts?: string[]
}) {
  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            ● No data source
          </span>
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{note}</span>
      </div>

      {kpis.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((label) => (
            <div key={label} className="rounded-md border border-dashed border-border bg-card px-3 py-2 opacity-70">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-0.5 text-2xl font-semibold text-muted-foreground">—</p>
            </div>
          ))}
        </div>
      )}

      {charts.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          {charts.map((c) => (
            <div
              key={c}
              className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card text-center"
            >
              <BarChart3 className="h-8 w-8 text-muted-foreground/50" />
              <p className="px-6 text-sm font-medium text-muted-foreground">{c}</p>
              <p className="text-xs text-muted-foreground/70">Awaiting data source</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
