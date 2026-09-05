import type { ReactNode } from "react"
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Inline status banner. 41 error banners, 8 success and ~10 amber were typed
 * out by hand in three different opacities; two were behind components that
 * were copies of each other. The palette is kept as it was — rose/emerald/
 * amber tints were tuned for the dark card surface, and `--destructive` is a
 * saturated button red, not a tint. Changing that later is now a one-file edit.
 */
export type BannerTone = "error" | "success" | "warning" | "info"

const TONE: Record<BannerTone, { box: string; Icon: typeof AlertCircle }> = {
  error: { box: "border-rose-500/40 bg-rose-500/5 text-rose-300", Icon: AlertCircle },
  success: { box: "border-emerald-500/40 bg-emerald-500/5 text-emerald-300", Icon: CheckCircle2 },
  warning: { box: "border-amber-500/30 bg-amber-500/5 text-amber-200", Icon: AlertTriangle },
  info: { box: "border-border bg-muted/40 text-muted-foreground", Icon: Info },
}

export function Banner({
  tone,
  children,
  icon = true,
  className,
}: {
  tone: BannerTone
  children: ReactNode
  /** false suppresses the leading icon, e.g. when the content carries its own. */
  icon?: boolean
  className?: string
}) {
  const { box, Icon } = TONE[tone]
  return (
    <div
      role={tone === "error" || tone === "warning" ? "alert" : undefined}
      className={cn("flex items-start gap-2 rounded-lg border px-4 py-3 text-sm", box, className)}
    >
      {icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0 break-words">{children}</div>
    </div>
  )
}
