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
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Pause, Play, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { StatTile } from "@/components/spot-report-kit"
import { describeCron, formatWallClock, nextRuns, parseCron, zonedNow } from "@/lib/cron-schedule"
import type { SyncConfig } from "@/lib/sftp-sync-codegen"

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

  const setTask = async (s: SyncRow, action: "resume" | "suspend") => {
    setBusy(s.config.syncName)
    try {
      await fetch("/api/task-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          db: s.config.targetDb,
          schema: s.config.targetSchema,
          syncName: s.config.syncName,
        }),
      })
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Tasks</h2>
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

      {totals && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Runs" value={totals.runs.toLocaleString()} sub={`last ${days} days`} />
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
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
          {totals.notReporting} sync{totals.notReporting === 1 ? "" : "s"} deployed before run
          logging existed and contribute nothing to the figures above. Redeploy them from Current
          jobs — it is <code className="text-foreground">CREATE OR REPLACE</code> throughout and
          changes nothing else about them.
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="mb-3 text-sm font-medium text-foreground">Rows loaded and runs per day</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
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
              <Line yAxisId="rows" type="monotone" dataKey="rows" name="Rows loaded" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line yAxisId="runs" type="monotone" dataKey="runs" name="Runs" stroke="#6366f1" strokeWidth={2} dot={false} />
              <Line yAxisId="runs" type="monotone" dataKey="failed" name="Failed" stroke="#f43f5e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">On a schedule</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Sync</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Next run</th>
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              ) : scheduled.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    Nothing scheduled yet.
                  </td>
                </tr>
              ) : (
                scheduled.map((s) => (
                  <tr key={s.config.syncName} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{s.config.syncName}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.schedule}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground" title="Worked out by this app, not by Snowflake.">
                      {s.taskState?.toLowerCase() === "started" ? s.next : "— (suspended)"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={s.taskState?.toLowerCase() === "started" ? "text-emerald-300" : "text-muted-foreground"}>
                        {s.taskState ?? "not visible"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
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
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
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
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.message ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
