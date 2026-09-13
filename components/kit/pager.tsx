"use client"

import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PageInfo } from "@/lib/pagination"

/**
 * The one pager.
 *
 * It started life inside the product mapping screen, whose own comment said a
 * second pager style in one codebase was the thing to avoid — and then the
 * campaign mapper grew a hand-rolled Previous/Next with no page size and no
 * First/Last, which is exactly that. This is where it lives now, so the next
 * screen that needs paging has somewhere obvious to get one.
 *
 * RENDER IT ABOVE THE LIST AS WELL AS BELOW. With a page of rows between you
 * and the controls, changing page means scrolling past everything you have just
 * read; that was the original complaint both times. Below stays because that is
 * where your eye is when you finish a page.
 *
 * FIRST AND LAST ARE NOT DECORATION. Next-repeatedly is not navigation when a
 * list runs to hundreds of rows.
 *
 * All the arithmetic is in lib/pagination.ts, where the boundaries are tested
 * rather than eyeballed — an empty result must not read "1–0 of 0", and 100
 * rows at 50 a page is two pages, not three.
 */

/** Offered in the size selector. 50 suits every list this app currently has. */
export const PAGE_SIZES = [25, 50, 100, 200] as const
export const DEFAULT_PAGE_SIZE = 50

export function Pager({
  info,
  total,
  pageSize,
  onOffset,
  onPageSize,
  showSize,
  noun = "rows",
}: {
  info: PageInfo
  total: number
  pageSize: number
  onOffset: (offset: number) => void
  onPageSize: (size: number) => void
  /** Only the top pager carries the size selector; two would just disagree. */
  showSize?: boolean
  /**
   * What the list holds, for the empty state — "No products", "No campaigns".
   * Defaulted rather than required so a caller cannot accidentally tell a
   * campaign screen it has no products, which is what the hard-coded version
   * did.
   */
  noun?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">
          {total === 0 ? `No ${noun}` : `Showing ${info.from}–${info.to} of ${total}`}
        </span>
        {showSize && (
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} a page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {info.pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="First page"
            disabled={!info.canPrev}
            onClick={() => onOffset(0)}
          >
            <ChevronFirst className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!info.canPrev}
            onClick={() => onOffset(info.prevOffset)}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {info.page} of {info.pages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!info.canNext}
            onClick={() => onOffset(info.nextOffset)}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Last page"
            disabled={!info.canNext}
            onClick={() => onOffset(info.lastOffset)}
          >
            <ChevronLast className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
