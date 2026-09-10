"use client"

/**
 * Resolving the duplicate product mappings.
 *
 * The main screen reports that hundreds of product names appear more than once
 * and that each surplus row multiplies that product's billing rows. It gave no
 * way to do anything about it, which made it a nag rather than a warning. This
 * is where they get fixed.
 *
 * THE SCREEN IS SPLIT THE WAY THE WORK IS SPLIT:
 *
 *  - EXACT COPIES need no judgement. Every row says the same thing, so keeping
 *    one is lossless. That is one button for all of them, and it is the bulk of
 *    the count.
 *  - CONFLICTS need a person. Two rows for one product disagreeing about brand
 *    is a business question, so they come one at a time with the competing rows
 *    side by side and the differences called out.
 *
 * Presenting them together would bury a few hundred real decisions in a few
 * thousand rows of noise.
 */

import { useCallback, useEffect, useState } from "react"
import { Check, Layers, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Banner } from "@/components/kit/banner"
import { SectionHeading } from "@/components/kit/heading"
import { SkeletonPanel } from "@/components/kit/skeleton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { pageInfo } from "@/lib/pagination"

type Mapping = {
  productName: string
  productGroup: string | null
  vasButtonFlag: string | null
  channelOverride: string | null
  brandOverride: string | null
}

type Group = {
  productKey: string
  rowsFound: number
  conflicting: boolean
  rows: Mapping[]
}

type Mode = "conflicts" | "copies" | "all"

const PAGE = 25

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(
      res.ok ? "The server returned something that is not JSON." : `HTTP ${res.status}: ${text.slice(0, 200)}`
    )
  }
}

const val = (v: string | null) => (v === null || v.trim() === "" ? "—" : v)

/** Which columns actually differ within a group — the reason it needs a person. */
function differingColumns(rows: Mapping[]): Set<keyof Mapping> {
  const out = new Set<keyof Mapping>()
  const keys: (keyof Mapping)[] = [
    "productGroup",
    "vasButtonFlag",
    "channelOverride",
    "brandOverride",
  ]
  for (const k of keys) {
    const seen = new Set(rows.map((r) => r[k] ?? ""))
    if (seen.size > 1) out.add(k)
  }
  return out
}

export function DuplicateResolver() {
  const [mode, setMode] = useState<Mode>("conflicts")
  const [groups, setGroups] = useState<Group[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [exactCopyKeys, setExactCopyKeys] = useState(0)
  const [exactCopyRows, setExactCopyRows] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (m: Mode, off: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ mode: m, limit: String(PAGE), offset: String(off) })
      const res = await fetch(`/api/paiment/product-mappings/duplicates?${params}`, {
        cache: "no-store",
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      setGroups((data.groups as Group[]) ?? [])
      setTotal(Number(data.total ?? 0))
      setExactCopyKeys(Number(data.exactCopyKeys ?? 0))
      setExactCopyRows(Number(data.exactCopyRowsRemoved ?? 0))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Deferred by a tick rather than called straight from the effect body. The
  // tab buttons set mode AND reset offset together, which without coalescing
  // is two renders and two fetches for one click — and calling setState
  // synchronously inside an effect is what react-hooks/set-state-in-effect
  // objects to, for the same underlying reason.
  useEffect(() => {
    const t = setTimeout(() => void load(mode, offset), 0)
    return () => clearTimeout(t)
  }, [mode, offset, load])

  const pager = pageInfo(total, PAGE, offset)

  const collapseCopies = async () => {
    if (
      !window.confirm(
        `Collapse ${exactCopyKeys} product${exactCopyKeys === 1 ? "" : "s"} to one row each?\n\n` +
          `This removes ${exactCopyRows} duplicate row${exactCopyRows === 1 ? "" : "s"}. ` +
          `Every one of them is an exact copy, so nothing is lost — but it cannot be undone ` +
          `from this screen.`
      )
    )
      return
    setBusy("collapse")
    try {
      const res = await fetch("/api/paiment/product-mappings/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "collapse-copies", confirm: "COLLAPSE" }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success(`${data.rowsRemoved} duplicate row(s) removed across ${data.keysAffected} product(s)`)
      setOffset(0)
      await load(mode, 0)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const resolve = async (group: Group, keep: Mapping) => {
    if (
      !window.confirm(
        `Keep this row for:\n\n${group.productKey}\n\n` +
          `channel ${val(keep.channelOverride)}, brand ${val(keep.brandOverride)}\n\n` +
          `The other ${group.rowsFound - 1} row(s) for this product will be removed.`
      )
    )
      return
    setBusy(group.productKey)
    try {
      const res = await fetch("/api/paiment/product-mappings/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          confirm: "RESOLVE",
          productKey: group.productKey,
          keep,
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success(`Resolved — ${data.removed} row(s) removed`)
      await load(mode, offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const tab = (id: Mode, label: string) => (
    <Button
      type="button"
      variant={mode === id ? "default" : "outline"}
      size="sm"
      onClick={() => {
        setMode(id)
        setOffset(0)
      }}
    >
      {label}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      {error && <Banner tone="error"><span>{error}</span></Banner>}

      {exactCopyKeys > 0 && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <SectionHeading>Exact copies</SectionHeading>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {exactCopyKeys} product{exactCopyKeys === 1 ? " has" : "s have"} duplicate rows
                that all say exactly the same thing. Keeping one of each removes{" "}
                {exactCopyRows} row{exactCopyRows === 1 ? "" : "s"} and changes no mapping — the
                only thing those rows do today is multiply billing rows.
              </p>
            </div>
            <Button type="button" disabled={busy !== null} onClick={() => void collapseCopies()}>
              <Layers className="mr-2 h-4 w-4" />
              {busy === "collapse" ? "Collapsing…" : `Collapse ${exactCopyKeys}`}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>Duplicates</SectionHeading>
          <div className="flex items-center gap-2">
            {tab("conflicts", "Need a decision")}
            {tab("copies", "Exact copies")}
            {tab("all", "All")}
          </div>
        </div>

        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "conflicts"
            ? "These products have rows that disagree. Pick the row to keep; the others are removed."
            : mode === "copies"
              ? "These rows are identical. Use Collapse above rather than working through them."
              : "Every duplicated product name, conflicts first."}
        </p>

        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>{total === 0 ? "None" : `Showing ${pager.from}–${pager.to} of ${total}`}</span>
          {pager.pages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!pager.canPrev}
                onClick={() => setOffset(pager.prevOffset)}
              >
                Previous
              </Button>
              <span>
                Page {pager.page} of {pager.pages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!pager.canNext}
                onClick={() => setOffset(pager.nextOffset)}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <SkeletonPanel className="mt-4" />
        ) : groups.length === 0 ? (
          <Banner tone="success" className="mt-4">
            <span>
              {mode === "conflicts"
                ? "Nothing left to decide — no product has rows that disagree."
                : "No duplicates in this view."}
            </span>
          </Banner>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {groups.map((group) => {
              const differing = differingColumns(group.rows)
              const cell = (v: string | null, k: keyof Mapping) => (
                <TableCell
                  className={
                    differing.has(k) ? "text-xs font-medium text-amber-200" : "text-xs"
                  }
                >
                  {val(v)}
                </TableCell>
              )
              return (
                <div key={group.productKey} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {group.conflicting && (
                      <ShieldAlert className="h-4 w-4 shrink-0 text-rose-300" />
                    )}
                    <span className="min-w-0 break-all font-mono text-xs text-foreground">
                      {group.productKey}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {group.rowsFound} rows
                      {group.conflicting ? " · they disagree" : " · identical"}
                    </span>
                  </div>

                  <div className="mt-2 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Group</TableHead>
                          <TableHead>VAS</TableHead>
                          <TableHead>Channel override</TableHead>
                          <TableHead>Brand override</TableHead>
                          <TableHead className="w-24 text-right">Keep</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.rows.map((row, i) => (
                          <TableRow key={`${group.productKey}-${i}`}>
                            {cell(row.productGroup, "productGroup")}
                            {cell(row.vasButtonFlag, "vasButtonFlag")}
                            {cell(row.channelOverride, "channelOverride")}
                            {cell(row.brandOverride, "brandOverride")}
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy !== null}
                                onClick={() => void resolve(group, row)}
                              >
                                <Check className="mr-1 h-4 w-4" />
                                Keep
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {group.conflicting && differing.size > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Differs on{" "}
                      <span className="text-amber-200">
                        {[...differing]
                          .map((k) =>
                            k === "productGroup"
                              ? "product group"
                              : k === "vasButtonFlag"
                                ? "VAS flag"
                                : k === "channelOverride"
                                  ? "channel override"
                                  : "brand override"
                          )
                          .join(", ")}
                      </span>
                      .
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
