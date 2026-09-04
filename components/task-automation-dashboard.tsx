"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
  LogOut,
  RefreshCw,
  Workflow,
} from "lucide-react"
import { cn } from "@/lib/utils"

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

  const [selected, setSelected] = useState<SftpEntry | null>(null)
  const [pattern, setPattern] = useState<string>("")
  const [peek, setPeek] = useState<string[] | null>(null)
  const [peeking, setPeeking] = useState(false)

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
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 text-right font-medium">Size</th>
                        <th className="px-3 py-2 font-medium">Modified</th>
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
                      {entries.map((e) => (
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
                <p className="mt-2 text-xs text-muted-foreground">
                  The header row becomes the source columns for the mapping step.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
