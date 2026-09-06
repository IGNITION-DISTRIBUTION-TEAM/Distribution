"use client"

/**
 * Per-campaign editor for the CXM export's column layout.
 *
 * The export used to hold one hardcoded 55-column SELECT list for every
 * campaign. Every campaign is different, so the list is configuration now, and
 * this is where it is configured. A campaign that has never been touched keeps
 * the default, which is exactly the list that was hardcoded.
 *
 * WHAT THIS DELIBERATELY IS NOT: a SQL box. Every field here is a choice from a
 * closed set — an output name, a source column read live off the leads table, a
 * named transform, or one of six presets. The same validator that guards the
 * save path runs on every keystroke here, so the preview cannot be more
 * permissive than the thing that will actually run.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Banner } from "@/components/kit/banner"
import { SectionHeading } from "@/components/kit/heading"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SkeletonRows } from "@/components/kit/skeleton"
import { cn } from "@/lib/utils"
import type { ColumnSpec, ExportLayout } from "@/lib/export-layout"

type Meta = {
  sourceColumns: { name: string; type: string }[]
  transforms: { id: string; label: string }[]
  presets: { id: string; label: string }[]
}

type Problem = { index: number; message: string }

/** Radix Select cannot hold an empty value, so "no preset yet" needs a token. */
const NONE = "__none__"

export function ExportLayoutEditor({
  campaignId,
  layout,
  onChange,
}: {
  campaignId: string
  /** null until loaded; the parent owns it so Save can send it with the config. */
  layout: ExportLayout | null
  onChange: (next: ExportLayout) => void
}) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDefault, setIsDefault] = useState(true)
  const [defaults, setDefaults] = useState<ExportLayout | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    if (!campaignId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/distribution/export-layout?campaignId=${encodeURIComponent(campaignId)}`,
        { cache: "no-store" }
      )
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setMeta({ sourceColumns: d.sourceColumns ?? [], transforms: d.transforms ?? [], presets: d.presets ?? [] })
      setDefaults(d.defaultLayout ?? null)
      setIsDefault(Boolean(d.isDefault))
      if (!layout && d.layout) onChange(d.layout)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    // `layout` is deliberately absent: this seeds it once per campaign and must
    // not refire when the user starts editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, onChange])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Re-validate on the server, debounced.
   *
   * On the server on purpose: it is the only place that knows the live column
   * list, and a client-side copy would drift from the validator that actually
   * guards the save.
   */
  useEffect(() => {
    if (!layout || !campaignId) return
    const t = setTimeout(async () => {
      setChecking(true)
      try {
        const res = await fetch("/api/distribution/export-layout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout }),
        })
        const d = await res.json()
        setProblems(d.ok ? [] : (d.problems ?? []))
      } catch {
        /* a failed check must not block editing; save re-checks anyway */
      } finally {
        setChecking(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [layout, campaignId])

  const columns = layout?.columns ?? []

  const update = (i: number, patch: Partial<ColumnSpec>) => {
    if (!layout) return
    const next = layout.columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c))
    onChange({ columns: next })
  }

  const move = (i: number, delta: number) => {
    if (!layout) return
    const j = i + delta
    if (j < 0 || j >= layout.columns.length) return
    const next = [...layout.columns]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange({ columns: next })
  }

  const remove = (i: number) => {
    if (!layout) return
    onChange({ columns: layout.columns.filter((_, idx) => idx !== i) })
  }

  const insertAfter = (i: number) => {
    if (!layout) return
    const next = [...layout.columns]
    next.splice(i + 1, 0, { out: "NEW_COLUMN", kind: "null" })
    onChange({ columns: next })
  }

  const problemFor = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of problems) if (p.index >= 0 && !map.has(p.index)) map.set(p.index, p.message)
    return map
  }, [problems])

  const generalProblems = problems.filter((p) => p.index < 0)

  if (!campaignId) {
    return <Banner tone="info">Pick a campaign to set up its export layout.</Banner>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionHeading>Export layout (CXM)</SectionHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            The columns the step 4 download and the step 5 email produce, in order. Every campaign
            can differ; leave it alone to keep the standard layout.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{columns.length} columns</Badge>
          {isDefault && <Badge variant="outline">standard</Badge>}
          {checking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!defaults}
            onClick={() => defaults && onChange(JSON.parse(JSON.stringify(defaults)))}
          >
            <RotateCcw className="mr-2 h-4 w-4" /> Reset to standard
          </Button>
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {generalProblems.length > 0 && (
        <Banner tone="error">{generalProblems.map((p) => p.message).join(" · ")}</Banner>
      )}
      {!error && problems.length === 0 && !isDefault && (
        <Banner tone="success">
          This layout is valid. It takes effect on the next download or email for this campaign.
        </Banner>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Column name in the file</TableHead>
            <TableHead>Filled with</TableHead>
            <TableHead>From</TableHead>
            <TableHead className="text-right">Order</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && columns.length === 0 ? (
            <SkeletonRows cols={5} rows={6} />
          ) : (
            columns.map((c, i) => {
              const problem = problemFor.get(i)
              return (
                <TableRow key={i} className={cn(problem && "bg-rose-500/5")}>
                  <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                  <TableCell>
                    <Input
                      value={c.out}
                      aria-label={`Column ${i + 1} name`}
                      className="h-8 w-52"
                      onChange={(e) => update(i, { out: e.target.value })}
                    />
                    {problem && <div className="mt-1 text-xs text-rose-300">{problem}</div>}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={c.kind}
                      onValueChange={(v) =>
                        update(i, {
                          kind: v as ColumnSpec["kind"],
                          // Clear the fields the other kinds own, or a stale
                          // source would travel with a NULL column.
                          source: undefined,
                          transform: undefined,
                          preset: undefined,
                          nullType: undefined,
                        })
                      }
                    >
                      <SelectTrigger className="h-8 w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="null">Nothing (empty)</SelectItem>
                        <SelectItem value="column">A lead field</SelectItem>
                        <SelectItem value="preset">A built-in rule</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {c.kind === "null" && (
                      <Select
                        value={c.nullType ?? "text"}
                        onValueChange={(v) =>
                          update(i, { nullType: v === "number" ? "number" : undefined })
                        }
                      >
                        <SelectTrigger className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Empty (text)</SelectItem>
                          <SelectItem value="number">Empty (number)</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {c.kind === "column" && (
                      <div className="flex flex-wrap gap-2">
                        <Select
                          value={c.source ?? NONE}
                          onValueChange={(v) => update(i, { source: v === NONE ? undefined : v })}
                        >
                          <SelectTrigger className="h-8 w-52">
                            <SelectValue placeholder="Pick a field" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>— pick a field —</SelectItem>
                            {(meta?.sourceColumns ?? []).map((s) => (
                              <SelectItem key={s.name} value={s.name}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={c.transform ?? "raw"}
                          onValueChange={(v) => update(i, { transform: v as ColumnSpec["transform"] })}
                        >
                          <SelectTrigger className="h-8 w-52">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(meta?.transforms ?? []).map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {c.kind === "preset" && (
                      <Select
                        value={c.preset ?? NONE}
                        onValueChange={(v) =>
                          update(i, { preset: v === NONE ? undefined : (v as ColumnSpec["preset"]) })
                        }
                      >
                        <SelectTrigger className="h-8 w-full max-w-md">
                          <SelectValue placeholder="Pick a rule" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— pick a rule —</SelectItem>
                          {(meta?.presets ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button type="button" variant="ghost" size="icon" aria-label="Move up" onClick={() => move(i, -1)}>
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label="Move down" onClick={() => move(i, 1)}>
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label="Add a column below" onClick={() => insertAfter(i)}>
                        <Plus className="h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label="Remove this column" onClick={() => remove(i)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        A BATCHNAME column is required — the export names each file after it, and that is what the
        dialler team keys on. Field names come from the live leads table, so anything not on it is
        refused rather than silently producing a broken file.
      </p>
    </div>
  )
}

/** A label for the whole layout, for the header of the panel that hosts this. */
export function layoutSummary(layout: ExportLayout | null, isDefault: boolean): string {
  if (!layout) return "loading"
  return `${layout.columns.length} columns${isDefault ? " (standard)" : ""}`
}
