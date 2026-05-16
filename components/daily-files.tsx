"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  Files,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock as ClockIcon,
  Download,
  Search as SearchIcon,
  Check as CheckIcon,
  ChevronsUpDown,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
} from "recharts"
import { toast } from "sonner"

type DailyTask = {
  TASK_INDEX: number | string
  TASK_NAME: string
  CREATED_AT: string | null
}

function formatCreatedAt(raw: string | null): string {
  if (!raw) return "—"
  // Snowflake TIMESTAMP_NTZ returns as a Unix epoch (seconds, with fractional) string.
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return raw
  const d = new Date(n * 1000)
  return d.toLocaleString()
}

export function DailyFilesContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Daily Files</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          View and manage daily file drops, plus configure the tasks that drive them.
        </p>
      </div>

      <Tabs defaultValue="dashboard" className="w-full">
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardPanel />
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <FilesPanel />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <SettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

type TaskRun = {
  NAME: string | null
  STATE: string | null
  SCHEDULED_TIME: string | null
  COMPLETED_TIME: string | null
}

function todayIso(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function formatSnowflakeTimestamp(raw: string | null): string {
  if (!raw) return "—"
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return raw
  return new Date(n * 1000).toLocaleString()
}

function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground">—</span>
  const s = state.toUpperCase()
  if (s === "SUCCEEDED") {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        {state}
      </Badge>
    )
  }
  if (s === "FAILED" || s === "FAILED_WITH_ERROR") {
    return (
      <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300">
        <XCircle className="mr-1 h-3 w-3" />
        {state}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-200">
      <ClockIcon className="mr-1 h-3 w-3" />
      {state}
    </Badge>
  )
}

type SeriesPoint = { date: string; succeeded: number; failed: number; other: number }

function TrendChart() {
  const [days, setDays] = useState<string>("30")
  const [series, setSeries] = useState<SeriesPoint[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/daily-tasks/runs/timeseries?days=${days}`, {
          cache: "no-store",
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
        setSeries(data.series as SeriesPoint[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [days])

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-foreground">Run trend</h3>
          <p className="text-sm text-muted-foreground">Daily succeeded vs failed task runs.</p>
        </div>
        <Select value={days} onValueChange={setDays}>
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
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="h-64 w-full">
        {loading && !series ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : series && series.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
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
                labelStyle={{ color: "hsl(var(--foreground))" }}
              />
              <Legend wrapperStyle={{ fontSize: "0.875rem" }} />
              <Line
                type="monotone"
                dataKey="succeeded"
                name="Succeeded"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="failed"
                name="Failed"
                stroke="#f43f5e"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No data
          </div>
        )}
      </div>
    </div>
  )
}

function DashboardPanel() {
  return (
    <Tabs defaultValue="task-runs" className="w-full">
      <TabsList>
        <TabsTrigger value="task-runs">Task Runs</TabsTrigger>
        <TabsTrigger value="uploaded-ss">Uploaded to SS</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="ss-check">SS check</TabsTrigger>
      </TabsList>

      <TabsContent value="task-runs" className="mt-4">
        <TaskRunsPanel />
      </TabsContent>

      <TabsContent value="uploaded-ss" className="mt-4">
        <UploadedToSSPanel />
      </TabsContent>

      <TabsContent value="history" className="mt-4">
        <HistoryPanel />
      </TabsContent>

      <TabsContent value="ss-check" className="mt-4">
        <SSCheckPanel />
      </TabsContent>
    </Tabs>
  )
}

type SyncSummaryRow = Record<string, unknown>
type SyncBatchCount = { batchName: string; count: number }

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "number") return String(v)
  const s = String(v)
  // Snowflake numeric timestamps come through as decimal seconds since epoch
  if (/^\d{10}(\.\d+)?$/.test(s)) {
    const n = parseFloat(s)
    if (Number.isFinite(n)) return new Date(n * 1000).toLocaleString()
  }
  return s
}

function UploadedToSSPanel() {
  const [date, setDate] = useState<string>(todayIso())
  const [summary, setSummary] = useState<SyncSummaryRow[] | null>(null)
  const [byBatch, setByBatch] = useState<SyncBatchCount[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedBatches, setSelectedBatches] = useState<string[]>([])
  const [batchPickerOpen, setBatchPickerOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sync-leads?date=${date}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setSummary(data.summary as SyncSummaryRow[])
      setByBatch(data.byBatch as SyncBatchCount[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSummary(null)
      setByBatch(null)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  const allBatchNames = useMemo(
    () => (byBatch ? byBatch.map((r) => r.batchName) : []),
    [byBatch]
  )

  // Default to all batches selected whenever the loaded data changes.
  useEffect(() => {
    setSelectedBatches(allBatchNames)
  }, [allBatchNames.join("|")])

  // Apply batch filter — selected = visible. Empty list = nothing visible.
  const filteredByBatch = useMemo(() => {
    if (!byBatch) return null
    return byBatch.filter((r) => selectedBatches.includes(r.batchName))
  }, [byBatch, selectedBatches])

  // Try to find a BATCH_NAME column on summary rows so we can apply the filter to them too.
  const summaryBatchKey = useMemo(() => {
    if (!summary || summary.length === 0) return null
    return Object.keys(summary[0]).find((k) => k.toUpperCase() === "BATCH_NAME") ?? null
  }, [summary])

  const filteredSummary = useMemo(() => {
    if (!summary) return null
    if (!summaryBatchKey) return summary
    // If a batch column is present, filter SUMMARY rows by it. If a SUMMARY row's
    // batch isn't in the by-batch list (e.g. an aggregate row), keep it visible.
    return summary.filter((r) => {
      const v = r[summaryBatchKey]
      if (v === null || v === undefined) return true
      const sv = String(v)
      if (!allBatchNames.includes(sv)) return true
      return selectedBatches.includes(sv)
    })
  }, [summary, summaryBatchKey, selectedBatches, allBatchNames])

  const toggleBatch = (b: string) =>
    setSelectedBatches((prev) =>
      prev.includes(b) ? prev.filter((p) => p !== b) : [...prev, b]
    )

  const summaryColumns =
    filteredSummary && filteredSummary.length > 0 ? Object.keys(filteredSummary[0]) : []
  const totalNonSummary = filteredByBatch?.reduce((acc, r) => acc + r.count, 0) ?? 0

  const total = allBatchNames.length
  const allSelected = total > 0 && selectedBatches.length === total
  const noneSelected = selectedBatches.length === 0

  const batchTriggerLabel =
    total === 0
      ? "No batches"
      : allSelected
      ? `All batches (${total})`
      : noneSelected
      ? "No batches selected"
      : selectedBatches.length === 1
      ? selectedBatches[0]
      : `${selectedBatches.length} of ${total} batches`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="ss-date" className="mb-2 block text-sm text-muted-foreground">
              Created date
            </Label>
            <Input
              id="ss-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Batch</Label>
            <Popover open={batchPickerOpen} onOpenChange={setBatchPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={batchPickerOpen}
                  className="w-72 justify-between"
                  disabled={allBatchNames.length === 0}
                >
                  <span className="truncate">{batchTriggerLabel}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[min(560px,90vw)] p-0"
                align="start"
              >
                <Command
                  filter={(value, search) =>
                    value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput placeholder="Search batches..." />
                  <CommandList className="max-h-80">
                    <CommandEmpty>No batch matches.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="__select_all__"
                        onSelect={() =>
                          setSelectedBatches(allSelected ? [] : allBatchNames)
                        }
                      >
                        <CheckIcon
                          className={cn(
                            "mr-2 h-4 w-4",
                            allSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="text-xs text-muted-foreground">
                          {allSelected ? "Deselect all" : "Select all"} ({total})
                        </span>
                      </CommandItem>
                      {allBatchNames.map((b) => {
                        const checked = selectedBatches.includes(b)
                        return (
                          <CommandItem key={b} value={b} onSelect={() => toggleBatch(b)}>
                            <CheckIcon
                              className={cn(
                                "mr-2 h-4 w-4 flex-shrink-0",
                                checked ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <span
                              className="break-all font-mono text-sm leading-tight"
                              title={b}
                            >
                              {b}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {!allSelected && total > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {selectedBatches.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => toggleBatch(b)}
                    className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                    title="Click to untick"
                  >
                    <span className="max-w-[18rem] truncate">{b}</span>
                    <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedBatches(allBatchNames)}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Select all
                </button>
              </div>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Summary rows" value={filteredSummary?.length ?? 0} />
        <SummaryCard label="Batches" value={filteredByBatch?.length ?? 0} />
        <SummaryCard label="Lead rows by batch" value={totalNonSummary} accent="success" />
      </div>

      {/* By-batch chart */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-2">
          <h3 className="font-medium text-foreground">Leads per batch</h3>
          <p className="text-sm text-muted-foreground">
            Count of rows for {date} grouped by <span className="font-mono">BATCH_NAME</span>{" "}
            (excludes SUMMARY rows).
          </p>
        </div>
        <div
          className="w-full"
          style={{
            height:
              filteredByBatch && filteredByBatch.length > 0
                ? Math.max(220, filteredByBatch.length * 32 + 40)
                : 220,
          }}
        >
          {loading && !filteredByBatch ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filteredByBatch && filteredByBatch.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={filteredByBatch}
                layout="vertical"
                margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  type="number"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="batchName"
                  width={320}
                  interval={0}
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
                <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No non-SUMMARY rows for {date}.
            </div>
          )}
        </div>
      </div>

      {/* Summary rows — one card per row, key/value grid (no horizontal scroll) */}
      <div>
        <div className="mb-2">
          <h3 className="font-medium text-foreground">Summary rows</h3>
        </div>
        {loading && !filteredSummary ? (
          <div className="flex h-24 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filteredSummary && filteredSummary.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
            No SUMMARY rows for {date}
            {selectedBatches.length > 0 ? " in the selected batches" : ""}.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredSummary?.map((row, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4">
                <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                  {summaryColumns.map((col) => (
                    <div key={col} className="min-w-0">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">{col}</p>
                      <p className="mt-0.5 truncate text-sm text-foreground" title={String(row[col] ?? "")}>
                        {formatCellValue(row[col])}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type SSCheckRow = { batchName: string; leads: number }

function SSCheckPanel() {
  const [rows, setRows] = useState<SSCheckRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedBatches, setSelectedBatches] = useState<string[]>([])
  const [batchPickerOpen, setBatchPickerOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/ss-checks", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      const cleaned: SSCheckRow[] = (data.rows as Array<Record<string, unknown>>)
        .map((r) => ({
          batchName: String(r.BATCHNAME ?? "(unnamed)"),
          leads:
            typeof r.LEADS === "number"
              ? r.LEADS
              : parseInt(String(r.LEADS ?? "0"), 10) || 0,
        }))
        .sort((a, b) => b.leads - a.leads)
      setRows(cleaned)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRows(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const allBatchNames = useMemo(() => (rows ? rows.map((r) => r.batchName) : []), [rows])

  // Default to all batches selected whenever the loaded data changes.
  useEffect(() => {
    setSelectedBatches(allBatchNames)
  }, [allBatchNames.join("|")])

  const toggleBatch = (b: string) =>
    setSelectedBatches((prev) =>
      prev.includes(b) ? prev.filter((p) => p !== b) : [...prev, b]
    )

  const filteredRows = useMemo(
    () => (rows ? rows.filter((r) => selectedBatches.includes(r.batchName)) : null),
    [rows, selectedBatches]
  )

  const totalLeads = filteredRows?.reduce((acc, r) => acc + r.leads, 0) ?? 0
  const batchCount = filteredRows?.length ?? 0
  const total = allBatchNames.length
  const allSelected = total > 0 && selectedBatches.length === total
  const noneSelected = selectedBatches.length === 0

  const batchTriggerLabel =
    total === 0
      ? "No batches"
      : allSelected
      ? `All batches (${total})`
      : noneSelected
      ? "No batches selected"
      : selectedBatches.length === 1
      ? selectedBatches[0]
      : `${selectedBatches.length} of ${total} batches`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label className="mb-2 block text-sm text-muted-foreground">Batch</Label>
          <Popover open={batchPickerOpen} onOpenChange={setBatchPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={batchPickerOpen}
                className="w-72 justify-between"
                disabled={total === 0}
              >
                <span className="truncate">{batchTriggerLabel}</span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(560px,90vw)] p-0" align="start">
              <Command
                filter={(value, search) =>
                  value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                }
              >
                <CommandInput placeholder="Search batches..." />
                <CommandList className="max-h-80">
                  <CommandEmpty>No batch matches.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value="__select_all__"
                      onSelect={() =>
                        setSelectedBatches(allSelected ? [] : allBatchNames)
                      }
                    >
                      <CheckIcon
                        className={cn(
                          "mr-2 h-4 w-4",
                          allSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="text-xs text-muted-foreground">
                        {allSelected ? "Deselect all" : "Select all"} ({total})
                      </span>
                    </CommandItem>
                    {allBatchNames.map((b) => {
                      const checked = selectedBatches.includes(b)
                      return (
                        <CommandItem key={b} value={b} onSelect={() => toggleBatch(b)}>
                          <CheckIcon
                            className={cn(
                              "mr-2 h-4 w-4 flex-shrink-0",
                              checked ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span
                            className="break-all font-mono text-sm leading-tight"
                            title={b}
                          >
                            {b}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {!allSelected && total > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {selectedBatches.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => toggleBatch(b)}
                  className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                >
                  <span className="max-w-[18rem] truncate">{b}</span>
                  <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSelectedBatches(allBatchNames)}
                className="ml-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Select all
              </button>
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Batches" value={batchCount} />
        <SummaryCard label="Total leads" value={totalLeads} accent="success" />
      </div>

      {/* Bar chart — leads per batch */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-2">
          <h3 className="font-medium text-foreground">Leads per batch</h3>
        </div>
        <div
          className="w-full"
          style={{
            height:
              filteredRows && filteredRows.length > 0
                ? Math.max(220, filteredRows.length * 32 + 40)
                : 220,
          }}
        >
          {loading && !filteredRows ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filteredRows && filteredRows.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={filteredRows}
                layout="vertical"
                margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  type="number"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="batchName"
                  width={320}
                  interval={0}
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
                <Bar dataKey="leads" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {noneSelected ? "No batches selected." : "No rows."}
            </div>
          )}
        </div>
      </div>

      {/* Detail table */}
      <div>
        <div className="mb-2">
          <h3 className="font-medium text-foreground">Detail</h3>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch name</TableHead>
                <TableHead className="text-right">Leads</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !filteredRows ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-24 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : filteredRows && filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-24 text-center text-muted-foreground">
                    {noneSelected ? "No batches selected." : "No rows."}
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows?.map((r, i) => (
                  <TableRow key={`${r.batchName}-${i}`}>
                    <TableCell className="font-mono text-sm">{r.batchName}</TableCell>
                    <TableCell className="text-right font-mono">{r.leads}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

type HistoryItem = { batchName: string; campaignId: string | null; count: number }

function HistoryPanel() {
  const [date, setDate] = useState<string>(todayIso())
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedBatches, setSelectedBatches] = useState<string[]>([])
  const [batchPickerOpen, setBatchPickerOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/history-leads?date=${date}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setItems(data.items as HistoryItem[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setItems(null)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  const allBatchNames = useMemo(() => {
    if (!items) return []
    return Array.from(new Set(items.map((r) => r.batchName))).sort()
  }, [items])

  // Default to all batches selected whenever the loaded data changes.
  useEffect(() => {
    setSelectedBatches(allBatchNames)
  }, [allBatchNames.join("|")])

  const total = allBatchNames.length
  const allSelected = total > 0 && selectedBatches.length === total
  const noneSelected = selectedBatches.length === 0

  const toggleBatch = (b: string) =>
    setSelectedBatches((prev) =>
      prev.includes(b) ? prev.filter((p) => p !== b) : [...prev, b]
    )

  const filteredItems = useMemo(() => {
    if (!items) return []
    return items.filter((r) => selectedBatches.includes(r.batchName))
  }, [items, selectedBatches])

  const totalCount = filteredItems.reduce((acc, r) => acc + r.count, 0)
  const distinctBatches = new Set(filteredItems.map((r) => r.batchName)).size
  const distinctCampaigns = new Set(filteredItems.map((r) => r.campaignId ?? "")).size

  // Chart: when one batch selected → break down by campaign within it.
  // Otherwise (zero or many) → bar per batch (filtered).
  const singleBatch = selectedBatches.length === 1 ? selectedBatches[0] : null
  const chartData = useMemo(() => {
    if (singleBatch) {
      return filteredItems
        .map((r) => ({ label: r.campaignId ?? "(no id)", count: r.count }))
        .sort((a, b) => b.count - a.count)
    }
    const byBatch = new Map<string, number>()
    for (const r of filteredItems) {
      byBatch.set(r.batchName, (byBatch.get(r.batchName) ?? 0) + r.count)
    }
    return Array.from(byBatch.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
  }, [filteredItems, singleBatch])

  const batchTriggerLabel =
    total === 0
      ? "No batches"
      : allSelected
      ? `All batches (${total})`
      : noneSelected
      ? "No batches selected"
      : selectedBatches.length === 1
      ? selectedBatches[0]
      : `${selectedBatches.length} of ${total} batches`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="hist-date" className="mb-2 block text-sm text-muted-foreground">
              Created on
            </Label>
            <Input
              id="hist-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Batch</Label>
            <Popover open={batchPickerOpen} onOpenChange={setBatchPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={batchPickerOpen}
                  className="w-72 justify-between"
                  disabled={total === 0}
                >
                  <span className="truncate">{batchTriggerLabel}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(560px,90vw)] p-0" align="start">
                <Command
                  filter={(value, search) =>
                    value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput placeholder="Search batches..." />
                  <CommandList className="max-h-80">
                    <CommandEmpty>No batch matches.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="__select_all__"
                        onSelect={() =>
                          setSelectedBatches(allSelected ? [] : allBatchNames)
                        }
                      >
                        <CheckIcon
                          className={cn(
                            "mr-2 h-4 w-4",
                            allSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="text-xs text-muted-foreground">
                          {allSelected ? "Deselect all" : "Select all"} ({total})
                        </span>
                      </CommandItem>
                      {allBatchNames.map((b) => {
                        const checked = selectedBatches.includes(b)
                        return (
                          <CommandItem key={b} value={b} onSelect={() => toggleBatch(b)}>
                            <CheckIcon
                              className={cn(
                                "mr-2 h-4 w-4 flex-shrink-0",
                                checked ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <span
                              className="break-all font-mono text-sm leading-tight"
                              title={b}
                            >
                              {b}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {!allSelected && total > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {selectedBatches.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => toggleBatch(b)}
                    className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                  >
                    <span className="max-w-[18rem] truncate">{b}</span>
                    <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedBatches(allBatchNames)}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Select all
                </button>
              </div>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Total leads" value={totalCount} accent="success" />
        <SummaryCard label="Batches" value={distinctBatches} />
        <SummaryCard label="Campaigns" value={distinctCampaigns} />
      </div>

      {/* Chart */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-2">
          <h3 className="font-medium text-foreground">
            {singleBatch ? `Leads per campaign — ${singleBatch}` : "Leads per batch"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {date} · <span className="font-mono">ESTATUS IS NULL</span>
          </p>
        </div>
        <div
          className="w-full"
          style={{
            height: chartData.length > 0 ? Math.max(220, chartData.length * 32 + 40) : 220,
          }}
        >
          {loading && !items ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  type="number"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={320}
                  interval={0}
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
                <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No history rows for {date}
              {!allSelected
                ? noneSelected
                  ? " (no batches selected)"
                  : ` for ${selectedBatches.length} of ${total} batches`
                : ""}.
            </div>
          )}
        </div>
      </div>

      {/* Detail table */}
      <div>
        <div className="mb-2">
          <h3 className="font-medium text-foreground">Detail</h3>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch name</TableHead>
                <TableHead>Campaign ID</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !items ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : filteredItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    No matching rows.
                  </TableCell>
                </TableRow>
              ) : (
                filteredItems.map((r, i) => (
                  <TableRow key={`${r.batchName}-${r.campaignId}-${i}`}>
                    <TableCell className="font-mono text-sm">{r.batchName}</TableCell>
                    <TableCell className="font-mono text-sm">{r.campaignId ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{r.count}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

function TaskRunsPanel() {
  const [date, setDate] = useState<string>(todayIso())
  const [onlySucceeded, setOnlySucceeded] = useState(false)
  const [runs, setRuns] = useState<TaskRun[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ date })
      if (onlySucceeded) params.set("state", "SUCCEEDED")
      const res = await fetch(`/api/daily-tasks/runs?${params.toString()}`, {
        cache: "no-store",
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load runs (${res.status})`)
      setRuns(data.rows as TaskRun[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRuns(null)
    } finally {
      setLoading(false)
    }
  }, [date, onlySucceeded])

  useEffect(() => {
    load()
  }, [load])

  const succeededCount = runs?.filter((r) => r.STATE?.toUpperCase() === "SUCCEEDED").length ?? 0
  const failedCount =
    runs?.filter((r) => {
      const s = r.STATE?.toUpperCase() ?? ""
      return s === "FAILED" || s === "FAILED_WITH_ERROR"
    }).length ?? 0

  return (
    <div className="flex flex-col gap-4">
      <TrendChart />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="run-date" className="mb-2 block text-sm text-muted-foreground">
              Scheduled date
            </Label>
            <Input
              id="run-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <input
              id="only-succeeded"
              type="checkbox"
              checked={onlySucceeded}
              onChange={(e) => setOnlySucceeded(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-background"
            />
            <Label htmlFor="only-succeeded" className="cursor-pointer text-sm">
              Only successful runs
            </Label>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {runs && (
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label="Total runs" value={runs.length} />
          <SummaryCard label="Succeeded" value={succeededCount} accent="success" />
          <SummaryCard label="Failed" value={failedCount} accent={failedCount > 0 ? "danger" : "muted"} />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Scheduled</TableHead>
              <TableHead>Completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !runs ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : runs && runs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No runs found for {date}
                  {onlySucceeded ? " with state SUCCEEDED" : ""}.
                </TableCell>
              </TableRow>
            ) : (
              runs?.map((run, i) => (
                <TableRow key={`${run.NAME}-${run.SCHEDULED_TIME}-${i}`}>
                  <TableCell className="font-mono">{run.NAME ?? "—"}</TableCell>
                  <TableCell>
                    <StateBadge state={run.STATE} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatSnowflakeTimestamp(run.SCHEDULED_TIME)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatSnowflakeTimestamp(run.COMPLETED_TIME)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "success" | "danger" | "muted"
}) {
  const cls =
    accent === "success"
      ? "text-emerald-400"
      : accent === "danger"
      ? "text-rose-400"
      : accent === "muted"
      ? "text-muted-foreground"
      : "text-foreground"
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${cls}`}>{value}</p>
    </div>
  )
}

type DiallerView = {
  TABLE_INDEX: number | string
  TABLE_NAME: string
  CREATED_AT: string | null
}

function FilesPanel() {
  const [views, setViews] = useState<DiallerView[] | null>(null)
  const [loadingViews, setLoadingViews] = useState(true)
  const [viewsError, setViewsError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [downloadingIdx, setDownloadingIdx] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)

  const loadViews = useCallback(async () => {
    setLoadingViews(true)
    setViewsError(null)
    try {
      const res = await fetch("/api/dialler-tables", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load views (${res.status})`)
      setViews(data.rows as DiallerView[])
    } catch (err) {
      setViewsError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingViews(false)
    }
  }, [])

  useEffect(() => {
    loadViews()
  }, [loadViews])

  const filteredViews = useMemo(() => {
    if (!views) return []
    if (!filter.trim()) return views
    const f = filter.toLowerCase()
    return views.filter(
      (v) =>
        v.TABLE_NAME.toLowerCase().includes(f) || String(v.TABLE_INDEX).includes(f)
    )
  }, [views, filter])

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const downloadCsv = async (row: DiallerView) => {
    const idxKey = String(row.TABLE_INDEX)
    setDownloadingIdx(idxKey)
    try {
      const res = await fetch(`/api/dialler-tables/${row.TABLE_INDEX}/csv`)
      if (!res.ok) {
        let msg = `Download failed (${res.status})`
        try {
          const err = await res.json()
          if (err.error) msg = err.error
        } catch {
          /* ignore */
        }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const disposition = res.headers.get("Content-Disposition") ?? ""
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match ? match[1] : `view_${row.TABLE_INDEX}.csv`
      const rowCount = res.headers.get("X-Row-Count")
      triggerBlobDownload(blob, filename)
      toast.success(`Downloaded ${filename}${rowCount ? ` (${rowCount} rows)` : ""}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloadingIdx(null)
    }
  }

  const downloadSelected = async () => {
    if (selected.size === 0 || !views) return
    // If only one selected, just stream that single CSV.
    if (selected.size === 1) {
      const onlyIdx = Array.from(selected)[0]
      const row = views.find((v) => String(v.TABLE_INDEX) === onlyIdx)
      if (row) await downloadCsv(row)
      return
    }

    setBatchDownloading(true)
    try {
      const indices = Array.from(selected).map((s) => parseInt(s, 10))
      const res = await fetch("/api/dialler-tables/csv-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices }),
      })
      if (!res.ok) {
        let msg = `Batch download failed (${res.status})`
        try {
          const err = await res.json()
          if (err.error) msg = err.error
        } catch {
          /* ignore */
        }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const disposition = res.headers.get("Content-Disposition") ?? ""
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match ? match[1] : "dialler_views.zip"
      const fileCount = res.headers.get("X-File-Count")
      const errorCount = res.headers.get("X-Error-Count")
      triggerBlobDownload(blob, filename)
      const errSuffix = errorCount && errorCount !== "0" ? ` (${errorCount} failed — see _errors.txt)` : ""
      toast.success(`Downloaded ${filename} with ${fileCount ?? "?"} CSVs${errSuffix}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBatchDownloading(false)
    }
  }

  const toggleOne = (idxKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idxKey)) next.delete(idxKey)
      else next.add(idxKey)
      return next
    })
  }

  const allFilteredSelected =
    filteredViews.length > 0 && filteredViews.every((v) => selected.has(String(v.TABLE_INDEX)))
  const someFilteredSelected =
    !allFilteredSelected && filteredViews.some((v) => selected.has(String(v.TABLE_INDEX)))

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        for (const v of filteredViews) next.delete(String(v.TABLE_INDEX))
      } else {
        for (const v of filteredViews) next.add(String(v.TABLE_INDEX))
      }
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex-1 min-w-[280px]">
          <Label htmlFor="view-filter" className="mb-2 block text-sm text-muted-foreground">
            Filter views
          </Label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="view-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by table name or index..."
              className="pl-9"
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadViews} disabled={loadingViews}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loadingViews ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {viewsError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {viewsError}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {views ? `${filteredViews.length} of ${views.length} views` : ""}
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={batchDownloading}>
              Clear selection
            </Button>
          )}
          <Button
            size="sm"
            onClick={downloadSelected}
            disabled={selected.size === 0 || batchDownloading || !!downloadingIdx}
          >
            {batchDownloading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Building ZIP...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {selected.size <= 1
                  ? `Download${selected.size === 1 ? " (1)" : ""}`
                  : `Download ${selected.size} as ZIP`}
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <input
                  type="checkbox"
                  aria-label="Select all filtered views"
                  className="h-4 w-4 rounded border-border bg-background"
                  checked={allFilteredSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someFilteredSelected
                  }}
                  onChange={toggleAllFiltered}
                  disabled={filteredViews.length === 0}
                />
              </TableHead>
              <TableHead className="w-20">Index</TableHead>
              <TableHead>View name</TableHead>
              <TableHead className="w-44 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingViews && !views ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : filteredViews.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {views && views.length > 0
                    ? "No views match the filter."
                    : "No dialler views configured. Add some in Settings → Dialler views."}
                </TableCell>
              </TableRow>
            ) : (
              filteredViews.map((row) => {
                const idxKey = String(row.TABLE_INDEX)
                const isDownloading = downloadingIdx === idxKey
                const isChecked = selected.has(idxKey)
                return (
                  <TableRow key={idxKey} data-state={isChecked ? "selected" : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select view ${row.TABLE_INDEX}`}
                        className="h-4 w-4 rounded border-border bg-background"
                        checked={isChecked}
                        onChange={() => toggleOne(idxKey)}
                      />
                    </TableCell>
                    <TableCell className="font-mono">{row.TABLE_INDEX}</TableCell>
                    <TableCell className="break-all font-mono text-sm">{row.TABLE_NAME}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => downloadCsv(row)}
                        disabled={isDownloading || !!downloadingIdx || batchDownloading}
                      >
                        {isDownloading ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Running...
                          </>
                        ) : (
                          <>
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Per-row "Download" runs that view immediately. To grab several at once, tick the checkboxes
        and click "Download N as ZIP". File names come from the{" "}
        <span className="font-mono">BATCHNAME</span> column when present, otherwise the view name.
      </p>
    </div>
  )
}

function SettingsPanel() {
  return (
    <Tabs defaultValue="running-tasks" className="w-full">
      <TabsList>
        <TabsTrigger value="running-tasks">Running Tasks</TabsTrigger>
        <TabsTrigger value="dialler-views">Dialler views</TabsTrigger>
      </TabsList>

      <TabsContent value="running-tasks" className="mt-4">
        <RunningTasksPanel />
      </TabsContent>

      <TabsContent value="dialler-views" className="mt-4">
        <DiallerViewsPanel />
      </TabsContent>
    </Tabs>
  )
}

type DiallerTable = {
  TABLE_INDEX: number | string
  TABLE_NAME: string
  CREATED_AT: string | null
}

function DiallerViewsPanel() {
  const [rows, setRows] = useState<DiallerTable[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DiallerTable | null>(null)
  const [formIndex, setFormIndex] = useState("")
  const [formName, setFormName] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<DiallerTable | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/dialler-tables", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load dialler views (${res.status})`)
      setRows(data.rows as DiallerTable[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openAdd = () => {
    setEditing(null)
    const nextIndex =
      rows && rows.length > 0
        ? Math.max(...rows.map((t) => Number(t.TABLE_INDEX))) + 1
        : 1
    setFormIndex(String(nextIndex))
    setFormName("")
    setDialogOpen(true)
  }

  const openEdit = (row: DiallerTable) => {
    setEditing(row)
    setFormIndex(String(row.TABLE_INDEX))
    setFormName(row.TABLE_NAME)
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const tableIndex = parseInt(formIndex, 10)
      if (!Number.isInteger(tableIndex) || tableIndex < 0) {
        throw new Error("Table index must be a non-negative integer")
      }
      const tableName = formName.trim()
      if (!tableName) throw new Error("Table name is required")

      const url = editing ? `/api/dialler-tables/${editing.TABLE_INDEX}` : "/api/dialler-tables"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableIndex, tableName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)

      toast.success(editing ? "View updated" : "View added")
      setDialogOpen(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/dialler-tables/${deleteTarget.TABLE_INDEX}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`)

      toast.success(`Deleted view ${deleteTarget.TABLE_INDEX}`)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Dialler Views</h3>
          <p className="text-sm text-muted-foreground">
            Source:{" "}
            <span className="font-mono">
              DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_DIALER_AUTOMATION_TABLES
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Add view
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Table index</TableHead>
              <TableHead>Table name</TableHead>
              <TableHead>Created at</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !rows ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rows && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No views. Click "Add view" to create one.
                </TableCell>
              </TableRow>
            ) : (
              rows?.map((row) => (
                <TableRow key={String(row.TABLE_INDEX)}>
                  <TableCell className="font-mono">{row.TABLE_INDEX}</TableCell>
                  <TableCell className="font-mono text-sm">{row.TABLE_NAME}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatCreatedAt(row.CREATED_AT)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(row)}
                        aria-label={`Edit view ${row.TABLE_INDEX}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(row)}
                        aria-label={`Delete view ${row.TABLE_INDEX}`}
                        className="text-rose-400 hover:text-rose-300"
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit view" : "Add view"}</DialogTitle>
            <DialogDescription>
              {editing
                ? `Update view at index ${editing.TABLE_INDEX}.`
                : "Add a new dialler view."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="dv-index">Table index</Label>
              <Input
                id="dv-index"
                type="number"
                min={0}
                value={formIndex}
                onChange={(e) => setFormIndex(e.target.value)}
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="dv-name">Table name</Label>
              <Input
                id="dv-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_..."
                className="mt-2 font-mono"
                maxLength={500}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Add view"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this view?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove view <span className="font-mono">{deleteTarget?.TABLE_INDEX}</span> (
              <span className="font-mono">{deleteTarget?.TABLE_NAME}</span>) from the table. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-500 hover:bg-rose-600"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RunningTasksPanel() {
  const [tasks, setTasks] = useState<DailyTask[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DailyTask | null>(null)
  const [formIndex, setFormIndex] = useState("")
  const [formName, setFormName] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<DailyTask | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/daily-tasks", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load tasks (${res.status})`)
      setTasks(data.rows as DailyTask[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openAdd = () => {
    setEditing(null)
    const nextIndex =
      tasks && tasks.length > 0
        ? Math.max(...tasks.map((t) => Number(t.TASK_INDEX))) + 1
        : 1
    setFormIndex(String(nextIndex))
    setFormName("")
    setDialogOpen(true)
  }

  const openEdit = (task: DailyTask) => {
    setEditing(task)
    setFormIndex(String(task.TASK_INDEX))
    setFormName(task.TASK_NAME)
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const taskIndex = parseInt(formIndex, 10)
      if (!Number.isInteger(taskIndex) || taskIndex < 0) {
        throw new Error("Task index must be a non-negative integer")
      }
      const taskName = formName.trim()
      if (!taskName) throw new Error("Task name is required")

      const url = editing
        ? `/api/daily-tasks/${editing.TASK_INDEX}`
        : "/api/daily-tasks"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIndex, taskName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)

      toast.success(editing ? "Task updated" : "Task added")
      setDialogOpen(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/daily-tasks/${deleteTarget.TASK_INDEX}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`)

      toast.success(`Deleted task ${deleteTarget.TASK_INDEX}`)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Running Tasks</h3>
          <p className="text-sm text-muted-foreground">
            Source: <span className="font-mono">DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_DAILY_TASKS</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Add task
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Task index</TableHead>
              <TableHead>Task name</TableHead>
              <TableHead>Created at</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !tasks ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : tasks && tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No tasks. Click "Add task" to create one.
                </TableCell>
              </TableRow>
            ) : (
              tasks?.map((task) => (
                <TableRow key={String(task.TASK_INDEX)}>
                  <TableCell className="font-mono">{task.TASK_INDEX}</TableCell>
                  <TableCell className="font-mono">{task.TASK_NAME}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatCreatedAt(task.CREATED_AT)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(task)}
                        aria-label={`Edit task ${task.TASK_INDEX}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(task)}
                        aria-label={`Delete task ${task.TASK_INDEX}`}
                        className="text-rose-400 hover:text-rose-300"
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit task" : "Add task"}</DialogTitle>
            <DialogDescription>
              {editing
                ? `Update task index ${editing.TASK_INDEX}.`
                : "Create a new running task."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="task-index">Task index</Label>
              <Input
                id="task-index"
                type="number"
                min={0}
                value={formIndex}
                onChange={(e) => setFormIndex(e.target.value)}
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="task-name">Task name</Label>
              <Input
                id="task-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. TSK_DAILY_CAMPAIGNS_SS"
                className="mt-2 font-mono"
                maxLength={200}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Add task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove task <span className="font-mono">{deleteTarget?.TASK_INDEX}</span> (
              <span className="font-mono">{deleteTarget?.TASK_NAME}</span>) from the table. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-500 hover:bg-rose-600"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
