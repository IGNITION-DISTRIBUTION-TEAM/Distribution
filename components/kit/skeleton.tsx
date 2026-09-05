import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { SectionHeading } from "@/components/kit/heading"
import { cn } from "@/lib/utils"

/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * Before these existed the app had ~136 spinners and no skeletons: a spinner
 * in a table cell, a spinner replacing a whole report, plain "Loading…" text
 * with no motion at all, and seventeen places that showed nothing — or, worse,
 * "No data" — while the fetch was still running. A skeleton keeps the page's
 * layout while it waits, so nothing jumps when the data arrives.
 *
 * Geometry rule, used throughout: the OUTER element reproduces the real
 * element's line box (h-8 for a text-2xl line, h-[15px] for text-[10px], h-5
 * for text-sm) and the pulsing bar inside is thinner. That is what keeps the
 * skeleton exactly as tall as what replaces it.
 *
 * Accessibility: one "Loading" announcement per region, never per bar — a
 * table skeleton must not say "Loading" twenty times.
 */
export { Skeleton }

function LoadingRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">Loading</span>
      {children}
    </div>
  )
}

/** Lines of body text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <LoadingRegion className={cn("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-5 items-center">
          <Skeleton className={cn("h-3", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
        </div>
      ))}
    </LoadingRegion>
  )
}

const ROW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-1/3"]

/**
 * Table body rows. Valid directly inside <TableBody>. `cols` is what the old
 * `<TableCell colSpan={n}>` spinner said — one real cell per column keeps the
 * skeleton aligned with the header.
 */
export function SkeletonRows({ cols, rows = 3, className }: { cols: number; rows?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow key={r} className={cn("hover:bg-transparent", className)} aria-busy="true">
          {Array.from({ length: cols }, (_, c) => (
            <TableCell key={c}>
              {r === 0 && c === 0 && (
                <span role="status" className="sr-only">
                  Loading
                </span>
              )}
              <Skeleton className={cn("h-3.5", ROW_WIDTHS[(r + c) % ROW_WIDTHS.length])} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

/** One stat tile, the exact box of kit/stat-tile.tsx without a sub-line. */
export function SkeletonTile({ size = "md", className }: { size?: "md" | "sm"; className?: string }) {
  return (
    <div className={cn("rounded-md border border-border bg-card px-3 py-2", className)}>
      <div className="flex h-[15px] items-center">
        <Skeleton className="h-2 w-20" />
      </div>
      <div className={cn("mt-0.5 flex items-center", size === "md" ? "h-8" : "h-6")}>
        <Skeleton className={size === "md" ? "h-5 w-24" : "h-3.5 w-16"} />
      </div>
    </div>
  )
}

export function SkeletonTiles({
  count = 4,
  size = "md",
  className,
}: {
  count?: number
  size?: "md" | "sm"
  className?: string
}) {
  return (
    <LoadingRegion className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonTile key={i} size={size} />
      ))}
    </LoadingRegion>
  )
}

/**
 * A chart's box at its real height: a y-axis of short bars, a plot area, an
 * x-axis of labels. Takes a pixel height, or fills a parent that already has
 * one (daily-files sizes its bar charts from the row count).
 */
export function SkeletonChart({
  height,
  axis = true,
  className,
}: {
  /** Pixel height. Omit to fill a parent that already has one. */
  height?: number
  axis?: boolean
  className?: string
}) {
  return (
    <LoadingRegion className={cn("relative w-full", height === undefined && "h-full", className)}>
      <div style={height === undefined ? undefined : { height }} className={cn("relative w-full", height === undefined && "h-full")}>
        {axis && (
          <div className="absolute inset-y-0 bottom-6 left-0 flex w-8 flex-col justify-between py-1">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-2 w-6" />
            ))}
          </div>
        )}
        <Skeleton className={cn("absolute bottom-6 right-0 top-0 rounded-md", axis ? "left-10" : "left-0")} />
        {axis && (
          <div className="absolute bottom-0 left-10 right-0 flex justify-between">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-2 w-8" />
            ))}
          </div>
        )}
      </div>
    </LoadingRegion>
  )
}

/** A form: label + input per field, and a button. Inputs are h-10 like ui/input. */
export function SkeletonForm({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <LoadingRegion className={cn("space-y-4", className)}>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
      <Skeleton className="h-10 w-24" />
    </LoadingRegion>
  )
}

/**
 * A dashboard panel: card, title, optional tile row, chart. The title is the
 * REAL heading when given — a panel called "Dialler stats" should still say
 * so while it loads.
 */
export function SkeletonPanel({
  title,
  tiles = 0,
  height = 240,
  className,
}: {
  title?: ReactNode
  tiles?: number
  height?: number
  className?: string
}) {
  return (
    <Card className={className}>
      <LoadingRegion className="space-y-4">
        <div className="flex h-6 items-center">
          {title ? <SectionHeading>{title}</SectionHeading> : <Skeleton className="h-4 w-40" />}
        </div>
        {tiles > 0 && <SkeletonTiles count={tiles} size="sm" />}
        <SkeletonChart height={height} />
      </LoadingRegion>
    </Card>
  )
}

/**
 * A whole report page: heading, a row of controls, tiles, chart cards. The
 * Spot Report pages all share this shape (and the `flex flex-col gap-5 p-6`
 * wrapper), so their first paint is the page they are about to become rather
 * than one line of text.
 */
export function SkeletonReport({
  tiles = 4,
  charts = 2,
  chartHeight = 256,
  header = true,
  className,
}: {
  tiles?: number
  charts?: number
  chartHeight?: number
  /** False when the page renders its own heading and controls while loading. */
  header?: boolean
  className?: string
}) {
  return (
    <LoadingRegion className={cn("flex flex-col gap-5", header && "p-6", className)}>
      {header && (
        <>
          <div>
            <div className="flex h-8 items-center">
              <Skeleton className="h-6 w-64" />
            </div>
            <div className="mt-1 flex h-5 items-center">
              <Skeleton className="h-3 w-96 max-w-full" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-10 w-40" />
          </div>
        </>
      )}
      {tiles > 0 && <SkeletonTiles count={tiles} />}
      {charts > 0 && (
        <div className={cn("grid gap-4", charts > 1 && "lg:grid-cols-2")}>
          {Array.from({ length: charts }, (_, i) => (
            <Card key={i} padding="dense">
              <div className="mb-2 flex h-6 items-center">
                <Skeleton className="h-4 w-40" />
              </div>
              <SkeletonChart height={chartHeight} />
            </Card>
          ))}
        </div>
      )}
    </LoadingRegion>
  )
}
