import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The two heading levels every page uses. 51 `<h2 className="text-2xl
 * font-semibold text-foreground">` and 63 `<h3 className="font-medium
 * text-foreground">` were typed out by hand before these existed, alongside a
 * dozen one-off variants that were the inconsistency.
 */
export function PageHeading({
  children,
  description,
  actions,
  className,
}: {
  children: ReactNode
  /** Rendered under the title in muted text — 32 of the 51 h2s had exactly this. */
  description?: ReactNode
  /** Buttons aligned to the right of the title. */
  actions?: ReactNode
  className?: string
}) {
  const heading = <h2 className="text-2xl font-semibold text-foreground">{children}</h2>
  if (!description && !actions) return className ? <div className={className}>{heading}</div> : heading
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {heading}
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function SectionHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("font-medium text-foreground", className)}>{children}</h3>
}
