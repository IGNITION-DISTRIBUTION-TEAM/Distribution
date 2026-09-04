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
  Pause,
  Play,
  PlayCircle,
  FlaskConical,
  Table2,
  Workflow,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { buildSyncScript, type SyncConfig } from "@/lib/sftp-sync-codegen"
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
type TestLoadResult = {
  ok: boolean
  error?: string
  failedAt?: string
  steps?: { label: string; ok: boolean; detail?: string }[]
  rowCount?: number
  columns?: string[]
  rows?: (string | number | null)[][]
  file?: { name?: string; size?: number; mtime_epoch?: number } | null
  staging?: string
  target?: string
  targetExists?: boolean
}
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

  // ---- step 5: test the load before anything permanent exists
  const [syncName, setSyncName] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestLoadResult | null>(null)

  // ---- step 6: schedule and deploy
  const [cron, setCron] = useState("0 7 * * *")
  const [warehouse, setWarehouse] = useState("SPOT_WH")
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<
    { deployed: boolean; results?: { label: string; ok: boolean; error?: string }[]; error?: string } | null
  >(null)

  // ---- after deploy: run it, and control the task
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** Counts completed runs so the UI can say when the NO_CHANGE check is due. */
  const [runCount, setRunCount] = useState(0)
  const [taskState, setTaskState] = useState<string | null>(null)
  const [control, setControl] = useState<Record<string, unknown> | null>(null)
  const [taskBusy, setTaskBusy] = useState(false)

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

  /** The config as the generator wants it. Null until it is complete enough. */
  const syncConfig: SyncConfig | null = useMemo(() => {
    if (!selected || !syncName.trim() || !destTable.trim()) return null
    const parts = destTable.trim().split(".")
    if (parts.length !== 3) return null
    const mapped = sourceHeaders
      .map((h, i) => ({ h, i, target: destMode === "new" ? targetColumns[i]?.COLUMN_NAME : mapping[i] }))
      .filter((m) => m.target && m.target !== SKIP_VALUE)
    if (mapped.length === 0) return null
    return {
      syncName: syncName.trim().toUpperCase(),
      endpoint,
      remoteDir: path,
      filePattern: pattern,
      targetDb: parts[0], targetSchema: parts[1], targetTable: parts[2],
      createTable: destMode === "new",
      columns: mapped.map((m) => ({
        source: m.h,
        // 1-based, and the position in the FILE — not the position among the
        // mapped columns. A skipped field must not shift the ones after it.
        ordinal: m.i + 1,
        target: m.target as string,
        type: newTypes[m.target as string] ?? "VARCHAR(1000)",
      })),
      loadMode,
      mergeKeys: loadMode === "merge" ? mergeKeys : [],
      delimiter,
      skipHeader: hasHeader,
      warehouse: warehouse.trim().toUpperCase(),
      scheduleCron: cron.trim(),
      scheduleTz: "Africa/Johannesburg",
      onError: "ABORT_STATEMENT",
    }
  }, [selected, syncName, destTable, sourceHeaders, destMode, targetColumns, mapping,
      newTypes, endpoint, path, pattern, loadMode, mergeKeys, delimiter, hasHeader,
      warehouse, cron])

  /** Preview is generated client-side by the same pure function the server uses. */
  const preview = useMemo(() => {
    if (!syncConfig) return null
    try {
      return { ...buildSyncScript(syncConfig), error: null as string | null }
    } catch (e) {
      return { statements: [], warnings: [], error: e instanceof Error ? e.message : String(e) }
    }
  }, [syncConfig])

  /**
   * Load one file into the staging table and show what Snowflake made of it.
   *
   * Nothing permanent is created — no target table, no procedure, no task —
   * and the control table is not touched, so the first real run still sees the
   * file as new. See app/api/task-automation/test-load/route.ts.
   */
  const testLoad = async () => {
    if (!syncConfig) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch("/api/task-automation/test-load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: syncConfig }),
      })
      const d = await res.json()
      setTestResult(d)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const deploy = async () => {
    if (!syncConfig) return
    setDeploying(true)
    setDeployResult(null)
    try {
      const res = await fetch("/api/task-automation/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: syncConfig, execute: true }),
      })
      const d = await res.json()
      setDeployResult(d)
    } catch (e) {
      setDeployResult({ deployed: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setDeploying(false)
    }
  }

  const syncTarget = useMemo(() => {
    if (!syncConfig) return null
    return { db: syncConfig.targetDb, schema: syncConfig.targetSchema, syncName: syncConfig.syncName }
  }, [syncConfig])

  const refreshStatus = useCallback(async () => {
    if (!syncTarget) return
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", ...syncTarget }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setTaskState(d.taskState ?? null)
      setControl(d.control ?? null)
    } catch {
      // Status is informational; a failure here must not look like a run failure.
    }
  }, [syncTarget])

  const runNow = async () => {
    if (!syncTarget) return
    setRunning(true)
    setRunResult(null)
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", ...syncTarget }),
      })
      const sub = await res.json()
      if (!res.ok || !sub.handle) throw new Error(sub.error || "No statement handle returned")

      // Submitted, not awaited — a backlog of files can outlast one request.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500))
        const pr = await fetch(`/api/task-automation/run?handle=${encodeURIComponent(sub.handle)}`, { cache: "no-store" })
        const ps = (await pr.json()) as { status?: string; error?: string; result?: string }
        if (ps.status === "running") continue
        if (ps.status === "error") { setRunResult({ ok: false, text: ps.error || "Run failed" }); break }
        // `result` is the procedure's own SUCCESS / NO_CHANGE / FAILED line.
        const text = ps.result || "Completed, but the procedure returned nothing."
        setRunResult({ ok: !/^\s*(FAILED|.*: FAILED)/i.test(text), text })
        setRunCount((n) => n + 1)
        break
      }
    } catch (e) {
      setRunResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setRunning(false)
      void refreshStatus()
    }
  }

  const setTask = async (action: "resume" | "suspend") => {
    if (!syncTarget) return
    setTaskBusy(true)
    try {
      await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...syncTarget }),
      })
    } finally {
      setTaskBusy(false)
      void refreshStatus()
    }
  }

  useEffect(() => { if (deployResult?.deployed) void refreshStatus() }, [deployResult, refreshStatus])

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

          {selected && targetColumns.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  5
                </span>
                <h2 className="font-medium text-foreground">Name it, then test the load</h2>
              </div>

              <div className="w-64">
                <label className="mb-1 block text-xs text-muted-foreground">Sync name</label>
                <Input
                  value={syncName}
                  onChange={(e) => setSyncName(e.target.value)}
                  placeholder="ARPU_FEES"
                  className="font-mono text-sm"
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                The name drives every object created — stage, staging table, procedure, task —
                and the key this sync reports under in SFTP_SYNC_CONTROL.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  onClick={() => void testLoad()}
                  disabled={!syncConfig || testing || Boolean(preview?.error)}
                >
                  {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
                  {testing ? "Loading one file..." : "Test load"}
                </Button>
                {!syncConfig && (
                  <p className="text-xs text-muted-foreground">
                    Needs a sync name, a target table and at least one mapped column.
                  </p>
                )}
              </div>

              <p className="mt-3 text-xs text-muted-foreground">
                Pulls <strong className="text-foreground">one</strong> matching file and runs the
                real COPY INTO against a staging table, so you can see the file as Snowflake parses
                it rather than as the browser splits it. It creates the stage and that staging
                table and nothing else — no target table, no procedure, no task — and it leaves
                SFTP_SYNC_CONTROL alone, so the first real run still treats the file as new.
              </p>

              {testResult && !testResult.ok && (
                <div className="mt-4 whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                  {testResult.failedAt ? `${testResult.failedAt}: ` : ""}
                  {testResult.error ?? "The test load failed."}
                </div>
              )}

              {testResult?.steps && testResult.steps.length > 0 && (
                <ul className="mt-4 flex flex-col gap-1">
                  {testResult.steps.map((st, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className={st.ok ? "text-emerald-400" : "text-rose-400"}>
                        {st.ok ? "\u2713" : "\u2717"}
                      </span>
                      <span className="text-foreground">{st.label}</span>
                      {st.detail && <span className="text-muted-foreground">— {st.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {testResult?.ok && testResult.columns && (
                <div className="mt-4">
                  <div className="mb-2 flex flex-col gap-2 text-xs">
                    <span className="w-fit rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-300">
                      {testResult.rowCount ?? 0} row(s) parsed from{" "}
                      {testResult.file?.name ?? "the file"} into{" "}
                      <span className="font-mono">{testResult.staging ?? "the staging table"}</span>
                    </span>
                    <span className="text-amber-300">
                      Staging only.{" "}
                      <span className="font-mono text-foreground">
                        {testResult.target ?? "The target table"}
                      </span>{" "}
                      {testResult.targetExists
                        ? "has not been written to"
                        : "has not been created"}
                      . Step 6 creates the remaining objects and step 7 runs the sync that fills
                      it.
                    </span>
                    <span className="text-muted-foreground">
                      First {testResult.rows?.length ?? 0} rows, under the columns they map to. If
                      the values sit under the wrong heading, or everything landed in one column,
                      the delimiter or the ordinals are wrong — fix step 2 and test again.
                    </span>
                  </div>
                  <div className="max-h-80 overflow-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/60">
                        <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                          {testResult.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(testResult.rows ?? []).map((r, i) => (
                          <tr key={i} className="border-t border-border">
                            {r.map((v, j) => (
                              <td key={j} className="whitespace-nowrap px-3 py-1.5 font-mono text-foreground">
                                {v === null || v === "" ? (
                                  <span className="text-muted-foreground">null</span>
                                ) : (
                                  String(v)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
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
                  6
                </span>
                <h2 className="font-medium text-foreground">Schedule it, create it</h2>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="w-40">
                  <label className="mb-1 block text-xs text-muted-foreground">Warehouse</label>
                  <Input value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="font-mono text-sm" />
                </div>
                <div className="w-56">
                  <label className="mb-1 block text-xs text-muted-foreground">Schedule</label>
                  <Select value={cron} onValueChange={setCron}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0 7 * * *">Daily, 07:00</SelectItem>
                      <SelectItem value="0 5 * * 1-5">Weekdays, 05:00</SelectItem>
                      <SelectItem value="0 6-18 * * *">Hourly, 06:00-18:00</SelectItem>
                      <SelectItem value="0 6-18/2 * * *">Every 2 hours, 06:00-18:00</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="pb-2 text-xs text-muted-foreground">Africa/Johannesburg</p>
              </div>

              {preview?.error && (
                <div className="mt-4 whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                  {preview.error}
                </div>
              )}

              {preview && preview.warnings.length > 0 && (
                <ul className="mt-4 flex flex-col gap-2">
                  {preview.warnings.map((w, i) => (
                    <li key={i} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              {preview && preview.statements.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {preview.statements.length} statements
                  </p>
                  <div className="max-h-96 overflow-auto rounded-md border border-border">
                    {preview.statements.map((st, i) => (
                      <details key={i} className="border-b border-border last:border-b-0">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-foreground hover:bg-muted/40">
                          {i + 1}. {st.label}
                        </summary>
                        <pre className="overflow-x-auto bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          {st.sql}
                        </pre>
                      </details>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={() => void deploy()} disabled={!syncConfig || deploying || Boolean(preview?.error)}>
                  {deploying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                  {deploying ? "Creating..." : "Create in Snowflake"}
                </Button>
                {!syncConfig ? (
                  <p className="text-xs text-muted-foreground">
                    Needs a sync name, a target table and at least one mapped column.
                  </p>
                ) : !testResult?.ok ? (
                  <p className="text-xs text-amber-300">
                    Not tested yet. Step 5 loads one file first, so a wrong delimiter or ordinal
                    shows up before six objects and a schedule exist.
                  </p>
                ) : null}
              </div>

              {deployResult && (
                <div className="mt-4">
                  {deployResult.results && (
                    <ul className="mb-3 flex flex-col gap-1">
                      {deployResult.results.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <span className={r.ok ? "text-emerald-400" : "text-rose-400"}>
                            {r.ok ? "\u2713" : "\u2717"}
                          </span>
                          <span className="text-foreground">{r.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div
                    className={cn(
                      "whitespace-pre-wrap rounded-md border p-3 text-xs",
                      deployResult.deployed
                        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
                        : "border-rose-500/30 bg-rose-500/5 text-rose-300"
                    )}
                  >
                    {deployResult.deployed
                      ? "Created. Run it below before resuming the schedule."
                      : deployResult.error ?? "Failed."}
                  </div>
                </div>
              )}
            </div>
          )}

          {deployResult?.deployed && syncTarget && (
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  7
                </span>
                <h2 className="font-medium text-foreground">Run it, then arm the schedule</h2>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void runNow()} disabled={running}>
                  {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                  {running ? "Running..." : "Run now"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void refreshStatus()}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Refresh status
                </Button>
                <span className="text-xs text-muted-foreground">
                  Task:{" "}
                  <span className={cn("font-medium",
                    taskState?.toLowerCase() === "started" ? "text-emerald-300" : "text-amber-300")}>
                    {taskState ?? "unknown"}
                  </span>
                </span>
                {taskState?.toLowerCase() === "started" ? (
                  <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void setTask("suspend")}>
                    <Pause className="mr-2 h-4 w-4" /> Suspend
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void setTask("resume")}>
                    <Play className="mr-2 h-4 w-4" /> Resume schedule
                  </Button>
                )}
              </div>

              {/* Running once proves it loads. Running twice proves it will not
                  re-load the same file tomorrow, which is the part that actually
                  breaks in production. */}
              <p className="mt-3 text-xs text-muted-foreground">
                {runCount === 0
                  ? "Run it once to load the file."
                  : runCount === 1
                    ? "Now run it again — the second run must say NO_CHANGE. That is what proves change detection works, and it is the only check that catches a sync which would re-load the same file every night."
                    : "Two runs done. If the second said NO_CHANGE, change detection is working and the schedule is safe to arm."}
              </p>

              {runResult && (
                <div
                  className={cn(
                    "mt-3 whitespace-pre-wrap rounded-md border p-3 text-xs",
                    runResult.ok
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
                      : "border-rose-500/30 bg-rose-500/5 text-rose-300"
                  )}
                >
                  {runResult.text}
                </div>
              )}

              {control && (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {([
                    ["Status", control.STATUS],
                    ["Rows in target", control.ROW_COUNT],
                    ["Last synced", control.LAST_SYNCED],
                    ["Watermark", control.LAST_MODIFIED],
                  ] as [string, unknown][]).map(([label, v]) => (
                    <div key={label} className="rounded-lg border border-border bg-background/40 p-3">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                      <p className="mt-1 truncate text-sm text-foreground">{v == null ? "—" : String(v)}</p>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Straight from DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL — the same row every other sync in
                the account reports into. &quot;Watermark&quot; is the newest file mtime seen; only
                files newer than it are fetched next run.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
