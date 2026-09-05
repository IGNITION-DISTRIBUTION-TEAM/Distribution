import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { SectionHeading } from "@/components/kit/heading"
import { cn } from "@/lib/utils"

/** A chart's frame: dense card, title, optional subtitle. Three copies existed. */
export function ChartCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card padding="dense" className={className}>
      <div className="mb-2">
        <SectionHeading>{title}</SectionHeading>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </Card>
  )
}

/**
 * Recharts tooltip content. Three copies existed and disagreed on one thing:
 * whether to round. The Spot Report copy rounded, the EngAIge copy did not and
 * shows decimals. So rounding is the caller's choice via `format`, and the
 * default changes nothing about the number.
 */
export function ChartTip({
  active,
  payload,
  label,
  fmtLabel,
  suffix,
  format = (n) => n.toLocaleString(),
}: {
  active?: boolean
  payload?: { dataKey?: string | number; name?: string; value?: number | string; color?: string }[]
  label?: string | number
  fmtLabel?: (s: string) => string
  suffix?: string
  format?: (n: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-foreground">{fmtLabel ? fmtLabel(String(label)) : String(label)}</p>
      {payload.map((p, i) => (
        <div key={`${String(p.dataKey ?? p.name)}-${i}`} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: String(p.color) }} />
          <span className="text-muted-foreground">{String(p.name ?? p.dataKey)}</span>
          <span className={cn("ml-auto pl-3 font-mono text-foreground")}>
            {typeof p.value === "number" ? format(p.value) : String(p.value)}
            {suffix ?? ""}
          </span>
        </div>
      ))}
    </div>
  )
}
