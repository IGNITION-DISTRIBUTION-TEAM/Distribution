/**
 * Pager arithmetic, in one place.
 *
 * PURE, NO I/O. Every pager in this app has so far recomputed
 * `Math.min(offset + size, total)` and friends inline in the component, where
 * nothing can test them — and an off-by-one in a pager is the classic bug: it
 * shows "1–50 of 0" on an empty result, or disables Next one page early, and
 * nobody notices until someone counts.
 *
 * The awkward cases this gets right, all of which arise on a real screen:
 *
 *   - TOTAL 0. There is no row 1, so `from` is 0 and the caller must render
 *     "no rows" rather than a range.
 *   - TOTAL AN EXACT MULTIPLE OF LIMIT. 100 rows at 50 a page is 2 pages, not
 *     3 — the naive `floor(total / limit) + 1` gets this wrong.
 *   - AN OFFSET PAST THE END. Type into a search box while on page 8 and the
 *     result set shrinks under you. `page` is clamped to the last real page so
 *     the UI never reports "Page 8 of 2".
 *   - LIMIT LARGER THAN TOTAL. One page, and Next is disabled.
 *
 * Offsets rather than page numbers in the return value, because the API takes
 * an offset and converting in the click handler is where the bug goes.
 */

export type PageInfo = {
  /** 1-based page number, clamped into range. */
  page: number
  /** Total pages; at least 1 even when there are no rows. */
  pages: number
  /** 1-based index of the first row shown, or 0 when there are none. */
  from: number
  /** 1-based index of the last row shown, or 0 when there are none. */
  to: number
  canPrev: boolean
  canNext: boolean
  prevOffset: number
  nextOffset: number
  /** Offset of the first row of the last page. */
  lastOffset: number
}

/**
 * `limit` must be a positive integer; a caller passing 0 would otherwise divide
 * by zero and report Infinity pages, so it is floored at 1 rather than trusted.
 */
export function pageInfo(total: number, limit: number, offset: number): PageInfo {
  const size = Math.max(1, Math.floor(limit))
  const count = Math.max(0, Math.floor(total))
  const pages = Math.max(1, Math.ceil(count / size))

  // Clamp the requested offset into the real range before deriving anything
  // else — this is what stops a stale offset reporting an impossible page.
  const maxOffset = (pages - 1) * size
  const start = Math.min(Math.max(0, Math.floor(offset)), maxOffset)

  const page = Math.floor(start / size) + 1
  const from = count === 0 ? 0 : start + 1
  const to = count === 0 ? 0 : Math.min(start + size, count)

  return {
    page,
    pages,
    from,
    to,
    canPrev: start > 0,
    canNext: start + size < count,
    prevOffset: Math.max(0, start - size),
    nextOffset: start + size,
    lastOffset: maxOffset,
  }
}
