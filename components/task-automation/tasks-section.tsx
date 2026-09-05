"use client"

/**
 * Tasks — what is on a schedule, and what the runs have actually done.
 *
 * Fed by the app's own run log (TSK_SFTP_SYNC_RUNS), written by each generated
 * procedure. Snowflake's own TASK_HISTORY is not used: there is no grant for
 * SNOWFLAKE.ACCOUNT_USAGE, INFORMATION_SCHEMA.TASK_HISTORY covers only tasks
 * this role owns and only about a week, and neither records rows loaded —
 * which is half of what this screen is for.
 *
 * The consequence is stated on the screen rather than hidden: a sync deployed
 * before run logging existed contributes nothing here until it is redeployed.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { History, Loader2, Pause, Pencil, Play, RefreshCw, Trash2, X } from "lucide-react"
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
import { SchedulePicker } from "@/components/task-automation-schedule-picker"
import { SCHEDULE_TZ } from "@/lib/cron-schedule"
import { cn } from "@/lib/utils"
import { StatTile } from "@/components/spot-report-kit"
import { describeCron, formatWallClock, nextRuns, parseCron, zonedNow } from "@/lib/cron-schedule"
import type { SyncConfig } from "@/lib/sftp-sync-codegen"
import { PageHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Banner } from "@/components/kit/banner"

type Run = {
  syncName: string
  startedAt: string | null
  finishedAt: string | null
  status: string
  files: number
  rowsLoaded: number
  rowsInTarget: number | null
  message: string | null
}
type Series = { date: string; runs: number; rows: number; failed: number }
type Totals = {
  runs: number
  succeeded: number
  failed: number
  noChange: number
  rowsLoaded: number
  filesFetched: number
  notReporting: number
}
type SyncRow = { config: SyncConfig; stale: boolean; taskState: string | null }

function statusClass(status: string): string {
  if (/^FAILED/i.test(status)) return "text-rose-300"
  if (status === "SUCCESS") return "text-emerald-300"
  return "text-muted-foreground"
}

export function TasksSection() {
  const [days, setDays] = useState(7)
  const [runs, setRuns] = useState<Run[]>([])
  const [series, setSeries] = useState<Series[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [syncs, setSyncs] = useState<SyncRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftCron, setDraftCron] = useState("0 7 * * *")
  const [confirmDrop, setConfirmDrop] = useState<SyncRow | null>(null)
  const [confirmForce, setConfirmForce] = useState<SyncRow | null>(null)
  const [targetRows, setTargetRows] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(`/api/task-automation/tasks?days=${days}`, { cache: "no-store" }),
        fetch("/api/task-automation/syncs", { cache: "no-store" }),
      ])
      const t = await tRes.json()
      const s = await sRes.json()
      if (!tRes.ok) throw new Error(t.error || `HTTP ${tRes.status}`)
      setRuns(t.runs ?? [])
      setSeries(t.series ?? [])
      setTotals(t.totals ?? null)
      setSyncs(sRes.ok ? (s.syncs ?? []) : [])
      setTargetRows(t.targetRows ?? {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * "Now" in an effect, not during render: this page is server-rendered before
   * it hydrates, and `new Date()` in render gives the server and the client
   * different answers.
   */
  const [now, setNow] = useState<ReturnType<typeof zonedNow> | null>(null)
  useEffect(() => {
    const tick = () => setNow(zonedNow(new Date()))
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [])

  const scheduled = useMemo(
    () =>
      syncs.map((s) => {
        const parsed = parseCron(s.config.scheduleCron)
        const next = parsed.ok && now ? nextRuns(parsed.cron, now, 1).runs[0] : null
        return {
          ...s,
          schedule: parsed.ok ? describeCron(parsed.cron) : s.config.scheduleCron,
          next: next ? formatWallClock(next) : "—",
        }
      }),
    [syncs, now]
  )

  const act = async (s: SyncRow, body: Record<string, unknown>) => {
    setBusy(s.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          db: s.config.targetDb,
          schema: s.config.targetSchema,
          syncName: s.config.syncName,
          ...body,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      if (d.note) setNote(`${s.config.syncName}: ${d.note}`)
      if (d.registered === false) {
        setNote(
          `${s.config.syncName}: the task's schedule changed, but the job list could not be ` +
            `updated — reopening the job will still show the old schedule.`
        )
      }
    } catch (e) {
      setNote(`${s.config.syncName}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      void load()
    }
  }

  const setTask = (s: SyncRow, action: "resume" | "suspend") => act(s, { action })

  /**
   * Rewind the watermark and run.
   *
   * On this screen because this is where a schedule visibly ran and did
   * nothing — the moment someone wants to make it run anyway. Submitted and
   * polled rather than awaited: it re-fetches every matching file.
   */
  const forceReload = async (s: SyncRow) => {
    setBusy(s.config.syncName)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "force",
          db: s.config.targetDb,
          schema: s.config.targetSchema,
          syncName: s.config.syncName,
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
        setNote(`${s.config.syncName}: ${ps.result || ps.error || "finished with no message"}`)
        break
      }
    } catch (e) {
      setNote(`${s.config.syncName}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <PageHeading>Tasks</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            What is on a schedule, and what the last {days} days of runs moved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
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

      {totals && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <StatTile
            label="Runs"
            value={totals.runs.toLocaleString()}
            sub={`all outcomes, ${days} days`}
          />
          <StatTile
            label="Succeeded"
            value={totals.succeeded.toLocaleString()}
            sub="loaded something"
            accent="text-emerald-300"
          />
          <StatTile
            label="Failed"
            value={totals.failed.toLocaleString()}
            sub={totals.failed > 0 ? "needs attention" : "none"}
            accent={totals.failed > 0 ? "text-rose-300" : "text-muted-foreground"}
          />
          <StatTile
            label="No change"
            value={totals.noChange.toLocaleString()}
            sub="nothing new to fetch"
          />
          <StatTile
            label="Rows loaded"
            value={totals.rowsLoaded.toLocaleString()}
            sub="into target tables"
            accent="text-emerald-300"
          />
          <StatTile label="Files fetched" value={totals.filesFetched.toLocaleString()} sub="from SFTP" />
        </div>
      )}

      {totals && totals.notReporting > 0 && (
        <Banner tone="warning">
          {totals.notReporting} sync{totals.notReporting === 1 ? "" : "s"} were built by an older
          generator. They may contribute nothing to the figures above, and they do not check that
          their own load landed — an older sync can report SUCCESS against a target that ended up
          empty. Redeploy them from Current jobs: it is{" "}
          <code className="text-foreground">CREATE OR REPLACE</code> throughout and the task state
          is preserved.
        </Banner>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="mb-3 text-sm font-medium text-foreground">Rows loaded and runs per day</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            {/* Rows is a BAR and the counts are LINES, on purpose. As two
                lines on two axes they were indistinguishable: 605 of an
                800-row axis and 3 of a 4-run axis land within a pixel of each
                other, so the rows series vanished underneath the runs one. */}
            <ComposedChart data={series} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis yAxisId="rows" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis
                yAxisId="runs"
                orientation="right"
                allowDecimals={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "0.875rem" }} />
              <Bar yAxisId="rows" dataKey="rows" name="Rows loaded" fill="#10b981" opacity={0.35} />
              <Line yAxisId="runs" type="monotone" dataKey="runs" name="Runs" stroke="#6366f1" strokeWidth={2} dot={false} />
              <Line yAxisId="runs" type="monotone" dataKey="failed" name="Failed" stroke="#f43f5e" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">On a schedule</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sync</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Task</TableHead>
                <TableHead className="text-right">In target</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : scheduled.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nothing scheduled yet.
                  </TableCell>
                </TableRow>
              ) : (
                scheduled.map((s) => (
                  <TableRow key={s.config.syncName}>
                    <TableCell className="font-medium text-foreground">{s.config.syncName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.schedule}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground" title="Worked out by this app, not by Snowflake.">
                      {s.taskState?.toLowerCase() === "started" ? s.next : "— (suspended)"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className={s.taskState?.toLowerCase() === "started" ? "text-emerald-300" : "text-muted-foreground"}>
                        {s.taskState ?? "not visible"}
                      </span>
                    </TableCell>
                    {/* A scheduled sync reporting NO_CHANGE at an EMPTY table is
                        the state that looks healthy and delivers nothing. */}
                    <TableCell className="text-right font-mono text-xs">
                      <span className={cn(targetRows[s.config.syncName] === 0 ? "text-rose-300" : "text-muted-foreground")}>
                        {targetRows[s.config.syncName] != null
                          ? targetRows[s.config.syncName].toLocaleString()
                          : "—"}
                      </span>
                      {targetRows[s.config.syncName] === 0 && (
                        <p className="text-[10px] text-rose-300">empty</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === s.config.syncName}
                          onClick={() => void setTask(s, s.taskState?.toLowerCase() === "started" ? "suspend" : "resume")}
                        >
                          {busy === s.config.syncName ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : s.taskState?.toLowerCase() === "started" ? (
                            <Pause className="mr-2 h-4 w-4" />
                          ) : (
                            <Play className="mr-2 h-4 w-4" />
                          )}
                          {s.taskState?.toLowerCase() === "started" ? "Suspend" : "Resume"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={busy === s.config.syncName}
                          onClick={() => setConfirmForce(s)}
                          aria-label="Force reload"
                          title="Rewind the watermark and re-load every matching file"
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Change the schedule"
                          title="Change the schedule"
                          onClick={() => {
                            setDraftCron(s.config.scheduleCron)
                            setEditing(editing === s.config.syncName ? null : s.config.syncName)
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-400 hover:text-rose-300"
                          aria-label="Remove the schedule"
                          title="Remove the schedule"
                          onClick={() => setConfirmDrop(s)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
              {scheduled.map((s) =>
                editing === s.config.syncName ? (
                  <TableRow key={`${s.config.syncName}-edit`} className="bg-muted/20">
                    <TableCell colSpan={6} className="py-4">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-medium text-foreground">
                          Schedule for {s.config.syncName}
                        </p>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                          <X className="mr-2 h-4 w-4" /> Cancel
                        </Button>
                      </div>
                      <SchedulePicker value={draftCron} onChange={setDraftCron} timezone={SCHEDULE_TZ} />
                      <div className="mt-3 flex items-center gap-3">
                        <Button
                          disabled={busy === s.config.syncName || draftCron === s.config.scheduleCron}
                          onClick={() => {
                            setEditing(null)
                            void act(s, { action: "reschedule", cron: draftCron })
                          }}
                        >
                          {busy === s.config.syncName ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          Save schedule
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Changes the task in place. Snowflake will not alter a running task, so
                          it is suspended, changed, and put back the way it was found.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">Recent runs</h3>
        <div className="max-h-96 overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60">
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Sync</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Files</th>
                <th className="px-3 py-2 text-right font-medium">Rows</th>
                <th className="px-3 py-2 text-right font-medium">In target</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No runs recorded in this window.
                  </td>
                </tr>
              ) : (
                runs.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                      {r.startedAt ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-foreground">{r.syncName}</td>
                    <td className={cn("px-3 py-1.5 text-xs", statusClass(r.status))}>{r.status}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">{r.files}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-foreground">
                      {r.rowsLoaded.toLocaleString()}
                    </td>
                    {/* The target's count taken immediately after the load. A
                        SUCCESS that loaded rows into a table reading zero is
                        self-contradictory, and showing only "rows loaded" is
                        how that went unnoticed. */}
                    <td
                      className={cn(
                        "px-3 py-1.5 text-right font-mono text-xs",
                        r.rowsLoaded > 0 && r.rowsInTarget === 0
                          ? "text-rose-300"
                          : "text-muted-foreground"
                      )}
                      title={
                        r.rowsLoaded > 0 && r.rowsInTarget === 0
                          ? "Loaded rows, and the target was empty a statement later. Something else is writing to this table."
                          : undefined
                      }
                    >
                      {r.rowsInTarget != null ? r.rowsInTarget.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.message ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!confirmForce} onOpenChange={(o) => !o && setConfirmForce(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force reload {confirmForce?.config.syncName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewinds this sync&apos;s watermark and runs it, so every matching file is fetched
              and loaded again rather than skipped as unchanged. This is what to press when a run
              reported NO_CHANGE and the target is empty.
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

      <AlertDialog open={!!confirmDrop} onOpenChange={(o) => !o && setConfirmDrop(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the schedule for {confirmDrop?.config.syncName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This drops the Snowflake task, so the sync stops running on its own. Everything else
              stays: the procedure, the tables and the data are untouched, you can still Run now,
              and Redeploy from Current jobs recreates the task. To remove the job entirely, use
              Current jobs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmDrop
                setConfirmDrop(null)
                if (t) void act(t, { action: "drop" })
              }}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              Remove schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
