"use client"

import { DepartmentShell } from "@/components/department-shell"
import { StatTile } from "@/components/kit/stat-tile"
import { ChartCard, ChartTip } from "@/components/kit/chart"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  BarChart3,
  ChevronDown,
  ClipboardList,
  Clock,
  HelpCircle,
  LayoutDashboard,
  Link2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  ENDPOINT_OPTIONS,
  TEMPLATE_TYPES,
  TEMPLATE_SECTIONS,
  FIELD_TYPE_HINTS,
  templateNameFromId,
  sectionForField,
  TIME_WINDOWS,
  SCHEDULE_TYPES,
  DAY_KEYS,
  daysForScheduleType,
  timeLabel,
  type DayKey,
  type EngaigeConfig,
  type EngaigeMapping,
  type EngaigeAssignment,
  type EngaigeExecution,
} from "@/lib/engaige-shared"
import { Banner } from "@/components/kit/banner"
import { PageHeading, SectionHeading } from "@/components/kit/heading"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SkeletonPanel, SkeletonReport, SkeletonText } from "@/components/kit/skeleton"

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"

// Chart colours: dark steps validated for contrast + CVD separation against the
// app's card surface (see the score-group heatmap). blue=success/processed,
// red=failed, aqua=duration.
const C_BLUE = "#3987e5"
const C_RED = "#e66767"
const C_AQUA = "#199e70"

const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 11 }




const STATUS_ICON: Record<string, string> = {
  COMPLETED: "✅",
  RUNNING: "⏳",
  FAILED: "❌",
  CANCELLED: "⏹️",
}




// Epoch ms → local date-time string in the viewer's timezone.
function fmtLocal(ms: number | null | undefined): string {
  if (ms == null) return "—"
  const d = new Date(ms)
  if (isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

/* =============================== Dashboard ============================= */

type DailyMetric = {
  date: string
  totalBatches: number
  totalRecords: number
  processedRecords: number
  failedRecords: number
  avgDurationSeconds: number
  successRate: number
}

function DashboardSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [metrics, setMetrics] = useState<DailyMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ view: "metrics", start: daysAgoISO(13), end: todayISO() })
      const [c, m] = await Promise.all([
        jsonFetch("/api/engaige/configs"),
        jsonFetch(`/api/engaige/monitoring?${params}`),
      ])
      setConfigs(c.configs ?? [])
      setMetrics(m.metrics ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const totalBatches = metrics.reduce((a, m) => a + m.totalBatches, 0)
  const processed = metrics.reduce((a, m) => a + m.processedRecords, 0)
  const failed = metrics.reduce((a, m) => a + m.failedRecords, 0)
  // Weighted by batches per day, so quiet days don't skew the average.
  const successRate =
    totalBatches > 0
      ? metrics.reduce((a, m) => a + m.successRate * m.totalBatches, 0) / totalBatches
      : 0

  const running = configs.reduce((a, c) => a + c.runningCount, 0)

  const chartData = metrics.map((m) => ({
    date: m.date.slice(5),
    Processed: m.processedRecords,
    Failed: m.failedRecords,
    "Success %": Number(m.successRate.toFixed(1)),
  }))

  if (loading) return <SkeletonReport header={false} tiles={4} charts={2} chartHeight={240} />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <PageHeading>Dashboard</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Integration health at a glance — last 14 days.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatTile size="sm" label="Configurations" value={configs.length.toLocaleString()} />
        <StatTile size="sm"
          label="Active"
          value={configs.filter((c) => c.isActive).length.toLocaleString()}
          tone="success"
        />
        <StatTile size="sm" label="Running now" value={running.toLocaleString()} tone={running > 0 ? "primary" : "muted"} />
        <StatTile size="sm" label="Batches (14d)" value={totalBatches.toLocaleString()} />
        <StatTile size="sm" label="Success rate (14d)" value={`${successRate.toFixed(1)}%`} tone="success" />
        <StatTile size="sm" label="Records (14d)" value={processed.toLocaleString()} />
        <StatTile size="sm" label="Failed (14d)" value={failed.toLocaleString()} tone={failed > 0 ? "danger" : "muted"} />
      </div>

      {chartData.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No executions in the last 14 days.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Records per day" subtitle="Processed vs failed · last 14 days">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                <RechartsTooltip content={<ChartTip />} />
                <Line type="monotone" dataKey="Processed" stroke={C_BLUE} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
                <Line type="monotone" dataKey="Failed" stroke={C_RED} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: C_BLUE }} /> Processed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: C_RED }} /> Failed
              </span>
            </div>
          </ChartCard>

          <ChartCard title="Success rate per day" subtitle="Completed batches as % of all batches">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTip suffix="%" />} />
                <Line type="monotone" dataKey="Success %" stroke={C_AQUA} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}
    </div>
  )
}

/* ============================ Configurations ============================ */

type BatchError = {
  logId: string
  statusCode: number | null
  errorMessage: string
  createdMs: number | null
  request: Record<string, unknown>
  response: Record<string, unknown>
}
type RetryRow = {
  retryId: string
  errorMessage: string
  retryCount: number
  status: string
  nextRetryMs: number | null
  createdMs: number | null
  payload: Record<string, unknown>
}

function JsonDetails({ label, value }: { label: string; value: Record<string, unknown> }) {
  if (Object.keys(value).length === 0) return null
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-xs text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

// Why a batch's records failed — reads both the retry queue (failed records)
// and API_CALL_LOGS (HTTP-level failures).
function BatchErrorsDialog({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [data, setData] = useState<{ errors: BatchError[]; retries: RetryRow[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    jsonFetch(`/api/engaige/monitoring?view=errors&batchId=${encodeURIComponent(batchId)}`)
      .then((d) => setData({ errors: d.errors ?? [], retries: d.retries ?? [] }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [batchId])

  const empty = data && data.errors.length === 0 && data.retries.length === 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Batch errors</DialogTitle>
          <DialogDescription className="font-mono text-xs">{batchId}</DialogDescription>
        </DialogHeader>
        {error && <Banner tone="error">{error}</Banner>}
        {!data && !error && <SkeletonText lines={4} />}
        {empty && (
          <p className="text-sm text-muted-foreground">
            No error rows recorded for this batch in the retry queue or API logs. The failures may
            be logged elsewhere by the EngAIge platform.
          </p>
        )}
        {data && data.retries.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Failed records ({data.retries.length})
            </p>
            <div className="flex flex-col gap-3">
              {data.retries.map((r) => (
                <div key={r.retryId} className="rounded-lg border border-border bg-background/40 p-3">
                  <p className="text-sm text-rose-300">{r.errorMessage || "(no message)"}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.status} · retry {r.retryCount}
                    {r.nextRetryMs ? ` · next ${fmtLocal(r.nextRetryMs)}` : ""} ·{" "}
                    {fmtLocal(r.createdMs)}
                  </p>
                  <JsonDetails label="Record payload" value={r.payload} />
                </div>
              ))}
            </div>
          </div>
        )}
        {data && data.errors.length > 0 && (
          <div>
            <p className="mb-2 mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              API errors ({data.errors.length})
            </p>
            <div className="flex flex-col gap-3">
              {data.errors.map((e) => (
                <div key={e.logId} className="rounded-lg border border-border bg-background/40 p-3">
                  <p className="text-sm text-rose-300">
                    {e.statusCode != null ? `HTTP ${e.statusCode} — ` : ""}
                    {e.errorMessage || "(no message)"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{fmtLocal(e.createdMs)}</p>
                  <JsonDetails label="Request payload" value={e.request} />
                  <JsonDetails label="Response payload" value={e.response} />
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConfigsSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [executions, setExecutions] = useState<EngaigeExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 10
  // Run feedback shown inside the config's own card, where the user clicked.
  const [runMsg, setRunMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [errorBatch, setErrorBatch] = useState<string | null>(null)
  // Inline edit of one config's fields.
  const [editing, setEditing] = useState<{
    configId: string
    configName: string
    sourceTable: string
    endpoint: string
    externalSourceId: string
    eventId: string
    batchSize: number
  } | null>(null)
  const [editErr, setEditErr] = useState<string | null>(null)

  const startEdit = (c: EngaigeConfig) => {
    setEditErr(null)
    setEditing({
      configId: c.configId,
      configName: c.configName,
      sourceTable: c.sourceTable,
      endpoint: c.apiEndpoint.includes("triggerexternalevent")
        ? "/triggerexternalevent"
        : "/externalevent",
      externalSourceId: c.externalSourceId,
      eventId: c.eventId,
      batchSize: c.batchSize,
    })
    setOpenIds((prev) => new Set(prev).add(c.configId))
  }

  const saveEdit = async () => {
    if (!editing) return
    setBusy(true)
    setEditErr(null)
    try {
      await jsonFetch(`/api/engaige/configs/${editing.configId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...editing, action: "update" }),
      })
      setEditing(null)
      await load()
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleOpen = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // New config form
  const [f, setF] = useState({
    configName: "",
    sourceTable: "",
    endpoint: ENDPOINT_OPTIONS[0] as string,
    templateType: "Generic",
    externalSourceId: "",
    eventId: "",
  })
  // Required-mapping step after creating a template config
  const [mapStep, setMapStep] = useState<{
    configId: string
    templateId: string
    sourceTable: string
    columns: string[]
    values: Record<string, string>
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [c, e] = await Promise.all([
        jsonFetch("/api/engaige/configs"),
        jsonFetch("/api/engaige/executions"),
      ])
      setConfigs(c.configs ?? [])
      setExecutions(e.executions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const execByConfig = useMemo(() => {
    const m = new Map<string, EngaigeExecution[]>()
    for (const e of executions) {
      const arr = m.get(e.configId) ?? []
      arr.push(e)
      m.set(e.configId, arr)
    }
    return m
  }, [executions])

  // Search + pagination (client-side; the list arrives in one query).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return configs
    return configs.filter((c) =>
      [c.configName, c.sourceTable, templateNameFromId(c.templateId), c.eventId, c.externalSourceId]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [configs, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const createConfig = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await jsonFetch("/api/engaige/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      })
      if (res.needsMapping) {
        // Load source columns and open the required-mapping step.
        const cols = await jsonFetch(
          `/api/engaige/columns?table=${encodeURIComponent(res.sourceTable)}`
        )
        setMapStep({
          configId: res.configId,
          templateId: res.templateId,
          sourceTable: res.sourceTable,
          columns: cols.columns ?? [],
          values: {},
        })
        setShowForm(false)
      } else {
        setShowForm(false)
        setNotice("Configuration created.")
        await load()
      }
      setF({
        configName: "",
        sourceTable: "",
        endpoint: ENDPOINT_OPTIONS[0],
        templateType: "Generic",
        externalSourceId: "",
        eventId: "",
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveRequiredMappings = async () => {
    if (!mapStep) return
    const sections = TEMPLATE_SECTIONS[mapStep.templateId] ?? {}
    const allFields = Object.values(sections).flat()
    const mappings = allFields
      .map((field) => ({ targetFieldPath: field, sourceColumn: mapStep.values[field] ?? "" }))
      .filter((m) => m.sourceColumn)
    if (mappings.length !== allFields.length) {
      setError("Please map all required fields.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await jsonFetch("/api/engaige/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configId: mapStep.configId, mappings, activate: true }),
      })
      setMapStep(null)
      setNotice("Configuration and mappings created.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const cancelMapStep = async () => {
    if (!mapStep) return
    // The config was created inactive; delete it so we don't leave a stub.
    try {
      await jsonFetch(`/api/engaige/configs/${mapStep.configId}`, { method: "DELETE" })
    } catch {
      // best-effort
    }
    setMapStep(null)
    await load()
  }

  const toggleConfig = async (id: string) => {
    try {
      await jsonFetch(`/api/engaige/configs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteConfig = async (id: string) => {
    try {
      await jsonFetch(`/api/engaige/configs/${id}`, { method: "DELETE" })
      setNotice("Configuration deleted.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runConfig = async (id: string, testMode: boolean) => {
    setBusy(true)
    setRunMsg((m) => ({ ...m, [id]: { ok: true, text: "Running…" } }))
    // Make the outcome visible where the user clicked.
    setOpenIds((prev) => new Set(prev).add(id))
    try {
      const res = await jsonFetch(`/api/engaige/configs/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", testMode }),
      })
      setRunMsg((m) => ({ ...m, [id]: { ok: true, text: res.message || "Execution completed." } }))
      await load()
    } catch (err) {
      setRunMsg((m) => ({
        ...m,
        [id]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setBusy(false)
    }
  }

  const cancelRun = async (id: string) => {
    try {
      await jsonFetch(`/api/engaige/configs/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <SkeletonText lines={8} />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <PageHeading>Configurations</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Integration configs and their test executions.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
          {!showForm && !mapStep && (
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add configuration
            </Button>
          )}
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {showForm && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
          <SectionHeading>New configuration</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Configuration name *</span>
              <input
                className={inputCls}
                value={f.configName}
                onChange={(e) => setF({ ...f, configName: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Source table *</span>
              <input
                className={inputCls}
                value={f.sourceTable}
                onChange={(e) => setF({ ...f, sourceTable: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Endpoint</span>
              <select
                className={inputCls}
                value={f.endpoint}
                onChange={(e) => setF({ ...f, endpoint: e.target.value })}
              >
                {ENDPOINT_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Template type</span>
              <select
                className={inputCls}
                value={f.templateType}
                onChange={(e) => setF({ ...f, templateType: e.target.value })}
              >
                {TEMPLATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">External source ID</span>
              <input
                className={inputCls}
                value={f.externalSourceId}
                onChange={(e) => setF({ ...f, externalSourceId: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Event ID</span>
              <input
                className={inputCls}
                value={f.eventId}
                onChange={(e) => setF({ ...f, eventId: e.target.value })}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button onClick={createConfig} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create configuration
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Template configs (Debicheck / Sale Writeback) require field mappings before they
            activate — you&apos;ll be prompted next.
          </p>
        </div>
      )}

      {mapStep && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
          <div>
            <SectionHeading>Map required fields</SectionHeading>
            <p className="text-sm text-muted-foreground">
              Map every field for {templateNameFromId(mapStep.templateId)} before the config can
              activate.
            </p>
          </div>
          {mapStep.columns.length === 0 && (
            <Banner tone="error">{`No columns visible for ${mapStep.sourceTable}. The app's Snowflake role can't see that table/view — grant USAGE on its schema and REFERENCES (or SELECT) on the object, then retry. See scripts/engaige.sql.`}</Banner>
          )}
          {Object.entries(TEMPLATE_SECTIONS[mapStep.templateId] ?? {}).map(([section, fields]) => (
            <div key={section}>
              <h4 className="mb-2 text-sm font-semibold text-foreground">{section}</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {fields.map((field) => {
                  const hint = FIELD_TYPE_HINTS[mapStep.templateId]?.[field]
                  const label = field.includes(".") ? field.split(".").pop() : field
                  return (
                    <label key={field} className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">
                        {label}
                        {hint ? ` (${hint})` : ""}
                      </span>
                      <select
                        className={inputCls}
                        value={mapStep.values[field] ?? ""}
                        onChange={(e) =>
                          setMapStep({
                            ...mapStep,
                            values: { ...mapStep.values, [field]: e.target.value },
                          })
                        }
                      >
                        <option value="">-- Select column --</option>
                        {mapStep.columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button onClick={saveRequiredMappings} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save mappings
            </Button>
            <Button variant="ghost" onClick={cancelMapStep} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {configs.length === 0 && !showForm ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No configurations yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className={`${inputCls} max-w-sm`}
              placeholder="Search name, source table, template…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <span className="text-sm text-muted-foreground">
              {filtered.length === configs.length
                ? `${configs.length} configuration${configs.length === 1 ? "" : "s"}`
                : `${filtered.length} of ${configs.length} configurations`}
            </span>
          </div>

          {filtered.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              No configurations match &quot;{search}&quot;.
            </div>
          )}

          {paged.map((c) => {
            const execs = execByConfig.get(c.configId) ?? []
            const running = c.runningCount > 0
            const open = openIds.has(c.configId)
            return (
              <Card padding="none" key={c.configId}>
                {/* Collapsed header: expander on the left, all actions inline on the right. */}
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleOpen(c.configId)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                  >
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                        open ? "" : "-rotate-90"
                      }`}
                    />
                    <span>{c.isActive ? "🟢" : "🔴"}</span>
                    <span className="truncate font-semibold text-foreground">{c.configName}</span>
                    {c.mappingCount > 0 && (
                      <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
                        {c.mappingCount} mappings
                      </Badge>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {running ? (
                      <Button variant="outline" size="sm" onClick={() => cancelRun(c.configId)}>
                        ⏹️ Cancel run
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => runConfig(c.configId, true)}
                        >
                          <Play className="mr-1 h-3.5 w-3.5" /> Sample (10)
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => runConfig(c.configId, false)}>
                          <Play className="mr-1 h-3.5 w-3.5" /> Full run
                        </Button>
                      </>
                    )}
                    <Button variant="outline" size="sm" onClick={() => startEdit(c)}>
                      Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => toggleConfig(c.configId)}>
                      {c.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteConfig(c.configId)}
                      className="text-rose-300 hover:text-rose-200"
                      aria-label="Delete configuration"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {runMsg[c.configId] && (
                  <Banner tone={runMsg[c.configId].ok ? "success" : "error"} className="mx-4 mb-3">
                    {runMsg[c.configId].text}
                  </Banner>
                )}

                {open && editing?.configId === c.configId && (
                  <div className="border-t border-border px-4 py-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Configuration name</span>
                        <input
                          className={inputCls}
                          value={editing.configName}
                          onChange={(e) => setEditing({ ...editing, configName: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Source table / view</span>
                        <input
                          className={inputCls}
                          value={editing.sourceTable}
                          onChange={(e) => setEditing({ ...editing, sourceTable: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Endpoint</span>
                        <select
                          className={inputCls}
                          value={editing.endpoint}
                          onChange={(e) => setEditing({ ...editing, endpoint: e.target.value })}
                        >
                          {ENDPOINT_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Batch size</span>
                        <input
                          type="number"
                          min={1}
                          className={inputCls}
                          value={editing.batchSize}
                          onChange={(e) =>
                            setEditing({ ...editing, batchSize: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">External source ID</span>
                        <input
                          className={inputCls}
                          value={editing.externalSourceId}
                          onChange={(e) =>
                            setEditing({ ...editing, externalSourceId: e.target.value })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Event ID</span>
                        <input
                          className={inputCls}
                          value={editing.eventId}
                          onChange={(e) => setEditing({ ...editing, eventId: e.target.value })}
                        />
                      </label>
                    </div>
                    {editErr && (
                      <div className="mt-3">
                        <Banner tone="error">{editErr}</Banner>
                      </div>
                    )}
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" onClick={saveEdit} disabled={busy}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save changes
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(null)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {open && editing?.configId !== c.configId && (
                  <div className="border-t border-border px-4 py-3">
                    <div className="grid gap-x-8 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                      <span>Template: {templateNameFromId(c.templateId)}</span>
                      <span>Source: {c.sourceTable}</span>
                      <span>Batch size: {c.batchSize}</span>
                      <span>
                        Endpoint: /
                        {c.apiEndpoint.includes("triggerexternalevent")
                          ? "triggerexternalevent"
                          : "externalevent"}
                      </span>
                      <span>Source ID: {c.externalSourceId || "—"}</span>
                      <span>Event ID: {c.eventId || "—"}</span>
                      <span>Created: {c.createdAt ?? "—"}</span>
                      <span>Updated: {c.updatedAt ?? "—"}</span>
                    </div>

                    {execs.length > 0 && (
                      <div className="mt-4 border-t border-border pt-3">
                        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Recent executions
                        </p>
                        <div className="flex flex-col gap-1 text-sm">
                          {execs.map((e) => (
                            <div
                              key={e.batchId}
                              className="flex flex-wrap items-center gap-x-3 text-muted-foreground"
                            >
                              <span>{STATUS_ICON[e.status] ?? "❔"}</span>
                              <span className="text-foreground">{fmtLocal(e.startMs)}</span>
                              <span className={e.failedRecords > 0 ? "font-medium text-rose-300" : ""}>
                                {e.processedRecords}/{e.totalRecords} ({e.failedRecords} failed)
                              </span>
                              <span>
                                {e.durationSeconds != null && e.endMs
                                  ? `${e.durationSeconds}s`
                                  : "in progress…"}
                              </span>
                              {e.failedRecords > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setErrorBatch(e.batchId)}
                                  className="text-xs text-rose-300 underline-offset-2 hover:underline"
                                >
                                  View errors
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )
          })}

          {pageCount > 1 && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm text-muted-foreground">
                Showing {safePage * PAGE_SIZE + 1}–
                {Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {safePage + 1} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {errorBatch && (
        <BatchErrorsDialog batchId={errorBatch} onClose={() => setErrorBatch(null)} />
      )}
    </div>
  )
}

/* ============================ Column Mappings =========================== */

function MappingsSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [mappings, setMappings] = useState<EngaigeMapping[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState("")
  const [field, setField] = useState("")
  const [sourceColumn, setSourceColumn] = useState("")

  const selected = configs.find((c) => c.configId === selectedId) ?? null

  useEffect(() => {
    jsonFetch("/api/engaige/configs")
      .then((d) => {
        const active = (d.configs as EngaigeConfig[]).filter((c) => c.isActive)
        setConfigs(active)
        if (active[0]) setSelectedId(active[0].configId)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const loadMappings = useCallback(async (config: EngaigeConfig) => {
    setError(null)
    try {
      const [m, c] = await Promise.all([
        jsonFetch(`/api/engaige/mappings?configId=${config.configId}`),
        jsonFetch(`/api/engaige/columns?table=${encodeURIComponent(config.sourceTable)}`),
      ])
      setMappings(m.mappings ?? [])
      setColumns(c.columns ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (selected) loadMappings(selected)
  }, [selected, loadMappings])

  const sections = selected?.templateId ? TEMPLATE_SECTIONS[selected.templateId] ?? {} : {}
  const fieldOptions = section ? sections[section] ?? [] : []

  const grouped = useMemo(() => {
    const m = new Map<string, EngaigeMapping[]>()
    for (const mp of mappings) {
      const s = sectionForField(selected?.templateId ?? null, mp.targetFieldPath)
      const arr = m.get(s) ?? []
      arr.push(mp)
      m.set(s, arr)
    }
    return m
  }, [mappings, selected])

  const addMapping = async () => {
    if (!selected) return
    const target = selected.templateId ? field : "Direct"
    if (!sourceColumn || (selected.templateId && !field)) {
      setError("Pick a source column and target field.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await jsonFetch("/api/engaige/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configId: selected.configId,
          mappings: [{ sourceColumn, targetFieldPath: target }],
        }),
      })
      setShowForm(false)
      setSection("")
      setField("")
      setSourceColumn("")
      await loadMappings(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteMapping = async (mappingId: string) => {
    if (!selected) return
    try {
      await jsonFetch(`/api/engaige/mappings?mappingId=${mappingId}`, { method: "DELETE" })
      await loadMappings(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) return <SkeletonText lines={8} />

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Column mappings</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Map source columns to template fields for active configurations.
        </p>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {configs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No active configurations. Create and activate one first.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Configuration</span>
              <select
                className={`${inputCls} min-w-64`}
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {configs.map((c) => (
                  <option key={c.configId} value={c.configId}>
                    {c.configName}
                  </option>
                ))}
              </select>
            </label>
            {!showForm && (
              <Button size="sm" onClick={() => setShowForm(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add mapping
              </Button>
            )}
          </div>

          {showForm && selected && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
              {columns.length === 0 && (
                <Banner tone="error">{`No columns visible for ${selected.sourceTable}. The app's Snowflake role can't see that table/view — grant USAGE on its schema and REFERENCES (or SELECT) on the object, then refresh. See scripts/engaige.sql.`}</Banner>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Source column</span>
                  <select
                    className={inputCls}
                    value={sourceColumn}
                    onChange={(e) => setSourceColumn(e.target.value)}
                  >
                    <option value="">-- Select --</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                {selected.templateId ? (
                  <>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Field category</span>
                      <select
                        className={inputCls}
                        value={section}
                        onChange={(e) => {
                          setSection(e.target.value)
                          setField("")
                        }}
                      >
                        <option value="">-- Select --</option>
                        {Object.keys(sections).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Target field</span>
                      <select
                        className={inputCls}
                        value={field}
                        onChange={(e) => setField(e.target.value)}
                        disabled={!section}
                      >
                        <option value="">-- Select --</option>
                        {fieldOptions.map((fld) => (
                          <option key={fld} value={fld}>
                            {fld}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground sm:col-span-2">
                    Generic config — the source column maps directly.
                  </div>
                )}
              </div>
              {selected.templateId && field && FIELD_TYPE_HINTS[selected.templateId]?.[field] && (
                <p className="text-xs text-muted-foreground">
                  Data type: {FIELD_TYPE_HINTS[selected.templateId][field]}
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={addMapping} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Add mapping
                </Button>
                <Button variant="ghost" onClick={() => setShowForm(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 font-medium text-foreground">
              Existing mappings {selected ? `for ${selected.configName}` : ""}
            </h3>
            {mappings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No mappings yet.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {Array.from(grouped.entries()).map(([sec, items]) => (
                  <div key={sec} className="rounded-lg border border-border bg-card">
                    <div className="border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
                      {sec} ({items.length})
                    </div>
                    <Table>
                      <TableBody>
                        {items.map((mp) => (
                          <TableRow key={mp.mappingId}>
                            <TableCell className="px-4 text-foreground">
                              {mp.targetFieldPath.includes(".")
                                ? mp.targetFieldPath.split(".").pop()
                                : mp.targetFieldPath}
                            </TableCell>
                            <TableCell className="px-4 font-mono text-muted-foreground">
                              {mp.sourceColumn}
                            </TableCell>
                            <TableCell className="px-4 text-right">
                              <button
                                onClick={() => deleteMapping(mp.mappingId)}
                                className="text-muted-foreground hover:text-rose-300"
                                aria-label="Delete mapping"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* =========================== Task Assignments ========================== */

function AssignmentsSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [assignments, setAssignments] = useState<EngaigeAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  /**
   * Which config card opened the form, or null when it was opened from the
   * header. The form renders in that card so the schedule is created where the
   * user clicked — hunting for the right entry in a 200-plus native select was
   * the reason these looked unschedulable.
   */
  const [formAnchor, setFormAnchor] = useState<string | null>(null)
  const [form, setForm] = useState({
    configId: "",
    taskWindow: TIME_WINDOWS[0],
    scheduleType: "Daily" as string,
    days: daysForScheduleType("Daily") as Record<DayKey, boolean>,
  })
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all")
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 10
  // Inline edit of one assignment's schedule.
  const [editing, setEditing] = useState<{
    assignmentId: string
    taskWindow: string
    scheduleType: string
    days: Record<DayKey, boolean>
  } | null>(null)
  // Shown inside the inline editor, where the user is actually looking.
  const [editError, setEditError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, a] = await Promise.all([
        jsonFetch("/api/engaige/configs"),
        jsonFetch("/api/engaige/assignments"),
      ])
      // All configs, including inactive — those can be reactivated and
      // scheduled from here ahead of activation.
      const all = c.configs as EngaigeConfig[]
      setConfigs(all)
      setAssignments(a.assignments ?? [])
      if (all[0] && !form.configId) setForm((f) => ({ ...f, configId: all[0].configId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleConfigActive = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await jsonFetch(`/api/engaige/configs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  const configActive = useMemo(
    () => new Map(configs.map((c) => [c.configId, c.isActive])),
    [configs]
  )

  /**
   * An assignment only actually runs when BOTH it and its configuration are
   * active — an active schedule under a switched-off configuration never fires.
   * The filter therefore works on that effective status, not on the assignment
   * flag alone: filtering "Active" used to list inactive configurations because
   * they still held active schedules underneath.
   */
  const isEffectivelyActive = useCallback(
    (a: EngaigeAssignment) => a.isActive && (configActive.get(a.configId) ?? false),
    [configActive]
  )

  const byConfig = useMemo(() => {
    const m = new Map<string, EngaigeAssignment[]>()
    for (const a of assignments) {
      const effective = a.isActive && (configActive.get(a.configId) ?? false)
      if (statusFilter === "active" && !effective) continue
      if (statusFilter === "inactive" && effective) continue
      const arr = m.get(a.configId) ?? []
      arr.push(a)
      m.set(a.configId, arr)
    }
    return m
  }, [assignments, statusFilter, configActive])

  // Search by config name; when a status filter is on, hide configs with no
  // matching assignments so the list only shows relevant groups.
  const visibleConfigs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return configs.filter((c) => {
      if (q && !c.configName.toLowerCase().includes(q)) return false
      if (statusFilter !== "all" && (byConfig.get(c.configId) ?? []).length === 0) return false
      return true
    })
  }, [configs, search, statusFilter, byConfig])

  const pageCount = Math.max(1, Math.ceil(visibleConfigs.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pagedConfigs = visibleConfigs.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const startEdit = (a: EngaigeAssignment) => {
    setEditError(null)
    setEditing({
      assignmentId: a.assignmentId,
      taskWindow: a.taskWindow,
      scheduleType:
        a.scheduleType === "DAILY"
          ? "Daily"
          : a.scheduleType === "WEEKDAYS"
            ? "Weekdays"
            : a.scheduleType === "WEEKENDS"
              ? "Weekends"
              : "Specific Days",
      days: {
        monday: a.monday,
        tuesday: a.tuesday,
        wednesday: a.wednesday,
        thursday: a.thursday,
        friday: a.friday,
        saturday: a.saturday,
        sunday: a.sunday,
      },
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    setBusy(true)
    setEditError(null)
    try {
      await jsonFetch("/api/engaige/assignments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...editing, action: "update" }),
      })
      setEditing(null)
      await load()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const setScheduleType = (t: string) => {
    const days =
      t === "Specific Days"
        ? form.days
        : (daysForScheduleType(t as (typeof SCHEDULE_TYPES)[number]) as Record<DayKey, boolean>)
    setForm({ ...form, scheduleType: t, days })
  }

  const addAssignment = async () => {
    setBusy(true)
    setError(null)
    try {
      await jsonFetch("/api/engaige/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      setShowForm(false)
      setFormAnchor(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openFormFor = (configId: string | null) => {
    setError(null)
    if (configId) setForm((f) => ({ ...f, configId }))
    setFormAnchor(configId)
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setFormAnchor(null)
  }

  /** Rendered in the row's action group, ahead of Edit. */
  const scheduleButton = (configId: string) => (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => openFormFor(configId)}>
      <Plus className="mr-2 h-4 w-4" /> Schedule
    </Button>
  )

  const toggle = async (assignmentId: string) => {
    try {
      await jsonFetch("/api/engaige/assignments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, action: "toggle" }),
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (assignmentId: string) => {
    try {
      await jsonFetch(`/api/engaige/assignments?assignmentId=${assignmentId}`, { method: "DELETE" })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const describeDays = (a: EngaigeAssignment) => {
    const t = a.scheduleType
    if (t === "DAILY") return "Daily"
    if (t === "WEEKDAYS") return "Weekdays (Mon–Fri)"
    if (t === "WEEKENDS") return "Weekends (Sat–Sun)"
    const map: [boolean, string][] = [
      [a.monday, "Mon"], [a.tuesday, "Tue"], [a.wednesday, "Wed"], [a.thursday, "Thu"],
      [a.friday, "Fri"], [a.saturday, "Sat"], [a.sunday, "Sun"],
    ]
    return "Specific: " + map.filter(([v]) => v).map(([, l]) => l).join(", ")
  }

  // One instance, rendered either at the top or inside the card that asked for
  // it — never both at once.
  const assignmentForm = (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-background/40 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Configuration</span>
          <select
            className={inputCls}
            value={form.configId}
            onChange={(e) => setForm({ ...form, configId: e.target.value })}
          >
            {configs.map((c) => (
              <option key={c.configId} value={c.configId}>
                {c.configName}
                {c.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Time window</span>
          <select
            className={inputCls}
            value={form.taskWindow}
            onChange={(e) => setForm({ ...form, taskWindow: e.target.value })}
          >
            {TIME_WINDOWS.map((t) => (
              <option key={t} value={t}>
                {timeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Schedule type</span>
          <select
            className={inputCls}
            value={form.scheduleType}
            onChange={(e) => setScheduleType(e.target.value)}
          >
            {SCHEDULE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {form.scheduleType === "Specific Days" && (
        <div className="flex flex-wrap gap-3">
          {DAY_KEYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm capitalize text-foreground">
              <input
                type="checkbox"
                checked={form.days[d]}
                onChange={(e) => setForm({ ...form, days: { ...form.days, [d]: e.target.checked } })}
              />
              {d.slice(0, 3)}
            </label>
          ))}
        </div>
      )}
      {!configActive.get(form.configId) && (
        <p className="text-xs text-amber-200/80">
          This configuration is switched off — the schedule will be saved but won&apos;t run until you
          activate it.
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={addAssignment} disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Add assignment
        </Button>
        <Button variant="ghost" onClick={closeForm} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )

  if (loading) return <SkeletonText lines={8} />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <PageHeading>Task assignments</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">Scheduled run windows per configuration.</p>
        </div>
        {!showForm && configs.length > 0 && (
          <Button size="sm" onClick={() => openFormFor(null)}>
            <Plus className="mr-2 h-4 w-4" /> Add assignment
          </Button>
        )}
      </div>
      {error && <Banner tone="error">{error}</Banner>}

      {configs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No configurations yet.
        </div>
      ) : (
        <>
          {showForm && formAnchor === null && assignmentForm}

          <div className="flex flex-wrap items-center gap-3">
            <input
              className={`${inputCls} max-w-sm`}
              placeholder="Search configuration…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <div className="inline-flex rounded-md border border-border bg-background/40 p-0.5 text-sm">
              {(
                [
                  ["all", "All"],
                  ["active", "Active"],
                  ["inactive", "Inactive"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setStatusFilter(k)
                    setPage(0)
                  }}
                  className={`rounded px-3 py-1 font-medium transition-colors ${
                    statusFilter === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-sm text-muted-foreground">
              {visibleConfigs.length} configuration{visibleConfigs.length === 1 ? "" : "s"}
              {statusFilter !== "all" && (
                <span className="ml-1">
                  with {statusFilter === "active" ? "a running" : "a non-running"} schedule
                </span>
              )}
            </span>
          </div>

          {visibleConfigs.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Nothing matches the current search/filter.
            </div>
          )}

          {pagedConfigs.map((c) => {
            const list = byConfig.get(c.configId) ?? []
            return (
              <Card padding="dense" key={c.configId}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 font-medium text-foreground">
                    <span>{c.isActive ? "🟢" : "🔴"}</span>
                    {c.configName}
                    {!c.isActive && (
                      <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300">
                        Config inactive
                      </Badge>
                    )}
                  </h3>
                  {!c.isActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => toggleConfigActive(c.configId)}
                    >
                      Activate configuration
                    </Button>
                  )}
                </div>
                {showForm && formAnchor === c.configId && (
                  <div className="mb-3">{assignmentForm}</div>
                )}
                {list.length === 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      {statusFilter === "all" ? "No assignments." : `No ${statusFilter} assignments.`}
                    </p>
                    {scheduleButton(c.configId)}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {list.map((a, i) =>
                      editing?.assignmentId === a.assignmentId ? (
                        <div
                          key={a.assignmentId}
                          className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-background/40 p-3"
                        >
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-muted-foreground">Time window</span>
                              <select
                                className={inputCls}
                                value={editing.taskWindow}
                                onChange={(e) => setEditing({ ...editing, taskWindow: e.target.value })}
                              >
                                {(TIME_WINDOWS.includes(editing.taskWindow)
                                  ? TIME_WINDOWS
                                  : [editing.taskWindow, ...TIME_WINDOWS]
                                ).map((t) => (
                                  <option key={t} value={t}>
                                    {timeLabel(t)}
                                    {!TIME_WINDOWS.includes(t) ? " (current)" : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-muted-foreground">Schedule type</span>
                              <select
                                className={inputCls}
                                value={editing.scheduleType}
                                onChange={(e) => {
                                  const t = e.target.value
                                  setEditing({
                                    ...editing,
                                    scheduleType: t,
                                    days:
                                      t === "Specific Days"
                                        ? editing.days
                                        : daysForScheduleType(t as (typeof SCHEDULE_TYPES)[number]),
                                  })
                                }}
                              >
                                {SCHEDULE_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          {editing.scheduleType === "Specific Days" && (
                            <div className="flex flex-wrap gap-3">
                              {DAY_KEYS.map((d) => (
                                <label
                                  key={d}
                                  className="flex items-center gap-1.5 text-sm capitalize text-foreground"
                                >
                                  <input
                                    type="checkbox"
                                    checked={editing.days[d]}
                                    onChange={(e) =>
                                      setEditing({
                                        ...editing,
                                        days: { ...editing.days, [d]: e.target.checked },
                                      })
                                    }
                                  />
                                  {d.slice(0, 3)}
                                </label>
                              ))}
                            </div>
                          )}
                          {editError && <Banner tone="error">{editError}</Banner>}
                          <div className="flex gap-2">
                            <Button size="sm" onClick={saveEdit} disabled={busy}>
                              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              Save
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={busy}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={a.assignmentId}
                          className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
                        >
                          <div className="text-sm">
                            <span className="font-medium text-foreground">{timeLabel(a.taskWindow)}</span>
                            <span className="ml-3 text-muted-foreground">{describeDays(a)}</span>
                            <Badge
                              variant="outline"
                              className={`ml-3 ${
                                isEffectivelyActive(a)
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                  : a.isActive
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                              }`}
                            >
                              {isEffectivelyActive(a)
                                ? "Active"
                                : a.isActive
                                ? "Won't run"
                                : "Inactive"}
                            </Badge>
                            {a.isActive && !isEffectivelyActive(a) && (
                              <span className="ml-2 text-xs text-amber-200/80">
                                schedule is on, configuration is off
                              </span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {/* Adding a window is a per-config action, so it sits on
                                the first row only — repeating it against every
                                assignment would offer the same button three times. */}
                            {i === 0 && scheduleButton(c.configId)}
                            <Button variant="outline" size="sm" onClick={() => startEdit(a)}>
                              Edit
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => toggle(a.assignmentId)}>
                              {a.isActive ? "Deactivate" : "Activate"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => remove(a.assignmentId)}
                              className="text-rose-300 hover:text-rose-200"
                              aria-label="Delete assignment"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </Card>
            )
          })}

          {pageCount > 1 && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm text-muted-foreground">
                Showing {safePage * PAGE_SIZE + 1}–
                {Math.min((safePage + 1) * PAGE_SIZE, visibleConfigs.length)} of {visibleConfigs.length}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {safePage + 1} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ============================== Monitoring ============================= */

function todayISO(): string {
  // Local date without pulling in a date lib.
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function daysAgoISO(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const pad = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type HistoryRecord = {
  batchId: string
  configName: string
  startMs: number | null
  endMs: number | null
  totalRecords: number
  processedRecords: number
  failedRecords: number
  status: string
  durationSeconds: number | null
}

function MonitoringSection() {
  const [sub, setSub] = useState<"history" | "schedule" | "metrics">("history")
  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Monitoring</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">Processing history, schedules, and metrics.</p>
      </div>
      <div className="inline-flex rounded-md border border-border bg-background/40 p-0.5 text-sm">
        {(
          [
            ["history", "Processing history"],
            ["schedule", "Schedule overview"],
            ["metrics", "Performance metrics"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSub(k)}
            className={`rounded px-3 py-1 font-medium transition-colors ${
              sub === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === "history" && <MonHistory />}
      {sub === "schedule" && <MonSchedule />}
      {sub === "metrics" && <MonMetrics />}
    </div>
  )
}

function MonHistory() {
  const [date, setDate] = useState(todayISO())
  const [status, setStatus] = useState("All")
  const [config, setConfig] = useState("All")
  const [configNames, setConfigNames] = useState<string[]>([])
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [summary, setSummary] = useState<{
    totalBatches: number
    successRate: number
    totalRecords: number
    failedRecords: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    jsonFetch("/api/engaige/monitoring?view=config-names")
      .then((d) => setConfigNames(d.configNames ?? []))
      .catch(() => setConfigNames([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ view: "history", date, status, config })
      const d = await jsonFetch(`/api/engaige/monitoring?${params}`)
      setRecords(d.records ?? [])
      setSummary(d.summary ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [date, status, config])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Date</span>
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            {["All", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Configuration</span>
          <select className={`${inputCls} min-w-48`} value={config} onChange={(e) => setConfig(e.target.value)}>
            {["All", ...configNames].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile size="sm" label="Total batches" value={summary.totalBatches.toLocaleString()} />
          <StatTile size="sm" label="Success rate" value={`${summary.successRate.toFixed(1)}%`} tone="success" />
          <StatTile size="sm" label="Total records" value={summary.totalRecords.toLocaleString()} />
          <StatTile size="sm"
            label="Failed records"
            value={summary.failedRecords.toLocaleString()}
            tone={summary.failedRecords > 0 ? "danger" : "muted"}
          />
        </div>
      )}
      {loading && records.length === 0 ? (
        <SkeletonText lines={6} />
      ) : records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No processing history for these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Configuration</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.batchId}>
                  <TableCell>
                    {STATUS_ICON[r.status] ?? "❔"} {r.status}
                  </TableCell>
                  <TableCell className="text-foreground">{r.configName}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtLocal(r.startMs)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.processedRecords}/{r.totalRecords}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.failedRecords}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.durationSeconds != null ? `${r.durationSeconds}s` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

type ScheduleGridRow = {
  configName: string
  taskWindow: string
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
}

const HEAT_DAYS: { key: keyof ScheduleGridRow; label: string }[] = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
]

function MonSchedule() {
  const [summary, setSummary] = useState<{ configName: string; schedules: string }[]>([])
  const [grid, setGrid] = useState<ScheduleGridRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    jsonFetch("/api/engaige/monitoring?view=schedule")
      .then((d) => {
        setSummary(d.summary ?? [])
        setGrid(d.grid ?? [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Distinct sorted time windows present, and config counts per (time, day).
  const { times, counts, maxCount, namesAt } = useMemo(() => {
    const timeSet = new Set<string>()
    const cnt = new Map<string, number>()
    const names = new Map<string, string[]>()
    for (const r of grid) {
      timeSet.add(r.taskWindow)
      for (const d of HEAT_DAYS) {
        if (!r[d.key]) continue
        const k = `${r.taskWindow}|${d.key}`
        cnt.set(k, (cnt.get(k) ?? 0) + 1)
        const arr = names.get(k) ?? []
        arr.push(r.configName)
        names.set(k, arr)
      }
    }
    const t = Array.from(timeSet).sort()
    return { times: t, counts: cnt, maxCount: Math.max(0, ...cnt.values()), namesAt: names }
  }, [grid])

  const cellColor = (n: number) => {
    if (n === 0) return "rgba(255,255,255,0.02)"
    const t = maxCount <= 1 ? 1 : n / maxCount
    // Single-hue blue ramp, light→dark by intensity.
    return `hsl(213 75% ${58 - t * 26}%)`
  }

  if (loading) return <SkeletonPanel height={240} />
  if (error) return <Banner tone="error">{error}</Banner>

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">Weekly schedule</h3>
          <p className="text-xs text-muted-foreground">
            Active configs scheduled per day &amp; time. Hover a cell for names.
          </p>
        </div>
        {times.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No active task assignments.
          </p>
        ) : (
          <div className="overflow-x-auto p-4">
            <table className="border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="px-2 text-left text-xs font-medium text-muted-foreground">Day</th>
                  {times.map((t) => (
                    <th key={t} className="px-1 text-xs font-medium text-muted-foreground" style={{ minWidth: 44 }}>
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HEAT_DAYS.map((d) => (
                  <tr key={d.key}>
                    <td className="px-2 text-sm text-foreground">{d.label}</td>
                    {times.map((t) => {
                      const k = `${t}|${d.key}`
                      const n = counts.get(k) ?? 0
                      return (
                        <td
                          key={k}
                          title={n > 0 ? `${d.label} ${t}\n${(namesAt.get(k) ?? []).join("\n")}` : `${d.label} ${t}: none`}
                          style={{ backgroundColor: cellColor(n), minWidth: 44, height: 30 }}
                          className="text-center align-middle text-xs font-mono text-foreground/90"
                        >
                          {n > 0 ? n : ""}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Configuration</TableHead>
              <TableHead className="px-4">Scheduled runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                  No active configurations.
                </TableCell>
              </TableRow>
            ) : (
              summary.map((s) => (
                <TableRow key={s.configName}>
                  <TableCell className="px-4 text-foreground">{s.configName}</TableCell>
                  <TableCell className="px-4 text-muted-foreground">{s.schedules}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MonMetrics() {
  const [start, setStart] = useState(daysAgoISO(7))
  const [end, setEnd] = useState(todayISO())
  const [metrics, setMetrics] = useState<
    { date: string; successRate: number; processedRecords: number; failedRecords: number; avgDurationSeconds: number }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ view: "metrics", start, end })
      const d = await jsonFetch(`/api/engaige/monitoring?${params}`)
      setMetrics(d.metrics ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [start, end])

  useEffect(() => {
    load()
  }, [load])

  const chartData = metrics.map((m) => ({
    date: m.date.slice(5),
    "Success %": Number(m.successRate.toFixed(1)),
    Processed: m.processedRecords,
    Failed: m.failedRecords,
    "Avg s": Number(m.avgDurationSeconds.toFixed(1)),
  }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Start</span>
          <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">End</span>
          <input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!loading && chartData.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data for this range.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Daily success rate" loading={loading && chartData.length === 0} height={240}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTip suffix="%" />} />
                <Line type="monotone" dataKey="Success %" stroke={C_BLUE} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Average execution duration" loading={loading && chartData.length === 0} height={240}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTip suffix="s" />} />
                <Line type="monotone" dataKey="Avg s" stroke={C_AQUA} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="lg:col-span-2">
            <ChartCard title="Records processed vs failed" loading={loading && chartData.length === 0} height={240}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                  <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={16}
                    axisLine={{ stroke: "hsl(var(--border))" }} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <RechartsTooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                  <Bar dataKey="Processed" stackId="v" fill={C_BLUE} radius={[0, 0, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Failed" stackId="v" fill={C_RED} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: C_BLUE }} /> Processed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: C_RED }} /> Failed
                </span>
              </div>
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  )
}

/* ================================= Tour =============================== */

type TourStep = {
  nav: string
  title: string
  body: React.ReactNode
}

const TOUR_STEPS: TourStep[] = [
  {
    nav: "dashboard",
    title: "1. Dashboard — the health overview",
    body: (
      <>
        <p>Your starting point. The tiles across the top show, for the last 14 days:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li><b>Configurations / Active / Running now</b> — how many integrations exist, are switched on, and are executing right now.</li>
          <li><b>Batches, Success rate, Records, Failed</b> — how much has run and how much of it succeeded.</li>
        </ul>
        <p>The two line charts show records processed vs failed per day and the daily success rate. Use it to spot a bad day at a glance, then dig in under Monitoring.</p>
      </>
    ),
  },
  {
    nav: "configs",
    title: "2. Configurations — the integrations themselves",
    body: (
      <>
        <p>Each row is one integration (a source view feeding an EngAIge endpoint). Click a row to expand its details and recent runs.</p>
        <ul className="ml-4 list-disc space-y-1">
          <li><b>Search / pages</b> — filter by name, source, or template; the list pages 10 at a time.</li>
          <li><b>Sample (10)</b> — a safe test run of ~10 records. Always start here.</li>
          <li><b>Full run</b> — processes the whole source. Use once a sample looks right.</li>
          <li><b>Edit</b> — change the name, source view, endpoint, batch size, and the Source/Event IDs.</li>
          <li><b>Deactivate</b> — switch the integration off without deleting it.</li>
          <li><b>🗑 Delete</b> — removes the config and its mappings & schedules. Permanent.</li>
          <li><b>View errors</b> (on a run with failures) — opens the exact reason each record failed.</li>
          <li><b>+ Add configuration</b> (top right) — create a new integration.</li>
        </ul>
      </>
    ),
  },
  {
    nav: "mappings",
    title: "3. Column Mappings — match your data to the template",
    body: (
      <>
        <p>Only needed for <b>template</b> configs (Debicheck / Sale Writeback). Pick a configuration, then map each required template field to a column from your source view.</p>
        <p><b>Add mapping</b> creates one link; the 🗑 removes it. Generic configs send the source columns through as-is, so they usually need no mappings here.</p>
      </>
    ),
  },
  {
    nav: "assignments",
    title: "4. Task Assignments — schedule automatic runs",
    body: (
      <>
        <p>Set the times a configuration should run on its own.</p>
        <ul className="ml-4 list-disc space-y-1">
          <li><b>Schedule</b> (on a config card) — adds a run window to that config, with it already picked for you.</li>
          <li><b>Add assignment</b> (top right) — the same form, but you pick the config yourself.</li>
          <li>A config that is switched off can still be scheduled — the schedule just won&apos;t run until you activate it.</li>
          <li><b>Edit</b> — change an existing assignment's time or days.</li>
          <li><b>Activate / Deactivate</b> — pause a schedule without deleting it.</li>
          <li><b>Search &amp; the All/Active/Inactive filter</b> — find assignments quickly.</li>
        </ul>
      </>
    ),
  },
  {
    nav: "monitoring",
    title: "5. Monitoring — history, schedules & performance",
    body: (
      <>
        <p>Three tabs:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li><b>Processing history</b> — every run for a chosen date, filterable by status/config, with totals.</li>
          <li><b>Schedule overview</b> — a weekly heatmap of what runs when, plus a per-config summary.</li>
          <li><b>Performance metrics</b> — success rate, volume, and duration charts over a date range.</li>
        </ul>
        <p>That's the tour — you can reopen it any time from the <b>Tour</b> button in the top bar.</p>
      </>
    ),
  },
]

function EngaigeTour({
  step,
  setStep,
  onNav,
  onClose,
}: {
  step: number
  setStep: (n: number) => void
  onNav: (nav: string) => void
  onClose: () => void
}) {
  const s = TOUR_STEPS[step]
  const last = step === TOUR_STEPS.length - 1
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {TOUR_STEPS.length}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground [&_b]:text-foreground">
          {s.body}
        </div>
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => onNav(s.nav)}>
            Show me this page
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
            {last ? (
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  onNav(TOUR_STEPS[step + 1].nav)
                  setStep(step + 1)
                }}
              >
                Next
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ============================== Dashboard ============================== */

export function EngaigeDashboard({ onBack }: { onBack?: () => void }) {
  const [nav, setNav] = useState("dashboard")
  const [tourOpen, setTourOpen] = useState(false)
  const [tourStep, setTourStep] = useState(0)

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
    { id: "configs", label: "Configurations", icon: <ClipboardList className="h-4 w-4" /> },
    { id: "mappings", label: "Column Mappings", icon: <Link2 className="h-4 w-4" /> },
    { id: "assignments", label: "Task Assignments", icon: <Clock className="h-4 w-4" /> },
    { id: "monitoring", label: "Monitoring", icon: <BarChart3 className="h-4 w-4" /> },
  ]

  const render = () => {
    switch (nav) {
      case "configs":
        return <ConfigsSection />
      case "mappings":
        return <MappingsSection />
      case "assignments":
        return <AssignmentsSection />
      case "monitoring":
        return <MonitoringSection />
      default:
        return <DashboardSection />
    }
  }

  return (
    <>
      <DepartmentShell
        brand={{ icon: <Settings2 />, label: "EngAIge" }}
        nav={[{ id: "integration", label: "Integration", items: navItems }]}
        activeId={nav}
        onNavigate={setNav}
        onBack={onBack}
        headerActions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setTourStep(0)
              setNav("dashboard")
              setTourOpen(true)
            }}
          >
            <HelpCircle className="mr-2 h-4 w-4" />
            Tour
          </Button>
        }
      >
        {render()}
      </DepartmentShell>

      {tourOpen && (
        <EngaigeTour
          step={tourStep}
          setStep={setTourStep}
          onNav={setNav}
          onClose={() => setTourOpen(false)}
        />
      )}
    </>
  )
}
