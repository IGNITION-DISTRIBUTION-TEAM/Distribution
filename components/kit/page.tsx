import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The root of a report page.
 *
 * Twenty-odd Spot Report pages hand-wrote `flex flex-col gap-5 p-6` as their
 * outermost element. Putting it here does two things: the page layout has one
 * definition, and the fade that plays when content replaces a loading skeleton
 * is defined once rather than copied into every file.
 *
 * Fade only, no travel. The region is already in place and correctly sized by
 * the skeleton — only its contents arrived, so nudging it 4px would be movement
 * without meaning. That is the rule for the whole system: a fade belongs where
 * a region appears from nothing; where a frame stays and only its contents
 * swap, the frame IS the continuity and motion is noise.
 */
export function ReportPage({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-5 p-6 animate-in fade-in-0 duration-200 ease-out", className)}>
      {children}
    </div>
  )
}
