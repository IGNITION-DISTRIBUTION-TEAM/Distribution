"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
  LogOut,
  ChevronsUpDown,
  RefreshCw,
  Table2,
  Workflow,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SKIP_VALUE,
  ALLOWED_SQL_TYPES,
  DELIMITERS,
  sniffDelimiter,
  splitDelimited,
  sanitizeHeaderRow,
  autoMatchColumn,
  type TargetColumn,
  type Delimiter,
} from "@/lib/column-mapping"

type SftpEndpoint = { name: string; label: string; allowedRoot: string; enabled: boolean }
type SftpEntry = {
  name: string
  is_dir: boolean
  size: number | null
  mtime_epoch: number | null
  path: string
}

function formatBytes(n: number | null): string {
  if (n == null) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatMtime(epoch: number | null): string {
  // 0 is not "1970" here — several Spot directories genuinely report 0, which
  // means the server did not give a modification time. Showing the epoch would
  // be worse than admitting we do not know.
  if (!epoch) return "—"
  const d = new Date(epoch * 1000)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

/**
 * Turn a chosen filename into a wildcard that survives a datestamp.
 *
 *   rates_20260903.csv  ->  rates_*.csv
 *   export-2026-09-03   ->  export-*
 *
 * Longest runs first, so 20260903 is not chewed up as 2026 then 0903. Returns
 * the name unchanged when nothing looks like a date, because a wildcard nobody
 * asked for is worse than none.
 */
export function suggestPattern(filename: string): string {
  let out = filename
  const rules: [RegExp, string][] = [
    [/\d{4}[-_]\d{2}[-_]\d{2}/g, "*"], // 2026-09-03 / 2026_09_03
    [/\d{8}/g, "*"], // 20260903
    [/\d{6}/g, "*"], // 202609
  ]
  for (const [re, rep] of rules) {
    if (re.test(out)) {
      out = out.replace(re, rep)
      break
    }
  }
  return out
}

export type SortKey = "name" | "size" | "mtime"
export type SortDir = "asc" | "desc"

/**
 * Sort a directory listing.
 *
 * Folders stay first whatever the column, the way every file browser behaves —
 * a listing that reshuffles folders in among the files when you click a header
 * makes navigation harder, and it costs nothing here because a folder-only
 * directory sorts exactly as if the rule were not there.
 *
 * Missing values always sink, in BOTH directions. Folders have no size and
 * several Spot directories report no modification time at all; letting those
 * float to the top on a descending sort would put a column of em dashes above
 * the answer you clicked for.
 */
export function sortEntries(entries: SftpEntry[], key: SortKey, dir: SortDir): SftpEntry[] {
  const sign = dir === "asc" ? 1 : -1
  const value = (e: SftpEntry): number | string | null =>
    key === "name" ? e.name.toLowerCase() : key === "size" ? e.size : e.mtime_epoch || null

  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1

    const av = value(a)
    const bv = value(b)
    if (av == null && bv == null) return byName(a, b)
    if (av == null) return 1          // missing sinks regardless of direction
    if (bv == null) return -1

    if (typeof av === "string" && typeof bv === "string") {
      return av === bv ? 0 : (av < bv ? -1 : 1) * sign
    }
    const c = (av as number) - (bv as number)
    // Ties fall back to name so the order is stable and reproducible rather
    // than dependent on what the server happened to return.
    return c !== 0 ? c * sign : byName(a, b)
  })
}

/**
 * Codepoint order on the lowercased name — NOT localeCompare.
 *
 * The procedure already sorts its listing with Python's `name.lower()`, which
 * is codepoint order, so "spot-arpu" comes before "spot_flash" ('-' is 0x2D,
 * '_' is 0x5F). localeCompare deprioritises punctuation and reverses that pair,
 * which would mean clicking "Name ascending" reshuffled the list away from the
 * order it arrived in — indistinguishable from a bug.
 */
function byName(a: SftpEntry, b: SftpEntry): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x === y ? 0 : x < y ? -1 : 1
}

export function TaskAutomationDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()

  const [endpoints, setEndpoints] = useState<SftpEndpoint[]>([])
  const [endpoint, setEndpoint] = useState<string>("")
  const [endpointsError, setEndpointsError] = useState<string | null>(null)

  const [path, setPath] = useState<string>("")
  const [rootFloor, setRootFloor] = useState<string>("")
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [entryCount, setEntryCount] = useState<number>(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const [selected, setSelected] = useState<SftpEntry | null>(null)
  const [pattern, setPattern] = useState<string>("")
  const [peek, setPeek] = useState<string[] | null>(null)
  const [peeking, setPeeking] = useState(false)

  // ---- step 2: how to read the file, and where it lands
  const [delimiter, setDelimiter] = useState<Delimiter>(",")
  const [hasHeader, setHasHeader] = useState(true)
  const [destMode, setDestMode] = useState<"existing" | "new">("existing")
  const [destTable, setDestTable] = useState("")
  const [destCols, setDestCols] = useState<TargetColumn[] | null>(null)
  const [destError, setDestError] = useState<string | null>(null)
  const [destLoading, setDestLoading] = useState(false)
  /** source ordinal -> target column name, or SKIP_VALUE */
  const [mapping, setMapping] = useState<Record<number, string>>({})
  /** target column name -> chosen SQL type, when creating the table */
  const [newTypes, setNewTypes] = useState<Record<string, string>>({})
  const [mergeKeys, setMergeKeys] = useState<string[]>([])
  const [loadMode, setLoadMode] = useState<"truncate_insert" | "merge">("truncate_insert")

  // Endpoints come from the secure view; the app never sees host or key.
  useEffect(() => {
    let cancelled = false
    fetch("/api/task-automation/endpoints", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) { setEndpointsError(String(d.error)); return }
        const list: SftpEndpoint[] = d.endpoints ?? []
        setEndpoints(list)
        const first = list.find((e) => e.enabled) ?? list[0]
        if (first) { setEndpoint(first.name); setPath(first.allowedRoot) }
      })
      .catch((e) => { if (!cancelled) setEndpointsError(String(e)) })
    return () => { cancelled = true }
  }, [])

  const browse = useCallback(
    async (target: string) => {
      if (!endpoint) return
      setLoading(true)
      setError(null)
      setPeek(null)
      try {
        const res = await fetch("/api/task-automation/sftp/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint, path: target, action: "list", maxRows: 500 }),
        })
        const d = await res.json()
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
        setEntries(d.entries ?? [])
        setEntryCount(d.entryCount ?? 0)
        setTruncated(Boolean(d.truncated))
        setPath(String(d.path ?? target))
        if (d.rootFloor) setRootFloor(String(d.rootFloor))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [endpoint]
  )

  useEffect(() => { if (endpoint && path) void browse(path) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [endpoint])

  const openFile = async (entry: SftpEntry) => {
    setSelected(entry)
    setPattern(suggestPattern(entry.name))
    setPeeking(true)
    setPeek(null)
    try {
      const res = await fetch("/api/task-automation/sftp/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, path: entry.path, action: "peek", maxRows: 10 }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setPeek(d.lines ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPeeking(false)
    }
  }

  const sortedEntries = useMemo(
    () => sortEntries(entries, sortKey, sortDir),
    [entries, sortKey, sortDir]
  )

  // First click on a new column picks the direction that answers the question
  // being asked: names read A-Z, but "size" and "modified" are almost always
  // clicked to find the biggest or the newest, so those start descending.
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return }
    setSortKey(key)
    setSortDir(key === "name" ? "asc" : "desc")
  }

  // The delimiter is guessed from the peeked lines the moment a file is opened,
  // then left alone — re-guessing on every render would fight the operator the
  // second they override it.
  useEffect(() => {
    if (peek && peek.length > 0) setDelimiter(sniffDelimiter(peek))
  }, [peek])

  const sourceHeaders = useMemo(() => {
    if (!peek || peek.length === 0) return []
    const first = splitDelimited(peek[0], delimiter)
    // No header row means the columns have no names, so they get positional
    // ones. COL1..COLn matches how COPY INTO addresses them ($1..$n), which is
    // the thing the generator has to line up with.
    return hasHeader ? first : first.map((_, i) => `COL${i + 1}`)
  }, [peek, delimiter, hasHeader])

  const sampleRows = useMemo(() => {
    if (!peek) return []
    return peek.slice(hasHeader ? 1 : 0, hasHeader ? 4 : 3).map((l) => splitDelimited(l, delimiter))
  }, [peek, delimiter, hasHeader])

  /** Target columns: read from Snowflake, or derived from the header. */
  const targetColumns: TargetColumn[] = useMemo(() => {
    if (destMode === "existing") return destCols ?? []
    return sanitizeHeaderRow(sourceHeaders).map((name) => ({
      COLUMN_NAME: name,
      DATA_TYPE: newTypes[name] ?? "VARCHAR(1000)",
      IS_NULLABLE: "YES" as const,
      COLUMN_DEFAULT: null,
    }))
  }, [destMode, destCols, sourceHeaders, newTypes])

  // Auto-map by name whenever either side changes. Only fills blanks, so a
  // hand-made choice is never overwritten by a later re-read of the table.
  useEffect(() => {
    if (sourceHeaders.length === 0 || targetColumns.length === 0) return
    setMapping((prev) => {
      const next = { ...prev }
      sourceHeaders.forEach((h, i) => {
        if (next[i] && next[i] !== SKIP_VALUE) return
        next[i] = autoMatchColumn(h, targetColumns)
      })
      return next
    })
  }, [sourceHeaders, targetColumns])

  const loadDestColumns = async () => {
    const t = destTable.trim()
    if (!t) return
    setDestLoading(true)
    setDestError(null)
    setDestCols(null)
    try {
      const res = await fetch("/api/snowflake/table-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: t }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setDestCols(d.columns ?? [])
    } catch (e) {
      setDestError(e instanceof Error ? e.message : String(e))
    } finally {
      setDestLoading(false)
    }
  }

  const mappedCount = useMemo(
    () => Object.values(mapping).filter((v) => v && v !== SKIP_VALUE).length,
    [mapping]
  )

  // Breadcrumbs stop at the floor: there is nothing above it to click to.
  const crumbs = useMemo(() => {
    const floor = (rootFloor || "/").replace(/\/+$/, "")
    if (!path.startsWith(floor)) return [{ label: path, path }]
    const rest = path.slice(floor.length).split("/").filter(Boolean)
    const out = [{ label: floor || "/", path: floor || "/" }]
    let acc = floor
    for (const seg of rest) { acc = `${acc}/${seg}`; out.push({ label: seg, path: acc }) }
    return out
  }, [path, rootFloor])

  const parent = useMemo(() => {
    const floor = (rootFloor || "/").replace(/\/+$/, "")
    if (!path || path === floor) return null
    const up = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/"
    return up.startsWith(floor) ? up : null
  }, [path, rootFloor])

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Workflow className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-semibold text-foreground">Task Automation</h1>
            <p className="text-xs text-muted-foreground">
              Scheduled jobs. First up: SFTP files into Snowflake tables.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Departments
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="mr-2 h-4 w-4" /> {user?.name ?? "Log out"}
          </Button>
        </div>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                1
              </span>
              <h2 className="font-medium text-foreground">Pick the source file</h2>
            </div>

            {endpointsError ? (
              <div className="whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
                {endpointsError}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-56">
                    <label className="mb-1 block text-xs text-muted-foreground">SFTP endpoint</label>
                    <Select value={endpoint} onValueChange={setEndpoint}>
                      <SelectTrigger><SelectValue placeholder="Loading…" /></SelectTrigger>
                      <SelectContent>
                        {endpoints.map((e) => (
                          <SelectItem key={e.name} value={e.name} disabled={!e.enabled}>
                            {e.label}{e.enabled ? "" : " (disabled)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void browse(path)} disabled={loading || !endpoint}>
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Refresh
                  </Button>
                </div>

                {/* Breadcrumbs. The first crumb is the floor — the app cannot
                    browse above it, and Snowflake enforces that regardless of
                    what this sends. */}
                <div className="mt-4 flex flex-wrap items-center gap-1 text-xs">
                  <Home className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                  {crumbs.map((c, i) => (
                    <span key={c.path} className="flex items-center gap-1">
                      {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/60" />}
                      <button
                        type="button"
                        className={cn(
                          "rounded px-1 py-0.5 hover:bg-muted",
                          i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"
                        )}
                        onClick={() => void browse(c.path)}
                      >
                        {c.label}
                      </button>
                    </span>
                  ))}
                </div>

                {error && (
                  <div className="mt-3 whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                    {error}
                  </div>
                )}

                <div className="mt-3 max-h-96 overflow-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                        {([
                          { key: "name" as SortKey, label: "Name", align: "" },
                          { key: "size" as SortKey, label: "Size", align: "text-right" },
                          { key: "mtime" as SortKey, label: "Modified", align: "" },
                        ]).map((col) => (
                          <th key={col.key} className={cn("px-3 py-2 font-medium", col.align)}>
                            <button
                              type="button"
                              onClick={() => toggleSort(col.key)}
                              className={cn(
                                "inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground",
                                sortKey === col.key && "text-foreground",
                                col.align === "text-right" && "flex-row-reverse"
                              )}
                            >
                              {col.label}
                              {sortKey !== col.key ? (
                                <ChevronsUpDown className="h-3 w-3 opacity-40" />
                              ) : sortDir === "asc" ? (
                                <ArrowUp className="h-3 w-3" />
                              ) : (
                                <ArrowDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parent && (
                        <tr className="border-t border-border hover:bg-muted/40">
                          <td className="px-3 py-2" colSpan={3}>
                            <button type="button" className="flex items-center gap-2 text-muted-foreground" onClick={() => void browse(parent)}>
                              <Folder className="h-3.5 w-3.5" /> ..
                            </button>
                          </td>
                        </tr>
                      )}
                      {sortedEntries.map((e) => (
                        <tr
                          key={e.path}
                          className={cn(
                            "border-t border-border hover:bg-muted/40",
                            selected?.path === e.path && "bg-primary/5"
                          )}
                        >
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              className="flex items-center gap-2 text-left"
                              onClick={() => (e.is_dir ? void browse(e.path) : void openFile(e))}
                            >
                              {e.is_dir
                                ? <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                                : <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                              <span className={e.is_dir ? "text-foreground" : "text-foreground"}>{e.name}</span>
                            </button>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatBytes(e.size)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{formatMtime(e.mtime_epoch)}</td>
                        </tr>
                      ))}
                      {!loading && entries.length === 0 && !error && (
                        <tr><td className="px-3 py-6 text-center text-muted-foreground" colSpan={3}>Empty directory.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <p className="mt-2 text-xs text-muted-foreground">
                  {entryCount} item{entryCount === 1 ? "" : "s"}
                  {truncated && " — listing capped; narrow the path to see the rest"}
                  {rootFloor && ` · confined to ${rootFloor}`}
                </p>
              </>
            )}
          </div>

          {selected && (
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  2
                </span>
                <h2 className="font-medium text-foreground">Match the file</h2>
              </div>

              <p className="mb-3 text-sm text-muted-foreground">
                Selected <span className="font-medium text-foreground">{selected.name}</span>. The sync runs on a
                schedule, so it matches by pattern rather than by exact name — a datestamp in the filename is
                replaced with <code className="text-foreground">*</code>.
              </p>

              <div className="max-w-lg">
                <label className="mb-1 block text-xs text-muted-foreground">File pattern</label>
                <Input value={pattern} onChange={(e) => setPattern(e.target.value)} className="font-mono text-sm" />
              </div>

              <div className="mt-4">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  First lines
                </p>
                {peeking ? (
                  <p className="text-xs text-muted-foreground">Reading…</p>
                ) : peek && peek.length > 0 ? (
                  <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background/40 p-3 text-[11px] leading-relaxed text-foreground">
                    {peek.join("\n")}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">Nothing read back.</p>
                )}
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="w-40">
                    <label className="mb-1 block text-xs text-muted-foreground">Delimiter</label>
                    <Select value={delimiter} onValueChange={(v) => setDelimiter(v as Delimiter)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {DELIMITERS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2 pb-2">
                    <Checkbox
                      id="ta-has-header"
                      checked={hasHeader}
                      onCheckedChange={(v) => setHasHeader(v === true)}
                    />
                    <Label htmlFor="ta-has-header" className="text-xs text-muted-foreground">
                      First row is a header
                    </Label>
                  </div>
                  <p className="pb-2 text-xs text-muted-foreground">
                    Guessed from the sample — {sourceHeaders.length} column
                    {sourceHeaders.length === 1 ? "" : "s"}. Override if it looks wrong.
                  </p>
                </div>
              </div>
            </div>
          )}

          {selected && sourceHeaders.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  3
                </span>
                <h2 className="font-medium text-foreground">Destination</h2>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <Button
                  variant={destMode === "existing" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setDestMode("existing")}
                >
                  <Table2 className="mr-2 h-4 w-4" /> Existing table
                </Button>
                <Button
                  variant={destMode === "new" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setDestMode("new")}
                >
                  Create a new table
                </Button>
              </div>

              {destMode === "existing" ? (
                <>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-96 flex-1">
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Target table (DATABASE.SCHEMA.NAME)
                      </label>
                      <Input
                        value={destTable}
                        onChange={(e) => setDestTable(e.target.value)}
                        placeholder="e.g. SPOT_DW.SPOT_SFTP.RATES"
                        className="font-mono text-sm"
                      />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void loadDestColumns()} disabled={destLoading}>
                      {destLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Read columns
                    </Button>
                  </div>
                  {destError && (
                    <div className="mt-3 whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                      {destError}
                    </div>
                  )}
                  {destCols && destCols.length === 0 && !destError && (
                    <p className="mt-2 text-xs text-amber-300">
                      No columns came back. Snowflake reports a missing table and a missing
                      privilege the same way, so this means one or the other — not necessarily
                      that the table is absent.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="max-w-lg">
                    <label className="mb-1 block text-xs text-muted-foreground">
                      New table name (DATABASE.SCHEMA.NAME)
                    </label>
                    <Input
                      value={destTable}
                      onChange={(e) => setDestTable(e.target.value)}
                      placeholder="e.g. SPOT_DW.SPOT_SFTP.RATES"
                      className="font-mono text-sm"
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Columns come from the header, uppercased and stripped to A-Z, 0-9 and
                    underscore. The four metadata columns the standard requires —
                    <code className="mx-1 text-foreground">_FILE</code>
                    <code className="mr-1 text-foreground">_LINE</code>
                    <code className="mr-1 text-foreground">_MODIFIED</code>
                    <code className="mr-1 text-foreground">_UPDATED</code>
                    — are added by the generator, not mapped here.
                  </p>
                </>
              )}

              {targetColumns.length > 0 && (
                <div className="mt-5">
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Column mapping
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {mappedCount} of {sourceHeaders.length} source column
                      {sourceHeaders.length === 1 ? "" : "s"} mapped
                    </span>
                  </div>

                  <div className="max-h-96 overflow-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">#</th>
                          <th className="px-3 py-2 font-medium">Source column</th>
                          <th className="px-3 py-2 font-medium">Sample</th>
                          <th className="px-3 py-2 font-medium">Target</th>
                          {destMode === "new" && <th className="px-3 py-2 font-medium">Type</th>}
                          <th className="px-3 py-2 text-center font-medium">Merge key</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sourceHeaders.map((h, i) => {
                          const target = mapping[i] ?? SKIP_VALUE
                          const isKey = target !== SKIP_VALUE && mergeKeys.includes(target)
                          return (
                            <tr key={i} className="border-t border-border">
                              {/* The ordinal is not decoration: COPY INTO addresses
                                  source fields as $1..$n, so this is the number the
                                  generated statement uses. */}
                              <td className="px-3 py-2 tabular-nums text-muted-foreground">${i + 1}</td>
                              <td className="px-3 py-2 text-foreground">{h}</td>
                              <td className="max-w-40 truncate px-3 py-2 text-muted-foreground">
                                {sampleRows[0]?.[i] ?? "—"}
                              </td>
                              <td className="px-3 py-2">
                                {destMode === "new" ? (
                                  <span className="font-mono text-foreground">
                                    {targetColumns[i]?.COLUMN_NAME ?? "—"}
                                  </span>
                                ) : (
                                  <Select
                                    value={target}
                                    onValueChange={(v) => setMapping((m) => ({ ...m, [i]: v }))}
                                  >
                                    <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={SKIP_VALUE}>— skip —</SelectItem>
                                      {targetColumns.map((c) => (
                                        <SelectItem key={c.COLUMN_NAME} value={c.COLUMN_NAME}>
                                          {c.COLUMN_NAME}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                              </td>
                              {destMode === "new" && (
                                <td className="px-3 py-2">
                                  <Select
                                    value={newTypes[targetColumns[i]?.COLUMN_NAME ?? ""] ?? "VARCHAR(1000)"}
                                    onValueChange={(v) =>
                                      setNewTypes((t) => ({ ...t, [targetColumns[i].COLUMN_NAME]: v }))
                                    }
                                  >
                                    <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {ALLOWED_SQL_TYPES.map((t) => (
                                        <SelectItem key={t} value={t}>{t}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </td>
                              )}
                              <td className="px-3 py-2 text-center">
                                <Checkbox
                                  checked={isKey}
                                  disabled={destMode === "existing" && target === SKIP_VALUE}
                                  onCheckedChange={(v) => {
                                    const col = destMode === "new" ? targetColumns[i]?.COLUMN_NAME : target
                                    if (!col || col === SKIP_VALUE) return
                                    setMergeKeys((k) =>
                                      v === true ? [...new Set([...k, col])] : k.filter((x) => x !== col)
                                    )
                                  }}
                                />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {selected && targetColumns.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  4
                </span>
                <h2 className="font-medium text-foreground">How the load runs</h2>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant={loadMode === "truncate_insert" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLoadMode("truncate_insert")}
                >
                  Truncate and insert
                </Button>
                <Button
                  variant={loadMode === "merge" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLoadMode("merge")}
                >
                  Merge
                </Button>
              </div>

              {loadMode === "merge" ? (
                mergeKeys.length > 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Merging on{" "}
                    <span className="font-mono text-foreground">{mergeKeys.join(", ")}</span>. A row
                    whose key already exists is updated; a new key is inserted.
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-amber-300">
                    No merge key chosen. Without one the merge falls back to
                    <code className="mx-1 text-foreground">(_FILE, _LINE)</code>, which is a
                    file-position key — re-running the same file is safe, but the same record
                    arriving in tomorrow&apos;s differently-named file inserts a duplicate. Tick a
                    business key above.
                  </p>
                )
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  The target is emptied and refilled on every run. Right for a full snapshot;
                  wrong for a feed that only sends the day&apos;s changes.
                </p>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
