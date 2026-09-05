"use client"

/**
 * Current jobs — every sync the app has deployed, with its live state.
 *
 * Three sources, kept distinguishable rather than merged: the registry (what
 * was deployed and how it is configured), SHOW TASKS (whether a schedule
 * exists and is armed) and SFTP_SYNC_CONTROL (what the last run did).
 *
 * Syncs that report into the shared control table but were not deployed by
 * this app — Justin's hand-built ones — are listed separately at the bottom.
 * Merging them in would imply the app knows more about them than it does.
 */
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AlertTriangle, Code2, History, Loader2, Pencil, PlayCircle, RefreshCw, TableProperties, Trash2, UploadCloud } from "lucide-react"
import { cn } from "@/lib/utils"
import { parseCron, describeCron } from "@/lib/cron-schedule"
import { objectNames } from "@/lib/sftp-sync-codegen"
import type { SyncConfig } from "@/lib/sftp-sync-codegen"
import { PageHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Banner } from "@/components/kit/banner"

type SyncRow = {
  config: SyncConfig
  generatorVersion: number
  deployedAt: string | null
  deployedBy: string | null
  stale: boolean
  taskState: string | null
  control: Record<string, unknown> | null
  target: string
  targetHealth: "present" | "missing" | "unknown"
  targetMissing: boolean
  canCreateTarget: boolean
  consecutiveFailures: number | null
  sharesTargetWith: { syncName: string; loadMode: string }[]
  targetRowCount: number | null
}
type Foreign = { syncName: string; control: Record<string, unknown> }

function scheduleText(cron: string): string {
  const p = parseCron(cron)
  return p.ok ? describeCron(p.cron) : cron
}

function controlValue(c: Record<string, unknown> | null, key: string): string {
  if (!c || c[key] == null) return "—"
  return String(c[key])
}

export function CurrentJobsSection({ onOpen }: { onOpen: (config: SyncConfig) => void }) {
  const [rows, setRows] = useState<SyncRow[]>([])
  const [foreign, setForeign] = useState<Foreign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SyncRow | null>(null)
  const [showSql, setShowSql] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/task-automation/syncs", { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setRows(d.syncs ?? [])
      setForeign(d.foreign ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runNow = async (r: SyncRow) => {
    setBusy(r.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run",
          db: r.config.targetDb,
          schema: r.config.targetSchema,
          syncName: r.config.syncName,
        }),
      })
      const sub = await res.json()
      if (!res.ok || !sub.handle) throw new Error(sub.error || "No statement handle returned")
      // Submitted, not awaited — a backlog of files can outlast a request.
      for (;;) {
        await new Promise((x) => setTimeout(x, 2500))
        const pr = await fetch(`/api/task-automation/run?handle=${encodeURIComponent(sub.handle)}`, {
          cache: "no-store",
        })
        const ps = (await pr.json()) as { status?: string; error?: string; result?: string }
        if (ps.status === "running") continue
        setNote(`${r.config.syncName}: ${ps.result || ps.error || "finished with no message"}`)
        break
      }
    } catch (e) {
      setNote(`${r.config.syncName}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      void load()
    }
  }

  const redeploy = async (r: SyncRow) => {
    setBusy(r.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: r.config, execute: true }),
      })
      const d = await res.json()
      setNote(
        d.deployed
          ? `${r.config.syncName}: redeployed. ${d.taskNote ?? ""} ${d.loadLogicNote ?? ""}`.trim()
          : `${r.config.syncName}: ${d.error ?? "redeploy failed"}`
      )
    } catch (e) {
      setNote(`${r.config.syncName}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      void load()
    }
  }

  const [confirmForce, setConfirmForce] = useState<SyncRow | null>(null)

  /**
   * Rewind the watermark and run.
   *
   * The only way to exercise a changed mapping or load mode against a file that
   * has not moved: change detection returns NO_CHANGE before reaching any load
   * logic, so a redeployed job can run, succeed, and never touch the new code.
   */
  const forceReload = async (r: SyncRow) => {
    setBusy(r.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "force",
          db: r.config.targetDb,
          schema: r.config.targetSchema,
          syncName: r.config.syncName,
        }),
      })
      const sub = await res.json()
      if (!res.ok || !sub.handle) throw new Error(sub.error || "No statement handle returned")
      for (;;) {
        await new Promise((x) => setTimeout(x, 2500))
        const pr = await fetch(`/api/task-automation/run?handle=${encodeURIComponent(sub.handle)}`, {
          cache: "no-store",
        })
        const ps = (await pr.json()) as { status?: string; error?: string; result?: string }
        if (ps.status === "running") continue
        setNote(`${r.config.syncName}: ${ps.result || ps.error || "finished with no message"}`)
        break
      }
    } catch (e) {
      setNote(`${r.config.syncName}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      void load()
    }
  }

  const createTarget = async (r: SyncRow) => {
    setBusy(r.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/create-target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncName: r.config.syncName }),
      })
      const d = await res.json()
      setNote(res.ok ? `Created ${d.created}. Run it now to check it loads.` : d.error)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      void load()
    }
  }

  /** Fetched on click: the deployed SQL runs to tens of kilobytes per job. */
  const openSql = async (r: SyncRow) => {
    setShowSql("Loading…")
    try {
      const res = await fetch(
        `/api/task-automation/syncs?sql=${encodeURIComponent(r.config.syncName)}`,
        { cache: "no-store" }
      )
      const d = await res.json()
      setShowSql(
        d.sql ??
          `Nothing recorded for ${r.config.syncName}. Jobs deployed before the registry existed ` +
            `have no stored SQL.`
      )
    } catch (e) {
      setShowSql(e instanceof Error ? e.message : String(e))
    }
  }

  const doDelete = async () => {
    const r = confirmDelete
    setConfirmDelete(null)
    if (!r) return
    setBusy(r.config.syncName)
    try {
      const res = await fetch(
        `/api/task-automation/syncs?name=${encodeURIComponent(r.config.syncName)}`,
        { method: "DELETE" }
      )
      const d = await res.json()
      setNote(
        d.error ??
          `${r.config.syncName}: removed from the job list. The Snowflake objects are still ` +
            `there and ${objectNames(r.config.syncName).task} is still scheduled — ` +
            `scripts/task-automation/drop-sync.sql removes them in the right order.`
      )
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <PageHeading>Current jobs</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Every sync this app has created. Open one to change its mapping or schedule and
            redeploy it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {note && (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
          {note}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sync</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No jobs yet. Create one under Create job — it appears here once it deploys.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.config.syncName} className={cn( "border-b border-border last:border-0 align-top", (r.targetMissing || (r.consecutiveFailures ?? 0)> 0) && "bg-rose-500/5"
                  )}
                >
                  <TableCell>
                    <span className="font-medium text-foreground">{r.config.syncName}</span>
                    {r.targetHealth === "missing" && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300"
                        title={`${r.target} cannot be read. Snowflake reports a missing object and a missing privilege the same way, so it is one or the other.`}
                      >
                        <AlertTriangle className="h-3 w-3" /> target missing
                      </span>
                    )}
                    {r.targetHealth === "unknown" && (
                      <span
                        className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title="The catalogue lookup for this target did not return. This is not the same as the table being fine — it means nobody checked."
                      >
                        target not checked
                      </span>
                    )}
                    {(r.consecutiveFailures ?? 0) > 0 && (
                      <span className="ml-2 rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">
                        {r.consecutiveFailures} failed run{r.consecutiveFailures === 1 ? "" : "s"} in a row
                      </span>
                    )}
                    {r.targetMissing && (
                      <p className="mt-1 text-[10px] text-rose-300">
                        {r.canCreateTarget
                          ? "Redeploy (the cloud icon) recreates it, or use the table icon."
                          : "Set up against an existing table, so its stored types are placeholders — open it, switch Destination to \u201cCreate a new table\u201d and deploy."}
                      </p>
                    )}
                    {r.sharesTargetWith.length > 0 && (
                      <p className="mt-1 text-[10px] text-rose-300">
                        Writes to the same table as{" "}
                        {r.sharesTargetWith.map((o) => `${o.syncName} (${o.loadMode === "merge" ? "merge" : "replace"})`).join(", ")}.
                        Whichever runs last wins, and a replace wipes the other&apos;s rows.
                      </p>
                    )}
                    {r.stale && (
                      <span
                        className="ml-2 rounded border border-amber-500/40 bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-300"
                        title="Built by an older generator: it may not log its runs, and it does not check that its own load actually landed. Redeploy to bring it up to date — CREATE OR REPLACE throughout, and the task state is preserved."
                      >
                        older generator
                      </span>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {r.deployedBy ? `by ${r.deployedBy}` : "—"}
                    </p>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.config.endpoint}:{r.config.remoteDir}/{r.config.filePattern}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.config.targetTable}
                    <span className="ml-1 text-[10px] uppercase">
                      {r.config.loadMode === "merge" ? "merge" : "replace"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {scheduleText(r.config.scheduleCron)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.taskState ? (
                      <span
                        className={
                          r.taskState.toLowerCase() === "started" ? "text-emerald-300" : "text-muted-foreground"
                        }
                      >
                        {r.taskState}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" title="No task found, or it is not owned by this app's Snowflake role.">
                        not visible
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {controlValue(r.control, "STATUS")}
                    <p className="text-[10px]">{controlValue(r.control, "LAST_SYNCED")}</p>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    <span className={cn(
                      r.targetRowCount === 0 && Number(r.control?.ROW_COUNT ?? 0) > 0
                        ? "text-rose-300"
                        : "text-foreground"
                    )}>
                      {r.targetRowCount != null ? r.targetRowCount.toLocaleString() : "—"}
                    </span>
                    {/* The control table's figure is from the last run; the one
                        above is the table right now. They disagreeing is the
                        signature of a target emptied behind the sync's back. */}
                    {r.control?.ROW_COUNT != null &&
                      r.targetRowCount != null &&
                      Number(r.control.ROW_COUNT) !== r.targetRowCount && (
                        <p className="text-[10px] text-rose-300">
                          last run said {Number(r.control.ROW_COUNT).toLocaleString()}
                        </p>
                      )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {r.canCreateTarget && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-amber-300"
                          disabled={busy === r.config.syncName}
                          onClick={() => void createTarget(r)}
                          aria-label="Create the target table"
                          title="Create the target table with the types this job was set up with"
                        >
                          <TableProperties className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void openSql(r)}
                        aria-label="Show the SQL that was deployed"
                        title="Show the SQL that was deployed"
                      >
                        <Code2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onOpen(r.config)}
                        aria-label="Open in the wizard"
                        title="Open in the wizard"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={busy === r.config.syncName}
                        onClick={() => void runNow(r)}
                        aria-label="Run now"
                        title="Run now"
                      >
                        {busy === r.config.syncName ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <PlayCircle className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={busy === r.config.syncName}
                        onClick={() => setConfirmForce(r)}
                        aria-label="Force reload"
                        title="Rewind the watermark and re-load every matching file"
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn("h-8 w-8", r.stale && "text-amber-300")}
                        disabled={busy === r.config.syncName}
                        onClick={() => void redeploy(r)}
                        aria-label="Redeploy"
                        title="Redeploy — CREATE OR REPLACE throughout, safe to press"
                      >
                        <UploadCloud className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-rose-400 hover:text-rose-300"
                        onClick={() => setConfirmDelete(r)}
                        aria-label="Remove from the list"
                        title="Remove from the list"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {rows.some((r) => r.targetMissing && !r.canCreateTarget) && (
        <Banner tone="warning">
          A job whose target is missing but which was set up against an{" "}
          <em>existing</em> table has no Create button: it stored placeholder column types rather
          than the real ones, so building the table from them would give you something that loads
          quietly and holds the wrong types. Open the job, switch Destination to &ldquo;Create a
          new table&rdquo;, choose the types and deploy again.
        </Banner>
      )}

      {showSql !== null && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              SQL that was deployed
            </p>
            <Button variant="ghost" size="sm" onClick={() => setShowSql(null)}>
              Close
            </Button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            {showSql}
          </pre>
        </div>
      )}

      {foreign.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground">Syncs this app did not create</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These report into the shared SFTP_SYNC_CONTROL table but were built elsewhere, so
            there is no configuration to open and no schedule to show. Listed so the picture is
            not misleadingly short.
          </p>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {foreign.map((f) => (
                  <TableRow key={f.syncName}>
                    <TableCell className="font-mono text-xs text-foreground">{f.syncName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{controlValue(f.control, "STATUS")}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{controlValue(f.control, "LAST_SYNCED")}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {f.control?.ROW_COUNT != null ? Number(f.control.ROW_COUNT).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <AlertDialog open={!!confirmForce} onOpenChange={(o) => !o && setConfirmForce(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force reload {confirmForce?.config.syncName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewinds this sync&apos;s watermark to 1970 and runs it, so every matching file is
              fetched and loaded again rather than skipped as unchanged. Use it after changing a
              mapping or load mode, which otherwise sits dormant until the source file changes.
              {confirmForce?.config.loadMode === "merge"
                ? " On merge this re-applies the same rows, so the row count should not move — which is the property worth checking."
                : " On truncate and insert this empties the target and rebuilds it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmForce
                setConfirmForce(null)
                if (t) void forceReload(t)
              }}
            >
              Force reload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmDelete?.config.syncName} from the list?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This deletes one row — the app&apos;s record of the job — so it can no longer be
                  opened, edited or redeployed here. It drops nothing in Snowflake. These stay:
                </p>
                {confirmDelete && (
                  <ul className="rounded-md border border-border bg-background/40 p-2 font-mono text-[11px] leading-relaxed">
                    <li className="text-rose-300">
                      {objectNames(confirmDelete.config.syncName).task} — still on its schedule
                    </li>
                    <li>{objectNames(confirmDelete.config.syncName).proc}</li>
                    <li>{objectNames(confirmDelete.config.syncName).staging}</li>
                    <li>{objectNames(confirmDelete.config.syncName).stage}</li>
                    <li>{confirmDelete.target} — the loaded data</li>
                    <li>SFTP_SYNC_CONTROL row {confirmDelete.config.syncName}</li>
                  </ul>
                )}
                <p>
                  <strong>Suspend the task first</strong> unless you want it to keep running. And
                  note the control row survives: recreating a sync with this name inherits its
                  watermark, so it reports NO_CHANGE for files it already loaded.
                </p>
                <p className="text-muted-foreground">
                  scripts/task-automation/drop-sync.sql removes the rest, in the right order.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doDelete()} className="bg-rose-600 text-white hover:bg-rose-700">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
