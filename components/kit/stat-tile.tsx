import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * One stat tile. Eight implementations in five sizes existed before this —
 * StatTile ×3, CompactStat, SyncStat, SummaryCard ×2 — differing in radius,
 * padding, label size and whether the accent coloured the value or the
 * sub-line. This is the spot-report-kit shape, the most-used of the eight.
 *
 * `tone` colours the VALUE (what the Distribution and EngAIge tiles did);
 * `subClassName` styles the sub-line (what the Spot Report tiles did). Both
 * families map onto this without changing what they show.
 */
export type StatTone = "primary" | "success" | "danger" | "muted"

const TONE: Record<StatTone, string> = {
  primary: "text-primary",
  success: "text-emerald-300",
  danger: "text-rose-300",
  muted: "text-muted-foreground",
}

export function StatTile({
  label,
  value,
  sub,
  size = "md",
  tone,
  subClassName,
  className,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  /** md = text-2xl (dashboards' headline numbers), sm = text-base (dense rows). */
  size?: "md" | "sm"
  tone?: StatTone
  subClassName?: string
  className?: string
}) {
  return (
    <div className={cn("rounded-md border border-border bg-card px-3 py-2", className)}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-semibold",
          size === "md" ? "text-2xl" : "text-base",
          tone ? TONE[tone] : "text-foreground"
        )}
      >
        {value}
      </p>
      {sub !== undefined && sub !== null && sub !== "" && (
        <p className={cn("mt-0.5 text-xs", subClassName ?? "text-muted-foreground")}>{sub}</p>
      )}
    </div>
  )
}
