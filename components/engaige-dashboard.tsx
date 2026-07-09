"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Clock,
  Link2,
  ListChecks,
  Loader2,
  LogOut,
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

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"

// Chart colours: dark steps validated for contrast + CVD separation against the
// app's card surface (see the score-group heatmap). blue=success/processed,
// red=failed, aqua=duration.
const C_BLUE = "#3987e5"
const C_RED = "#e66767"
const C_AQUA = "#199e70"

const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 11 }

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number | string; color?: string }[]
  label?: string | number
  suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-foreground">{String(label)}</p>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: String(p.color) }} />
          <span className="text-muted-foreground">{String(p.dataKey)}</span>
          <span className="ml-auto pl-3 font-mono text-foreground">
            {typeof p.value === "number" ? p.value.toLocaleString() : String(p.value)}
            {suffix ?? ""}
          </span>
        </div>
      ))}
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-2 pb-2 pt-4">{children}</div>
    </div>
  )
}

const STATUS_ICON: Record<string, string> = {
  COMPLETED: "✅",
  RUNNING: "⏳",
  FAILED: "❌",
  CANCELLED: "⏹️",
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{message}</span>
    </div>
  )
}

function OkBox({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300">
      <CheckCircle2 className="h-4 w-4" /> {message}
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

/* ============================ Configurations ============================ */

function ConfigsSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [executions, setExecutions] = useState<EngaigeExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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
    setError(null)
    setNotice(null)
    try {
      const res = await jsonFetch(`/api/engaige/configs/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", testMode }),
      })
      setNotice(res.message || "Execution started.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  if (loading) return <Spinner label="Loading configurations…" />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Configurations</h2>
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

      {error && <ErrorBox message={error} />}
      {notice && <OkBox message={notice} />}

      {showForm && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
          <h3 className="font-medium text-foreground">New configuration</h3>
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
            <h3 className="font-medium text-foreground">Map required fields</h3>
            <p className="text-sm text-muted-foreground">
              Map every field for {templateNameFromId(mapStep.templateId)} before the config can
              activate.
            </p>
          </div>
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
          {configs.map((c) => {
            const execs = execByConfig.get(c.configId) ?? []
            const running = c.runningCount > 0
            return (
              <div key={c.configId} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span>{c.isActive ? "🟢" : "🔴"}</span>
                      <h3 className="font-semibold text-foreground">{c.configName}</h3>
                      {c.mappingCount > 0 && (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {c.mappingCount} mappings
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 grid gap-x-8 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
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
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleConfig(c.configId)}
                      >
                        {c.isActive ? "Deactivate" : "Activate"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteConfig(c.configId)}
                        className="text-rose-300 hover:text-rose-200"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    {running ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelRun(c.configId)}
                      >
                        ⏹️ Cancel run
                      </Button>
                    ) : (
                      <div className="flex gap-2">
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
                      </div>
                    )}
                  </div>
                </div>

                {execs.length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recent executions
                    </p>
                    <div className="flex flex-col gap-1 text-sm">
                      {execs.map((e) => (
                        <div key={e.batchId} className="flex flex-wrap items-center gap-x-3 text-muted-foreground">
                          <span>{STATUS_ICON[e.status] ?? "❔"}</span>
                          <span className="text-foreground">{e.startTime ?? "—"}</span>
                          <span>
                            {e.processedRecords}/{e.totalRecords} ({e.failedRecords} failed)
                          </span>
                          <span>
                            {e.durationSeconds != null && e.endTime
                              ? `${e.durationSeconds}s`
                              : "in progress…"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
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

  if (loading) return <Spinner label="Loading configurations…" />

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Column mappings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Map source columns to template fields for active configurations.
        </p>
      </div>
      {error && <ErrorBox message={error} />}
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
                    <table className="w-full text-sm">
                      <tbody>
                        {items.map((mp) => (
                          <tr key={mp.mappingId} className="border-b border-border last:border-0">
                            <td className="px-4 py-2 text-foreground">
                              {mp.targetFieldPath.includes(".")
                                ? mp.targetFieldPath.split(".").pop()
                                : mp.targetFieldPath}
                            </td>
                            <td className="px-4 py-2 font-mono text-muted-foreground">
                              {mp.sourceColumn}
                            </td>
                            <td className="px-4 py-2 text-right">
                              <button
                                onClick={() => deleteMapping(mp.mappingId)}
                                className="text-muted-foreground hover:text-rose-300"
                                aria-label="Delete mapping"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
  const [form, setForm] = useState({
    configId: "",
    taskWindow: TIME_WINDOWS[0],
    scheduleType: "Daily" as string,
    days: daysForScheduleType("Daily") as Record<DayKey, boolean>,
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, a] = await Promise.all([
        jsonFetch("/api/engaige/configs"),
        jsonFetch("/api/engaige/assignments"),
      ])
      const active = (c.configs as EngaigeConfig[]).filter((x) => x.isActive)
      setConfigs(active)
      setAssignments(a.assignments ?? [])
      if (active[0] && !form.configId) setForm((f) => ({ ...f, configId: active[0].configId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const byConfig = useMemo(() => {
    const m = new Map<string, EngaigeAssignment[]>()
    for (const a of assignments) {
      const arr = m.get(a.configId) ?? []
      arr.push(a)
      m.set(a.configId, arr)
    }
    return m
  }, [assignments])

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
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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

  if (loading) return <Spinner label="Loading assignments…" />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Task assignments</h2>
          <p className="mt-1 text-sm text-muted-foreground">Scheduled run windows per configuration.</p>
        </div>
        {!showForm && configs.length > 0 && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add assignment
          </Button>
        )}
      </div>
      {error && <ErrorBox message={error} />}

      {configs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No active configurations.
        </div>
      ) : (
        <>
          {showForm && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
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
              <div className="flex gap-2">
                <Button onClick={addAssignment} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Add assignment
                </Button>
                <Button variant="ghost" onClick={() => setShowForm(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {configs.map((c) => {
            const list = byConfig.get(c.configId) ?? []
            return (
              <div key={c.configId} className="rounded-xl border border-border bg-card p-5">
                <h3 className="mb-2 font-medium text-foreground">{c.configName}</h3>
                {list.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No assignments.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {list.map((a) => (
                      <div
                        key={a.assignmentId}
                        className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
                      >
                        <div className="text-sm">
                          <span className="font-medium text-foreground">{timeLabel(a.taskWindow)}</span>
                          <span className="ml-3 text-muted-foreground">{describeDays(a)}</span>
                          <span className="ml-3">{a.isActive ? "🟢 Active" : "🔴 Inactive"}</span>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => toggle(a.assignmentId)}>
                            Toggle
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(a.assignmentId)}
                            className="text-rose-300 hover:text-rose-200"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

/* =========================== Schedule Editor =========================== */

function ScheduleEditorSection() {
  const [configs, setConfigs] = useState<EngaigeConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [taskWindow, setTaskWindow] = useState(TIME_WINDOWS[0])
  const [scheduleType, setScheduleType] = useState<string>("Daily")
  const [days, setDays] = useState<Record<DayKey, boolean>>(daysForScheduleType("Daily"))

  useEffect(() => {
    jsonFetch("/api/engaige/configs")
      .then((d) => setConfigs((d.configs as EngaigeConfig[]).filter((c) => c.isActive)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  const setType = (t: string) => {
    setScheduleType(t)
    if (t !== "Specific Days") setDays(daysForScheduleType(t as (typeof SCHEDULE_TYPES)[number]))
  }

  const toggleConfig = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const apply = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await jsonFetch("/api/engaige/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configIds: Array.from(selected),
          taskWindow,
          scheduleType,
          days,
          replaceExisting: true,
        }),
      })
      setNotice(`Scheduled ${res.scheduled} configuration(s).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Spinner label="Loading configurations…" />

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Schedule editor</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Apply one time window and schedule to many configurations at once.
        </p>
      </div>
      {error && <ErrorBox message={error} />}
      {notice && <OkBox message={notice} />}

      {configs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No active configurations.
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="mb-2 text-sm font-semibold text-foreground">1. Configurations</h3>
            <div className="flex flex-col gap-1.5">
              {configs.map((c) => (
                <label key={c.configId} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={selected.has(c.configId)}
                    onChange={() => toggleConfig(c.configId)}
                  />
                  {c.configName}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">2. Time window</span>
              <select className={inputCls} value={taskWindow} onChange={(e) => setTaskWindow(e.target.value)}>
                {TIME_WINDOWS.map((t) => (
                  <option key={t} value={t}>
                    {timeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">3. Schedule type</span>
              <select className={inputCls} value={scheduleType} onChange={(e) => setType(e.target.value)}>
                {SCHEDULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {scheduleType === "Specific Days" && (
            <div className="flex flex-wrap gap-3">
              {DAY_KEYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={days[d]}
                    onChange={(e) => setDays({ ...days, [d]: e.target.checked })}
                  />
                  {d.slice(0, 3)}
                </label>
              ))}
            </div>
          )}

          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              {selected.size} configuration(s) at {taskWindow.slice(0, 5)} · {scheduleType}. Existing
              assignments at this time window will be replaced.
            </p>
            <Button onClick={apply} disabled={busy || selected.size === 0}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Apply schedule
            </Button>
          </div>
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
  startTime: string | null
  endTime: string | null
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
        <h2 className="text-2xl font-semibold text-foreground">Monitoring</h2>
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
  const [loading, setLoading] = useState(false)

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
      {error && <ErrorBox message={error} />}
      {summary && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            ["Total batches", summary.totalBatches.toLocaleString()],
            ["Success rate", `${summary.successRate.toFixed(1)}%`],
            ["Total records", summary.totalRecords.toLocaleString()],
            ["Failed records", summary.failedRecords.toLocaleString()],
          ].map(([l, v]) => (
            <div key={l} className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">{l}</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{v}</p>
            </div>
          ))}
        </div>
      )}
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No processing history for these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Configuration</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Records</th>
                <th className="px-3 py-2 font-medium">Failed</th>
                <th className="px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.batchId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    {STATUS_ICON[r.status] ?? "❔"} {r.status}
                  </td>
                  <td className="px-3 py-2 text-foreground">{r.configName}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.startTime ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.processedRecords}/{r.totalRecords}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.failedRecords}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.durationSeconds != null ? `${r.durationSeconds}s` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

  if (loading) return <Spinner label="Loading schedule…" />
  if (error) return <ErrorBox message={error} />

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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Configuration</th>
              <th className="px-4 py-2 font-medium">Scheduled runs</th>
            </tr>
          </thead>
          <tbody>
            {summary.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                  No active configurations.
                </td>
              </tr>
            ) : (
              summary.map((s) => (
                <tr key={s.configName} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-foreground">{s.configName}</td>
                  <td className="px-4 py-2 text-muted-foreground">{s.schedules}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
  const [loading, setLoading] = useState(false)

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
      {error && <ErrorBox message={error} />}
      {chartData.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data for this range.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Daily success rate">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltip suffix="%" />} />
                <Line type="monotone" dataKey="Success %" stroke={C_BLUE} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Average execution duration">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={20}
                  axisLine={{ stroke: "hsl(var(--border))" }} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} />
                <RechartsTooltip content={<ChartTooltip suffix="s" />} />
                <Line type="monotone" dataKey="Avg s" stroke={C_AQUA} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="lg:col-span-2">
            <ChartCard title="Records processed vs failed">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                  <XAxis dataKey="date" tick={axisTick} tickLine={false} minTickGap={16}
                    axisLine={{ stroke: "hsl(var(--border))" }} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <RechartsTooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                  <Bar dataKey="Processed" stackId="v" fill={C_BLUE} radius={[0, 0, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Failed" stackId="v" fill={C_RED} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex gap-4 px-4 pb-2 text-xs text-muted-foreground">
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

/* ============================== Dashboard ============================== */

export function EngaigeDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()
  const [nav, setNav] = useState("configs")

  const navItems = [
    { id: "configs", label: "Configurations", icon: <ClipboardList className="h-4 w-4" /> },
    { id: "mappings", label: "Column Mappings", icon: <Link2 className="h-4 w-4" /> },
    { id: "assignments", label: "Task Assignments", icon: <Clock className="h-4 w-4" /> },
    { id: "schedule", label: "Schedule Editor", icon: <ListChecks className="h-4 w-4" /> },
    { id: "monitoring", label: "Monitoring", icon: <BarChart3 className="h-4 w-4" /> },
  ]

  const render = () => {
    switch (nav) {
      case "mappings":
        return <MappingsSection />
      case "assignments":
        return <AssignmentsSection />
      case "schedule":
        return <ScheduleEditorSection />
      case "monitoring":
        return <MonitoringSection />
      default:
        return <ConfigsSection />
    }
  }

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <Settings2 className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">EngAIge</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Integration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      onClick={() => setNav(item.id)}
                      isActive={nav === item.id}
                      tooltip={item.label}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3">
            <div className="px-2 text-sm">
              <p className="font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="w-full justify-start text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" /> Logout
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" /> Departments
              </Button>
            )}
            <span className="text-sm font-medium text-muted-foreground">EngAIge Integration Manager</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto min-w-0">
          <div className="min-w-0 p-6">{render()}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
