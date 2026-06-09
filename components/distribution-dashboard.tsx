"use client"

import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { toast } from "sonner"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DailyFilesContent } from "@/components/daily-files"
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  SidebarFooter,
} from "@/components/ui/sidebar"
import {
  ArrowLeft,
  LogOut,
  Truck,
  Zap,
  Hand,
  Clock,
  Search,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Check,
  ChevronsUpDown,
  Files,
  PlayCircle,
  Upload,
  Server,
  Database,
  Settings as SettingsIcon,
  LayoutDashboard,
  TrendingUp,
  Recycle,
} from "lucide-react"
import { useState, useCallback, useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"

type NavItem = {
  id: string
  label: string
  icon: React.ReactNode
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: "manual", label: "Manual", icon: <Hand className="h-4 w-4" /> },
  { id: "automation", label: "Automation", icon: <Zap className="h-4 w-4" /> },
  { id: "extend-expired", label: "Extend Expired Leads", icon: <Clock className="h-4 w-4" /> },
  { id: "daily-files", label: "Daily Files", icon: <Files className="h-4 w-4" /> },
  { id: "recycle", label: "Recycle", icon: <Recycle className="h-4 w-4" /> },
  { id: "forecasting", label: "Forecasting", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
]

type LeadSource = "file" | "sftp" | "snowflake"

function ManualContent() {
  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [source, setSource] = useState<LeadSource | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(data.error || `Failed to load campaigns (${res.status})`)
          setCampaigns([])
        } else {
          setCampaigns(data.campaigns || [])
        }
      } catch (err) {
        if (cancelled) return
        setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedCampaign = campaigns.find((c) => c.id === campaignId)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Manual Lead Distribution</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Distribute leads to dialling systems and CRM. Pick the campaign first, then choose how to
          bring the leads in.
        </p>
      </div>

      {/* Step 1 — Campaign */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <h3 className="font-medium text-foreground">Campaign</h3>
        </div>
        <Label className="mb-2 block text-sm text-muted-foreground">Search by title</Label>
        <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={campaignPickerOpen}
              className="w-full max-w-md justify-between"
              disabled={campaignsLoading || !!campaignsError}
            >
              <span className="truncate">
                {campaignsLoading
                  ? "Loading campaigns..."
                  : selectedCampaign
                  ? `${selectedCampaign.title}  ·  ${selectedCampaign.id}`
                  : "Select a campaign..."}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command
              filter={(value, search) => {
                return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
              }}
            >
              <CommandInput placeholder="Search title or ID..." />
              <CommandList>
                <CommandEmpty>No campaign found.</CommandEmpty>
                <CommandGroup>
                  {campaigns.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`${c.title}  ·  ${c.id}`}
                      onSelect={() => {
                        setCampaignId(c.id)
                        setCampaignPickerOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          campaignId === c.id ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <div className="flex flex-col">
                        <span>{c.title}</span>
                        <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {campaignsError && (
          <p className="mt-2 text-xs text-rose-400">Failed to load campaigns: {campaignsError}</p>
        )}
      </div>

      {/* Step 2 — choose source (only after campaign selected) */}
      {selectedCampaign && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              2
            </span>
            <h3 className="font-medium text-foreground">Lead source</h3>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <SourceCard
              active={source === "file"}
              onClick={() => setSource("file")}
              icon={<Upload className="h-5 w-5" />}
              title="Upload a file"
              description="CSV, Excel, or JSON"
            />
            <SourceCard
              active={source === "sftp"}
              onClick={() => setSource("sftp")}
              icon={<Server className="h-5 w-5" />}
              title="SFTP"
              description="Pull from a remote server"
            />
            <SourceCard
              active={source === "snowflake"}
              onClick={() => setSource("snowflake")}
              icon={<Database className="h-5 w-5" />}
              title="Snowflake"
              description="Run a stored procedure"
            />
          </div>
        </div>
      )}

      {/* Step 3 — source-specific config */}
      {selectedCampaign && source && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              3
            </span>
            <h3 className="font-medium text-foreground">
              {source === "file" && "Upload file"}
              {source === "sftp" && "SFTP connection"}
              {source === "snowflake" && "Stored procedure"}
            </h3>
          </div>

          {source === "file" && <FileSourcePanel campaignId={selectedCampaign.id} />}
          {source === "sftp" && <SftpSourcePanel />}
          {source === "snowflake" && <SnowflakeSourcePanel />}
        </div>
      )}
    </div>
  )
}

function SourceCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-4 text-left transition-all",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border bg-background/40 hover:border-primary/40 hover:bg-background/60"
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-lg",
          active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        {icon}
      </div>
      <p className={cn("font-medium", active ? "text-foreground" : "text-foreground")}>{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </button>
  )
}

type FilePreview = {
  fileName: string
  sheetName: string
  rowCount: number
  headers: string[]
  sample: string[][]
}

type TargetColumn = {
  COLUMN_NAME: string
  DATA_TYPE: string
  IS_NULLABLE: "YES" | "NO"
  COLUMN_DEFAULT: string | null
}

const SKIP_VALUE = "__skip__"

const ALLOWED_SQL_TYPES = [
  "VARCHAR(500)",
  "VARCHAR(1000)",
  "VARCHAR(4000)",
  "NUMBER",
  "NUMBER(38,0)",
  "FLOAT",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP_NTZ",
] as const

function sanitizeColumnName(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
  if (!s) s = "COL"
  if (/^[0-9]/.test(s)) s = `C_${s}`
  return s
}

function autoMatchColumn(sourceHeader: string, targets: TargetColumn[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const src = norm(sourceHeader)
  const exact = targets.find((t) => norm(t.COLUMN_NAME) === src)
  return exact ? exact.COLUMN_NAME : SKIP_VALUE
}

type CreateColSpec = { sourceHeader: string; name: string; type: string }

function FileSourcePanel({ campaignId }: { campaignId: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<"select" | "preview" | "create" | "map">("select")

  // Preview state
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Mapping state
  const [targetTable, setTargetTable] = useState("")
  const [targetColumns, setTargetColumns] = useState<TargetColumn[] | null>(null)
  const [targetLoading, setTargetLoading] = useState(false)
  const [targetError, setTargetError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})

  // Create-table state
  const [createSpec, setCreateSpec] = useState<CreateColSpec[]>([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0])
      setPreview(null)
      setStage("select")
    }
  }

  const handlePreview = async () => {
    if (!file) return
    setPreviewLoading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/upload/preview", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Preview failed (${res.status})`)
      setPreview(data as FilePreview)
      setStage("preview")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleProceedToMap = async () => {
    if (!preview || !targetTable.trim()) return
    setTargetLoading(true)
    setTargetError(null)
    setTargetColumns(null)
    try {
      const res = await fetch("/api/snowflake/table-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: targetTable.trim() }),
      })
      const data = await res.json()
      if (res.status === 404) {
        // Table doesn't exist — switch to create flow with sensible defaults.
        const seen = new Set<string>()
        const initial = preview.headers.map((h) => {
          let name = sanitizeColumnName(h)
          let suffix = 2
          while (seen.has(name)) {
            name = `${sanitizeColumnName(h)}_${suffix++}`
          }
          seen.add(name)
          return { sourceHeader: h, name, type: "VARCHAR(4000)" }
        })
        setCreateSpec(initial)
        setCreateError(null)
        setStage("create")
        return
      }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      const cols = data.columns as TargetColumn[]
      setTargetColumns(cols)
      const initial: Record<string, string> = {}
      for (const h of preview.headers) initial[h] = autoMatchColumn(h, cols)
      setMapping(initial)
      setStage("map")
    } catch (err) {
      setTargetError(err instanceof Error ? err.message : String(err))
    } finally {
      setTargetLoading(false)
    }
  }

  const handleCreateTable = async () => {
    if (!preview || !targetTable.trim()) return

    // Validate names client-side for fast feedback
    const seen = new Set<string>()
    for (const c of createSpec) {
      if (!/^[A-Z0-9_]+$/.test(c.name)) {
        setCreateError(`Invalid column name "${c.name}" — use A-Z, 0-9, _ only`)
        return
      }
      if (seen.has(c.name)) {
        setCreateError(`Duplicate column name: ${c.name}`)
        return
      }
      seen.add(c.name)
    }

    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch("/api/snowflake/create-stage-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: targetTable.trim(),
          columns: createSpec.map((c) => ({ name: c.name, type: c.type })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Create failed (${res.status})`)
      toast.success(`Created ${data.table} with ${data.columns} columns`)

      // Now fetch the columns and proceed to mapping.
      const colsRes = await fetch("/api/snowflake/table-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: targetTable.trim() }),
      })
      const colsData = await colsRes.json()
      if (!colsRes.ok) throw new Error(colsData.error || "Failed to fetch new columns")
      const cols = colsData.columns as TargetColumn[]
      setTargetColumns(cols)
      const initial: Record<string, string> = {}
      for (const h of preview.headers) initial[h] = autoMatchColumn(h, cols)
      setMapping(initial)
      setStage("map")
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setPreview(null)
    setTargetColumns(null)
    setMapping({})
    setStage("select")
  }

  // ---- STAGE: select file
  if (stage === "select" || !preview) {
    return (
      <div className="flex flex-col gap-4">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-background/50 p-8 transition-colors hover:bg-background/80">
          <input
            type="file"
            onChange={handleFileChange}
            className="hidden"
            accept=".csv,.xlsx,.xls"
          />
          <Upload className="h-6 w-6 text-muted-foreground" />
          <p className="font-medium text-foreground">
            {file ? file.name : "Click to select file or drag and drop"}
          </p>
          <p className="text-sm text-muted-foreground">
            {file ? "File selected" : "CSV, Excel · max 50MB"}
          </p>
        </label>

        <Button onClick={handlePreview} disabled={!file || previewLoading}>
          {previewLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Next: preview & map
        </Button>
      </div>
    )
  }

  // ---- STAGE: preview + pick target table
  if (stage === "preview") {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-background/40 p-4 text-sm">
          <p className="font-medium text-foreground">{preview.fileName}</p>
          <p className="text-muted-foreground">
            Sheet: <span className="font-mono">{preview.sheetName}</span> · {preview.rowCount} row
            {preview.rowCount === 1 ? "" : "s"} · {preview.headers.length} column
            {preview.headers.length === 1 ? "" : "s"}
          </p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">Sample (first {preview.sample.length} rows)</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  {preview.headers.map((h) => (
                    <TableHead key={h} className="whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.sample.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((cell, j) => (
                      <TableCell
                        key={j}
                        className="max-w-xs truncate font-mono text-xs"
                        title={cell}
                      >
                        {cell || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <div>
          <Label htmlFor="target-table" className="mb-2 block text-sm text-muted-foreground">
            Target stage table (DATABASE.SCHEMA.NAME)
          </Label>
          <input
            id="target-table"
            value={targetTable}
            onChange={(e) => setTargetTable(e.target.value)}
            placeholder="DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_LEAD_STAGE"
            className="w-full max-w-xl rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          {targetError && (
            <p className="mt-2 text-xs text-rose-400">{targetError}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={handleReset}>
            Back
          </Button>
          <Button
            onClick={handleProceedToMap}
            disabled={!targetTable.trim() || targetLoading}
          >
            {targetLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Next: map columns
          </Button>
        </div>
      </div>
    )
  }

  // ---- STAGE: create stage table (when target table doesn't exist)
  if (stage === "create") {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              <span className="font-mono">{targetTable}</span> doesn't exist. Define columns and
              create it. A <span className="font-mono">CREATED_AT TIMESTAMP_NTZ</span> audit column
              is added automatically.
            </span>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source header</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead>Column name</TableHead>
                <TableHead>Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {createSpec.map((c, idx) => {
                const sampleValue = preview.sample[0]?.[idx] ?? ""
                return (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-sm">{c.sourceHeader}</TableCell>
                    <TableCell
                      className="max-w-xs truncate font-mono text-xs text-muted-foreground"
                      title={sampleValue}
                    >
                      {sampleValue || "—"}
                    </TableCell>
                    <TableCell>
                      <input
                        value={c.name}
                        onChange={(e) =>
                          setCreateSpec((prev) =>
                            prev.map((p, i) =>
                              i === idx ? { ...p, name: e.target.value.toUpperCase() } : p
                            )
                          )
                        }
                        className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={c.type}
                        onValueChange={(v) =>
                          setCreateSpec((prev) =>
                            prev.map((p, i) => (i === idx ? { ...p, type: v } : p))
                          )
                        }
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALLOWED_SQL_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {createError && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
            {createError}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setStage("preview")} disabled={creating}>
            Back
          </Button>
          <Button onClick={handleCreateTable} disabled={creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Database className="mr-2 h-4 w-4" />
            Create table & continue
          </Button>
        </div>
      </div>
    )
  }

  // ---- STAGE: column mapping
  const cols = targetColumns ?? []
  const targetByName = new Map(cols.map((c) => [c.COLUMN_NAME, c]))
  const mappedTargets = new Set(Object.values(mapping).filter((v) => v !== SKIP_VALUE))
  const unmappedRequired = cols.filter(
    (c) => c.IS_NULLABLE === "NO" && !c.COLUMN_DEFAULT && !mappedTargets.has(c.COLUMN_NAME)
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-background/40 p-3 text-sm">
        <span className="text-muted-foreground">File:</span>{" "}
        <span className="font-mono">{preview.fileName}</span>{" "}
        <span className="text-muted-foreground">→ Target:</span>{" "}
        <span className="font-mono">{targetTable}</span>{" "}
        <span className="text-muted-foreground">· {preview.rowCount} rows · CAMPAIGNID =</span>{" "}
        <span className="font-mono">{campaignId}</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source column</TableHead>
              <TableHead>Sample</TableHead>
              <TableHead>Target column</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.headers.map((h, idx) => {
              const target = mapping[h] ?? SKIP_VALUE
              const tgtMeta = target !== SKIP_VALUE ? targetByName.get(target) : undefined
              const sampleValue = preview.sample[0]?.[idx] ?? ""
              return (
                <TableRow key={h}>
                  <TableCell className="font-mono text-sm">{h}</TableCell>
                  <TableCell
                    className="max-w-xs truncate font-mono text-xs text-muted-foreground"
                    title={sampleValue}
                  >
                    {sampleValue || "—"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={target}
                      onValueChange={(v) => setMapping((prev) => ({ ...prev, [h]: v }))}
                    >
                      <SelectTrigger className="w-full max-w-xs">
                        <SelectValue placeholder="Select target column..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP_VALUE}>(skip)</SelectItem>
                        {cols.map((c) => (
                          <SelectItem key={c.COLUMN_NAME} value={c.COLUMN_NAME}>
                            {c.COLUMN_NAME}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {tgtMeta ? (
                      <>
                        {tgtMeta.DATA_TYPE}
                        {tgtMeta.IS_NULLABLE === "NO" && (
                          <span className="ml-1 text-amber-300">(required)</span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
        <p className="text-muted-foreground">
          {Object.values(mapping).filter((v) => v !== SKIP_VALUE).length} of{" "}
          {preview.headers.length} source columns mapped ·{" "}
          {cols.length - mappedTargets.size} target columns unmapped
        </p>
        {unmappedRequired.length > 0 && (
          <p className="mt-1 text-amber-300">
            Required target columns without a mapping:{" "}
            {unmappedRequired.map((c) => c.COLUMN_NAME).join(", ")}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => setStage("preview")}>
          Back
        </Button>
        <Button disabled>
          <Database className="mr-2 h-4 w-4" />
          Load to Snowflake (coming soon)
        </Button>
      </div>
    </div>
  )
}

type SftpEntry = {
  name: string
  type: "d" | "-" | "l" | string
  size: number
  modifyTime: number
  rights?: { user?: string; group?: string; other?: string }
}

type SftpListResponse = {
  path: string
  parent: string | null
  entries: SftpEntry[]
}

type SftpPreviewResponse = {
  filePath: string
  size: number
  modifyTime: number
  truncated: boolean
  preview: string
  isLikelyText: boolean
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString()
}

function SftpSourcePanel() {
  const [host, setHost] = useState("")
  const [port, setPort] = useState("22")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [authMode, setAuthMode] = useState<"password" | "key">("password")
  const [startPath, setStartPath] = useState("/")

  const [connected, setConnected] = useState(false)
  const [listing, setListing] = useState<SftpListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  const [selectedFile, setSelectedFile] = useState<{ path: string; entry: SftpEntry } | null>(null)
  const [preview, setPreview] = useState<SftpPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const credsValid =
    host.trim() && username.trim() &&
    (authMode === "password" ? password.length > 0 : privateKey.length > 0)

  const credsBody = () => ({
    host: host.trim(),
    port: parseInt(port, 10) || 22,
    username: username.trim(),
    password: authMode === "password" ? password : "",
    privateKey: authMode === "key" ? privateKey : "",
  })

  const loadPath = async (targetPath: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sftp/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credsBody(), path: targetPath }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setListing(data as SftpListResponse)
      setConnected(true)
      setSelectedFile(null)
      setPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (!connected) setListing(null)
    } finally {
      setLoading(false)
    }
  }

  const handleConnect = () => loadPath(startPath || "/")

  const handleDisconnect = () => {
    setConnected(false)
    setListing(null)
    setSelectedFile(null)
    setPreview(null)
    setError(null)
  }

  const handleEntryClick = async (entry: SftpEntry) => {
    if (!listing) return
    const full =
      listing.path.endsWith("/") ? `${listing.path}${entry.name}` : `${listing.path}/${entry.name}`
    if (entry.type === "d") {
      await loadPath(full)
    } else {
      setSelectedFile({ path: full, entry })
      setPreview(null)
      setPreviewError(null)
    }
  }

  const handlePreview = async () => {
    if (!selectedFile) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await fetch("/api/sftp/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credsBody(), filePath: selectedFile.path }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setPreview(data as SftpPreviewResponse)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewLoading(false)
    }
  }

  const filteredEntries = useMemo(() => {
    if (!listing) return []
    const q = filter.trim().toLowerCase()
    const sorted = [...listing.entries].sort((a, b) => {
      // Directories first, then files; alphabetical within group
      if (a.type === "d" && b.type !== "d") return -1
      if (a.type !== "d" && b.type === "d") return 1
      return a.name.localeCompare(b.name)
    })
    if (!q) return sorted
    return sorted.filter((e) => e.name.toLowerCase().includes(q))
  }, [listing, filter])

  const breadcrumbs = useMemo(() => {
    if (!listing) return []
    const parts = listing.path.split("/").filter(Boolean)
    const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }]
    let acc = ""
    for (const p of parts) {
      acc += `/${p}`
      crumbs.push({ label: p, path: acc })
    }
    return crumbs
  }, [listing])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Connection card */}
      {!connected ? (
        <div className="rounded-lg border border-border bg-background/40 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="sftp-host" className="mb-2 block text-sm text-muted-foreground">
                Host
              </Label>
              <input
                id="sftp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="sftp.example.com"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="sftp-port" className="mb-2 block text-sm text-muted-foreground">
                Port
              </Label>
              <input
                id="sftp-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="sftp-user" className="mb-2 block text-sm text-muted-foreground">
                Username
              </Label>
              <input
                id="sftp-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label className="mb-2 block text-sm text-muted-foreground">Authentication</Label>
              <div className="inline-flex rounded-md border border-border bg-background/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setAuthMode("password")}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium",
                    authMode === "password"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode("key")}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium",
                    authMode === "key"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Private key
                </button>
              </div>
            </div>
            {authMode === "password" ? (
              <div className="md:col-span-2">
                <Label htmlFor="sftp-pass" className="mb-2 block text-sm text-muted-foreground">
                  Password
                </Label>
                <input
                  id="sftp-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            ) : (
              <div className="md:col-span-2">
                <Label htmlFor="sftp-key" className="mb-2 block text-sm text-muted-foreground">
                  Private key (PEM)
                </Label>
                <Textarea
                  id="sftp-key"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                  rows={6}
                  className="font-mono text-xs"
                />
              </div>
            )}
            <div className="md:col-span-2">
              <Label htmlFor="sftp-start" className="mb-2 block text-sm text-muted-foreground">
                Starting path
              </Label>
              <input
                id="sftp-start"
                value={startPath}
                onChange={(e) => setStartPath(e.target.value)}
                placeholder="/"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}

          <div className="mt-4">
            <Button onClick={handleConnect} disabled={!credsValid || loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Server className="mr-2 h-4 w-4" />
                  Connect
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Connected toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Server className="h-3.5 w-3.5 text-emerald-400" />
              <span className="font-mono">
                {username}@{host}:{port}
              </span>
              <span className="text-emerald-300">connected</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => listing && loadPath(listing.path)}
                disabled={loading}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>

          {/* Breadcrumb */}
          {listing && (
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
              {breadcrumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground">/</span>}
                  <button
                    type="button"
                    onClick={() => loadPath(c.path)}
                    className="rounded px-1.5 py-0.5 font-mono text-xs hover:bg-accent hover:text-accent-foreground"
                  >
                    {c.label === "/" ? "(root)" : c.label}
                  </button>
                </span>
              ))}
              {listing.parent !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => listing.parent && loadPath(listing.parent)}
                  className="ml-auto h-7 px-2 text-xs"
                >
                  ↑ Parent
                </Button>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}

          {/* Filter + listing */}
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border p-3">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files & folders..."
                  className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm"
                />
              </div>
            </div>

            <div className="max-h-96 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-24">Size</TableHead>
                    <TableHead className="w-44">Modified</TableHead>
                    <TableHead className="w-24">Perms</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && !listing ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : filteredEntries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                        {listing && listing.entries.length > 0
                          ? "No entries match the filter."
                          : "Empty directory."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredEntries.map((entry) => {
                      const isDir = entry.type === "d"
                      const isSelected =
                        !isDir &&
                        selectedFile?.entry.name === entry.name &&
                        selectedFile?.path.endsWith(`/${entry.name}`)
                      return (
                        <TableRow
                          key={`${entry.type}:${entry.name}`}
                          className={cn(
                            "cursor-pointer",
                            isSelected && "bg-primary/10"
                          )}
                          onClick={() => handleEntryClick(entry)}
                        >
                          <TableCell>
                            {isDir ? (
                              <Files className="h-4 w-4 text-amber-400" />
                            ) : (
                              <Upload className="h-4 w-4 rotate-180 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {entry.name}
                            {isDir && <span className="text-muted-foreground">/</span>}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {isDir ? "—" : formatBytes(entry.size)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatMtime(entry.modifyTime)}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {entry.rights
                              ? `${entry.rights.user ?? ""}${entry.rights.group ?? ""}${entry.rights.other ?? ""}`
                              : ""}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Selected file actions */}
          {selectedFile && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Selected file
                  </p>
                  <p className="mt-0.5 break-all font-mono text-sm">{selectedFile.path}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatBytes(selectedFile.entry.size)} ·{" "}
                    {formatMtime(selectedFile.entry.modifyTime)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handlePreview} disabled={previewLoading}>
                    {previewLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Search className="mr-2 h-4 w-4" />
                        Preview
                      </>
                    )}
                  </Button>
                  <Button disabled>
                    <Upload className="mr-2 h-4 w-4 rotate-180" />
                    Pull file (coming soon)
                  </Button>
                </div>
              </div>

              {previewError && (
                <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-300">
                  {previewError}
                </div>
              )}

              {preview && (
                <div className="mt-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {preview.isLikelyText ? "Text preview" : "Binary file"}
                      {preview.truncated && " · truncated"}
                    </span>
                    <span className="font-mono">{formatBytes(preview.size)}</span>
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                    {preview.preview || "(empty)"}
                  </pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SnowflakeSourcePanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Stored procedure execution is not yet wired up — the form below collects the inputs.</span>
        </div>
      </div>

      <div>
        <Label htmlFor="sp-name" className="mb-2 block text-sm text-muted-foreground">
          Procedure (fully qualified)
        </Label>
        <input
          id="sp-name"
          placeholder="DATAWAREHOUSE.SCHEMA.PROCEDURE_NAME"
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
      </div>

      <div>
        <Label htmlFor="sp-args" className="mb-2 block text-sm text-muted-foreground">
          Arguments (comma-separated, optional)
        </Label>
        <input
          id="sp-args"
          placeholder="'arg1', 123"
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
      </div>

      <Button disabled>
        <Database className="mr-2 h-4 w-4" />
        Run stored procedure (coming soon)
      </Button>
    </div>
  )
}

function AutomationContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Automated Lead Distribution</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up automated workflows to distribute leads to dialling systems and CRM platforms.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-medium text-foreground">CRM Integration</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect to your CRM to automatically distribute leads in real-time.
              </p>
              <Button variant="outline" size="sm" className="mt-3">
                Configure CRM
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Truck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-medium text-foreground">Dialling System Integration</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Route leads to dialling systems for immediate agent engagement.
              </p>
              <Button variant="outline" size="sm" className="mt-3">
                Configure Dialling
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-lg font-semibold text-foreground">Active Distributions</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          You currently have no active distribution workflows. Create your first automation above.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Benefits of Automation</h3>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
            Reduce manual data entry errors
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
            Save time on repetitive tasks
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
            Ensure consistent data quality
          </li>
          <li className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
            Enable real-time lead routing and engagement
          </li>
        </ul>
      </div>
    </div>
  )
}

type LookupKind = "idnumber" | "cellnumber"

type Campaign = { id: string; title: string }

type LookupResult = {
  value: string
  inHistory: boolean
  idnumber: string | null
  cellnumber: string | null
  historyCreatedOn: string | null
  historyExpiry: string | null
  inSs: boolean
  ssRow: Record<string, unknown> | null
  note?: string
}

type SsMeta = { columns: string[]; error: string | null; idnumbersChecked: number }

function parseValues(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Convert a Snowflake date/timestamp value to a YYYY-MM-DD string.
 *
 * Accepts:
 *   - ISO date strings (e.g. "2026-04-30") — server-side formatted, returned as-is.
 *   - ISO timestamps (e.g. "2026-04-30T12:34:56Z") — date portion extracted.
 *   - DATE encoding: small integer days since 1970-01-01 (e.g. "20570").
 *   - TIMESTAMP encoding: "<seconds>.<nanos>[ <tz_offset_minutes>]".
 *
 * Returns the original string if it doesn't match.
 */
function formatSnowflakeDate(raw: string | null | undefined): string {
  if (!raw) return ""
  const s = String(raw).trim()

  // Already-formatted ISO date or datetime
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s)) return s.slice(0, 10)

  // DATE: pure small integer = days since 1970-01-01.
  if (/^-?\d{1,5}$/.test(s)) {
    const days = parseInt(s, 10)
    if (Number.isFinite(days)) {
      const d = new Date(days * 86_400_000)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
  }

  // TIMESTAMP: leading 10+ digit number (seconds since epoch), optional fractional and trailing tz offset.
  const tsMatch = s.match(/^(-?\d{10,})(?:\.\d+)?(?:\s+-?\d+)?$/)
  if (tsMatch) {
    const seconds = parseFloat(s.split(/\s+/)[0])
    if (Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
  }

  return s
}

/** Today as days since 1970-01-01 (UTC), to compare against Snowflake DATE columns. */
function todayAsSnowflakeDays(): number {
  return Math.floor(Date.now() / 86_400_000)
}

/**
 * Decide whether a Snowflake date/timestamp value lies in the past, future, or unknown.
 * Handles ISO strings (server-formatted) and raw Snowflake encodings.
 */
function expiryStatus(raw: string | null | undefined): "expired" | "active" | "unknown" {
  if (!raw) return "unknown"
  const s = String(raw).trim()

  // ISO date or datetime (e.g. "2026-04-30" or "2026-04-30T12:00:00Z")
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)
    if (Number.isFinite(ms)) {
      return ms > Date.now() ? "active" : "expired"
    }
  }

  // DATE: small integer
  if (/^-?\d{1,5}$/.test(s)) {
    const days = parseInt(s, 10)
    if (Number.isFinite(days)) {
      return days > todayAsSnowflakeDays() ? "active" : "expired"
    }
    return "unknown"
  }

  // TIMESTAMP: seconds since epoch
  if (/^(-?\d{10,})(?:\.\d+)?(?:\s+-?\d+)?$/.test(s)) {
    const seconds = parseFloat(s.split(/\s+/)[0])
    if (Number.isFinite(seconds)) {
      return seconds * 1000 > Date.now() ? "active" : "expired"
    }
  }

  return "unknown"
}

function ExtendExpiredContent() {
  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [lookupKind, setLookupKind] = useState<LookupKind>("idnumber")
  const [rawValues, setRawValues] = useState("")
  const [isChecking, setIsChecking] = useState(false)
  const [results, setResults] = useState<LookupResult[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(data.error || `Failed to load campaigns (${res.status})`)
          setCampaigns([])
        } else {
          setCampaigns(data.campaigns || [])
        }
      } catch (err) {
        if (cancelled) return
        setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedCampaign = campaigns.find((c) => c.id === campaignId)
  const parsedValues = parseValues(rawValues)
  const canCheck = campaignId.length > 0 && parsedValues.length > 0 && !isChecking

  const [checkError, setCheckError] = useState<string | null>(null)
  const [ssMeta, setSsMeta] = useState<SsMeta | null>(null)
  const [extendOpen, setExtendOpen] = useState(false)
  const [extending, setExtending] = useState(false)
  const [hasExtended, setHasExtended] = useState(false)
  const [syncResult, setSyncResult] = useState<Record<string, unknown>[] | null>(null)
  const [insertedCount, setInsertedCount] = useState<number | null>(null)

  const handleCheck = async () => {
    setIsChecking(true)
    setResults(null)
    setCheckError(null)
    setSsMeta(null)
    setHasExtended(false)
    setSyncResult(null)
    setInsertedCount(null)
    try {
      const res = await fetch("/api/leads/extend/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, lookupKind, values: parsedValues }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCheckError(data.error || `Lookup failed (${res.status})`)
      } else {
        setResults(data.results as LookupResult[])
        setSsMeta((data.ss as SsMeta | undefined) ?? null)
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsChecking(false)
    }
  }

  const handleReset = () => {
    setResults(null)
    setRawValues("")
  }

  // Pick the most likely "expiry" column from the SS view (e.g. EXPIRY_DATE, EXPIRES_AT, ...)
  const ssExpiryColumn = useMemo(() => {
    if (!ssMeta?.columns) return null
    return (
      ssMeta.columns.find((c) => /EXPIR/i.test(c)) ??
      ssMeta.columns.find((c) => /END.?DATE|END.?ON/i.test(c)) ??
      null
    )
  }, [ssMeta])

  const ssExpiryFor = useCallback(
    (r: LookupResult): string | null => {
      if (!ssExpiryColumn || !r.ssRow) return null
      const v = r.ssRow[ssExpiryColumn]
      return v === null || v === undefined ? null : String(v)
    },
    [ssExpiryColumn]
  )

  // Idnumbers eligible for extension: in history, in SS expired view, and SS expiry is in the past.
  const extendableIdnumbers = useMemo(() => {
    if (!results) return []
    return Array.from(
      new Set(
        results
          .filter(
            (r) =>
              r.inHistory &&
              r.inSs &&
              r.idnumber &&
              expiryStatus(ssExpiryFor(r)) === "expired"
          )
          .map((r) => r.idnumber as string)
      )
    )
  }, [results, ssExpiryFor])

  const handleExtend = async () => {
    if (extendableIdnumbers.length === 0 || !campaignId) return
    setExtending(true)
    setSyncResult(null)
    setInsertedCount(null)
    try {
      const res = await fetch("/api/leads/extend/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, idnumbers: extendableIdnumbers }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        const failed = (data.steps as { name: string; ok: boolean; error?: string }[] | undefined)
          ?.find((s) => !s.ok)
        throw new Error(
          failed ? `${failed.name} failed: ${failed.error}` : data.error || `Failed (${res.status})`
        )
      }
      toast.success(`Extended ${data.inserted} lead${data.inserted === 1 ? "" : "s"} and triggered SQL Server sync`)
      setInsertedCount(data.inserted ?? 0)
      setSyncResult((data.syncResult as Record<string, unknown>[]) ?? [])
      setHasExtended(true)
      setExtendOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExtending(false)
    }
  }

  const summary = results
    ? {
        total: results.length,
        inHistory: results.filter((r) => r.inHistory).length,
        notInHistory: results.filter((r) => !r.inHistory).length,
        expired: results.filter((r) => r.inSs && expiryStatus(ssExpiryFor(r)) === "expired").length,
        active: results.filter((r) => r.inSs && expiryStatus(ssExpiryFor(r)) === "active").length,
        inSs: results.filter((r) => r.inSs).length,
      }
    : null

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Extend Expired Leads</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Re-activate expired leads at the client's request — verifies distribution history and pulls the
          current expiry date from Silver Surfer CRM.
        </p>
      </div>


      {/* Step 1 — Campaign */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <h3 className="font-medium text-foreground">Campaign</h3>
        </div>
        <Label className="mb-2 block text-sm text-muted-foreground">Search by title</Label>
        <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={campaignPickerOpen}
              className="mt-2 w-full max-w-md justify-between"
              disabled={campaignsLoading || !!campaignsError}
            >
              <span className="truncate">
                {campaignsLoading
                  ? "Loading campaigns..."
                  : selectedCampaign
                  ? `${selectedCampaign.title}  ·  ${selectedCampaign.id}`
                  : "Select a campaign..."}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command
              filter={(value, search) => {
                // value is "title  ·  id" — match either
                return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
              }}
            >
              <CommandInput placeholder="Search title or ID..." />
              <CommandList>
                <CommandEmpty>No campaign found.</CommandEmpty>
                <CommandGroup>
                  {campaigns.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`${c.title}  ·  ${c.id}`}
                      onSelect={() => {
                        setCampaignId(c.id)
                        setCampaignPickerOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          campaignId === c.id ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <div className="flex flex-col">
                        <span>{c.title}</span>
                        <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {campaignsError && (
          <p className="mt-2 text-xs text-rose-400">Failed to load campaigns: {campaignsError}</p>
        )}
        {selectedCampaign && (
          <p className="mt-2 text-xs text-muted-foreground">
            Will filter history table by CAMPAIGNID = <span className="font-mono">{selectedCampaign.id}</span>
          </p>
        )}
      </div>

      {/* Step 2 — Lookup */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            2
          </span>
          <h3 className="font-medium text-foreground">Leads to extend</h3>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <Label className="text-sm text-muted-foreground">Lookup by</Label>
            <RadioGroup
              value={lookupKind}
              onValueChange={(v) => setLookupKind(v as LookupKind)}
              className="mt-2 flex gap-6"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="idnumber" id="lk-id" />
                <Label htmlFor="lk-id" className="cursor-pointer">
                  ID Number
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="cellnumber" id="lk-cell" />
                <Label htmlFor="lk-cell" className="cursor-pointer">
                  Cell Number
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="lookup-values" className="text-sm text-muted-foreground">
              Values (one per line, or comma-separated)
            </Label>
            <Textarea
              id="lookup-values"
              value={rawValues}
              onChange={(e) => setRawValues(e.target.value)}
              placeholder={
                lookupKind === "idnumber"
                  ? "8001015009087\n8203104567088\n..."
                  : "0821234567\n0837654321\n..."
              }
              rows={6}
              className="mt-2 font-mono text-sm"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {parsedValues.length} value{parsedValues.length === 1 ? "" : "s"} parsed
            </p>
          </div>
        </div>
      </div>

      {/* Action */}
      <div className="flex items-center gap-3">
        <Button onClick={handleCheck} disabled={!canCheck}>
          {isChecking ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Checking...
            </>
          ) : (
            <>
              <Search className="mr-2 h-4 w-4" />
              Check history
            </>
          )}
        </Button>
        {(results || checkError) && (
          <Button variant="ghost" onClick={handleReset}>
            Clear
          </Button>
        )}
      </div>

      {checkError && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{checkError}</span>
          </div>
        </div>
      )}

      {/* Step 3 — Results */}
      {results && summary && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              3
            </span>
            <h3 className="font-medium text-foreground">Results</h3>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <SummaryCard label="Submitted" value={summary.total} />
            <SummaryCard label="In history" value={summary.inHistory} accent="primary" />
            <SummaryCard label="Expired (history)" value={summary.expired} accent="success" />
            <SummaryCard label="Active (not expired)" value={summary.active} accent="muted" />
            <SummaryCard label="In SS expired" value={summary.inSs} accent="primary" />
          </div>

          {ssMeta?.error && (
            <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
              SS check skipped: {ssMeta.error}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{lookupKind === "idnumber" ? "ID Number" : "Cell Number"}</TableHead>
                  <TableHead>History</TableHead>
                  <TableHead>{lookupKind === "idnumber" ? "Cell Number" : "ID Number"}</TableHead>
                  <TableHead>Distributed on</TableHead>
                  <TableHead>History expiry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>SS expired</TableHead>
                  {ssExpiryColumn && <TableHead>SS {ssExpiryColumn.toLowerCase()}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.value}>
                    <TableCell className="font-mono">{r.value}</TableCell>
                    <TableCell>
                      <StatusBadge ok={r.inHistory} />
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {(lookupKind === "idnumber" ? r.cellnumber : r.idnumber) ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {r.historyCreatedOn ? (
                        formatSnowflakeDate(r.historyCreatedOn)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {r.historyExpiry ? (
                        formatSnowflakeDate(r.historyExpiry)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {!r.inSs ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        (() => {
                          const status = expiryStatus(ssExpiryFor(r))
                          if (status === "expired") {
                            return (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              >
                                <CheckCircle2 className="mr-1 h-3 w-3" />
                                Expired
                              </Badge>
                            )
                          }
                          if (status === "active") {
                            return (
                              <Badge
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 text-amber-200"
                              >
                                <AlertCircle className="mr-1 h-3 w-3" />
                                Not expired
                              </Badge>
                            )
                          }
                          return <span className="text-muted-foreground">—</span>
                        })()
                      )}
                    </TableCell>
                    <TableCell>
                      {!r.inHistory ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <StatusBadge ok={r.inSs} />
                      )}
                    </TableCell>
                    {ssExpiryColumn && (
                      <TableCell className="font-mono text-sm">
                        {r.ssRow && r.ssRow[ssExpiryColumn] != null ? (
                          formatSnowflakeDate(String(r.ssRow[ssExpiryColumn]))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {hasExtended
                ? "Extension already run. Click \"Check history\" to look up another batch."
                : extendableIdnumbers.length > 0
                ? `${extendableIdnumbers.length} lead${extendableIdnumbers.length === 1 ? "" : "s"} eligible to extend (in history, in SS, expired).`
                : "No eligible leads to extend."}
            </p>
            <Button
              onClick={() => setExtendOpen(true)}
              disabled={extendableIdnumbers.length === 0 || extending || hasExtended}
            >
              <PlayCircle className="mr-2 h-4 w-4" />
              {hasExtended
                ? "Already extended"
                : `Extend ${extendableIdnumbers.length} lead${extendableIdnumbers.length === 1 ? "" : "s"}`}
            </Button>
          </div>

          {syncResult && (
            <SyncResultPanel result={syncResult} insertedCount={insertedCount} />
          )}
        </div>
      )}

      <AlertDialog open={extendOpen} onOpenChange={(open) => !extending && setExtendOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Extend {extendableIdnumbers.length} expired leads?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This will run two statements against Snowflake:</p>
                <ol className="ml-5 list-decimal space-y-1">
                  <li>
                    <span className="font-mono">
                      TRUNCATE TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS
                    </span>
                  </li>
                  <li>
                    <span className="font-mono">
                      INSERT INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS
                    </span>{" "}
                    from <span className="font-mono">TM_HLL_HISTORYLEADSLOADED</span>, filtered to{" "}
                    <span className="font-mono">campaignid = {campaignId}</span> and the{" "}
                    {extendableIdnumbers.length} idnumber
                    {extendableIdnumbers.length === 1 ? "" : "s"} below.
                  </li>
                </ol>
                <p className="pt-1">The truncate is destructive and cannot be undone.</p>
                {extendableIdnumbers.length <= 20 ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    {extendableIdnumbers.join(", ")}
                  </p>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">
                    {extendableIdnumbers.slice(0, 10).join(", ")}, … (+
                    {extendableIdnumbers.length - 10} more)
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={extending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleExtend} disabled={extending}>
              {extending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Truncate & extend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatRand(n: number): string {
  // Compact ZAR formatting: R 12,345 or R 12.3K / R 1.2M for big numbers.
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `R ${(n / 1_000).toFixed(1)}K`
  return `R ${Math.round(n).toLocaleString()}`
}

function CompactStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string | number
  accent?: "primary" | "success" | "danger" | "muted"
}) {
  const cls =
    accent === "success"
      ? "text-emerald-300"
      : accent === "danger"
      ? "text-rose-300"
      : accent === "primary"
      ? "text-primary"
      : accent === "muted"
      ? "text-muted-foreground"
      : "text-foreground"
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-base font-semibold ${cls}`}>{value}</p>
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
  accent?: "primary" | "success" | "muted"
}) {
  const accentClass =
    accent === "success"
      ? "text-emerald-400"
      : accent === "primary"
      ? "text-primary"
      : accent === "muted"
      ? "text-muted-foreground"
      : "text-foreground"
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accentClass}`}>{value}</p>
    </div>
  )
}

function parseSyncSummary(raw: string) {
  const get = (re: RegExp): string | null => {
    const m = raw.match(re)
    return m ? m[1].trim() : null
  }
  const getInt = (re: RegExp): number | null => {
    const v = get(re)
    if (v === null) return null
    const n = parseInt(v.replace(/[\s,]/g, ""), 10)
    return Number.isFinite(n) ? n : null
  }
  return {
    runId: get(/Run ID:\s*([^\s│]+)/i),
    started: get(/Started:\s*([0-9:\-\s.]+?)(?:\s{2,}|$)/i),
    snowflakeTable: get(/Snowflake Table:\s*([^\s│]+)/i),
    sqlServerTable: get(/SQL Server Table:\s*([^\s│]+)/i),
    chunkSize: get(/Chunk Size:\s*([0-9,]+)\s*rows/i),
    rawRows: getInt(/Raw Rows:\s*([0-9,]+)/i),
    afterDedup: getInt(/After Dedup:\s*([0-9,]+)/i),
    duplicates: getInt(/\(([0-9,]+)\s*duplicates removed/i),
    totalRows: getInt(/Total Rows:\s*([0-9,]+)/i),
    successful: getInt(/Successful:\s*([0-9,]+)/i),
    failed: getInt(/Failed:\s*([0-9,]+)/i),
    skipped: getInt(/Skipped[^:]*:\s*([0-9,]+)/i),
    successRate: get(/Success Rate:\s*([0-9.]+%)/i),
    duration: get(/Duration:\s*([0-9.]+\s*minutes?)/i),
    avgRate: get(/Avg Rate:\s*([0-9.]+\s*rows\/second)/i),
    chunkLine: get(/✓\s*(Chunk\s*\d+\/\d+\s*\([^)]+\):\s*\d+\s*ok\s*\|\s*\d+\s*failed[^=]*?)\s*ETA/i),
  }
}

function SyncResultPanel({
  result,
  insertedCount,
}: {
  result: Record<string, unknown>[]
  insertedCount: number | null
}) {
  const fullText = useMemo(() => {
    if (!result || result.length === 0) return ""
    return result
      .map((row) =>
        Object.values(row)
          .filter((v) => v !== null && v !== undefined)
          .map(String)
          .join("\n")
      )
      .join("\n\n")
  }, [result])

  const parsed = useMemo(() => parseSyncSummary(fullText), [fullText])

  return (
    <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
      <div className="mb-4 flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
        <h4 className="font-medium text-emerald-200">
          Extend complete — {insertedCount ?? 0} row{insertedCount === 1 ? "" : "s"} inserted, SQL
          Server sync triggered
        </h4>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SyncStat label="Total rows" value={parsed.totalRows ?? "—"} />
        <SyncStat
          label="Successful"
          value={parsed.successful ?? "—"}
          accent={parsed.successful !== null && parsed.successful > 0 ? "success" : "muted"}
        />
        <SyncStat
          label="Failed"
          value={parsed.failed ?? 0}
          accent={parsed.failed && parsed.failed > 0 ? "danger" : "muted"}
        />
        <SyncStat label="Success rate" value={parsed.successRate ?? "—"} accent="success" />
      </div>

      {/* Run details */}
      <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-border bg-card p-4 text-sm md:grid-cols-2">
        {parsed.runId && (
          <DetailRow label="Run ID" value={parsed.runId} mono />
        )}
        {parsed.started && <DetailRow label="Started" value={parsed.started} />}
        {parsed.snowflakeTable && (
          <DetailRow label="Snowflake table" value={parsed.snowflakeTable} mono />
        )}
        {parsed.sqlServerTable && (
          <DetailRow label="SQL Server table" value={parsed.sqlServerTable} mono />
        )}
        {parsed.chunkSize && <DetailRow label="Chunk size" value={`${parsed.chunkSize} rows`} />}
        {parsed.duration && <DetailRow label="Duration" value={parsed.duration} />}
        {parsed.avgRate && <DetailRow label="Avg rate" value={parsed.avgRate} />}
        {parsed.rawRows !== null && parsed.afterDedup !== null && (
          <DetailRow
            label="Dedup"
            value={`${parsed.rawRows} raw → ${parsed.afterDedup} after${
              parsed.duplicates ? ` (${parsed.duplicates} removed)` : ""
            }`}
          />
        )}
      </div>

      {parsed.chunkLine && (
        <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 font-mono text-xs text-emerald-200">
          ✓ {parsed.chunkLine}
        </div>
      )}

      {/* Raw log toggle */}
      <details className="mt-4 group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Show raw stored-procedure output
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {fullText || "(no output)"}
        </pre>
      </details>
    </div>
  )
}

function SyncStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string | number
  accent?: "success" | "danger" | "muted"
}) {
  const cls =
    accent === "success"
      ? "text-emerald-300"
      : accent === "danger"
      ? "text-rose-300"
      : accent === "muted"
      ? "text-muted-foreground"
      : "text-foreground"
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${cls}`}>{value}</p>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-32 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`flex-1 text-sm text-foreground ${mono ? "font-mono break-all" : ""}`}>
        {value}
      </span>
    </div>
  )
}

type DashboardData = {
  campaignIds: number[]
  startDate: string
  endDate: string
  totals: {
    total: number
    distinctBatches: number
    distinctIdnumbers: number
    active: number
    expired: number
    withStatus: number
    avgScore: number | null
    avgSalary: number | null
    avgAvailableSpend: number | null
    avgUdm8Lda: number | null
  }
  byBatch: { batchName: string; count: number }[]
  byStatus: { status: string; count: number }[]
  byCampaign: { campaignId: string; count: number }[]
  byScoreDate: { scoreGroup: string; date: string; count: number }[]
  avgScoreByDay: { date: string; avgScore: number | null; count: number }[]
}

function todayLocalIso(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function ForecastingContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Forecasting</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Forecast lead volume, sales, and conversion trends.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
        <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground" />
        <h3 className="mt-3 font-medium text-foreground">Not yet implemented</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tell me what to forecast (metric, source table, horizon, grouping) and I'll wire it up.
        </p>
      </div>
    </div>
  )
}

function RecycleContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Recycle</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Re-queue previously distributed leads for another pass.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
        <Recycle className="mx-auto h-8 w-8 text-muted-foreground" />
        <h3 className="mt-3 font-medium text-foreground">Awaiting requirements</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tell me the source table, the filters (campaign, age, status, etc.), and what the
          "recycle" action should do (mark, copy, push to dialler) and I&apos;ll wire it up.
        </p>
      </div>
    </div>
  )
}

function DashboardContent() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Dashboard</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Overview of distribution activity.
        </p>
      </div>

      <Tabs defaultValue="distributed" className="w-full min-w-0">
        <TabsList>
          <TabsTrigger value="distributed">Distributed</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="dialler">Dialler</TabsTrigger>
        </TabsList>

        <TabsContent value="distributed" className="mt-4">
          <DistributedDashboardPanel />
        </TabsContent>

        <TabsContent value="sales" className="mt-4">
          <SalesDashboardPanel />
        </TabsContent>

        <TabsContent value="dialler" className="mt-4">
          <DiallerDashboardPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function DistributedDashboardPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([])
  const [startDate, setStartDate] = useState(todayLocalIso())
  const [endDate, setEndDate] = useState(todayLocalIso())

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load campaigns on mount
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(d.error || `Failed to load campaigns (${res.status})`)
          return
        }
        setCampaigns(d.campaigns || [])
      } catch (err) {
        if (!cancelled) setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // Load dashboard data when campaigns + dates are set
  useEffect(() => {
    if (selectedCampaignIds.length === 0 || !startDate || !endDate) {
      setData(null)
      return
    }
    if (startDate > endDate) {
      setError("Start date must be on or before end date.")
      setData(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          campaignIds: selectedCampaignIds.join(","),
          startDate,
          endDate,
        })
        const res = await fetch(`/api/dashboard/leads-loaded?${params.toString()}`, {
          cache: "no-store",
        })
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(d.error || `Failed (${res.status})`)
        setData(d as DashboardData)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [selectedCampaignIds, startDate, endDate])

  const selectedCampaigns = useMemo(
    () => campaigns.filter((c) => selectedCampaignIds.includes(c.id)),
    [campaigns, selectedCampaignIds]
  )

  const toggleCampaign = (id: string) =>
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )

  const triggerLabel = campaignsLoading
    ? "Loading campaigns..."
    : selectedCampaigns.length === 0
    ? "Select campaigns..."
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">Leads loaded by campaign and date.</p>

      {/* Filters */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Campaigns</Label>
            <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={campaignPickerOpen}
                  className="w-full justify-between"
                  disabled={campaignsLoading || !!campaignsError}
                >
                  <span className="truncate">{triggerLabel}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command
                  filter={(value, search) =>
                    value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput placeholder="Search title or ID..." />
                  <CommandList>
                    <CommandEmpty>No campaign found.</CommandEmpty>
                    <CommandGroup>
                      {campaigns.map((c) => {
                        const checked = selectedCampaignIds.includes(c.id)
                        return (
                          <CommandItem
                            key={c.id}
                            value={`${c.title}  ·  ${c.id}`}
                            onSelect={() => toggleCampaign(c.id)}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                checked ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col">
                              <span>{c.title}</span>
                              <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedCampaignIds.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {selectedCampaigns.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCampaign(c.id)}
                    className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                    title="Click to remove"
                  >
                    {c.title}
                    <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedCampaignIds([])}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            )}
            {campaignsError && (
              <p className="mt-2 text-xs text-rose-400">
                Failed to load campaigns: {campaignsError}
              </p>
            )}
          </div>

          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Created on</Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Start date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                aria-label="End date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  const t = todayLocalIso()
                  setStartDate(t)
                  setEndDate(t)
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Today
              </button>
            </div>
          </div>
        </div>
      </div>

      {selectedCampaignIds.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <LayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Pick one or more campaigns to load the dashboard.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {selectedCampaignIds.length > 0 && loading && !data && (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading dashboard...
        </div>
      )}

      {selectedCampaignIds.length > 0 && data && (
        <DashboardSummary data={data} campaigns={selectedCampaigns} />
      )}
    </div>
  )
}

function scoreGroupSortKey(sg: string): number {
  if (sg === "(none)") return Number.POSITIVE_INFINITY
  // Match leading number (e.g. "836 to 858", "908+", "0", "1 to 601")
  const m = sg.match(/^-?\d+/)
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER - 1
}

type SalesData = {
  campaignNames: string[]
  startDate: string
  endDate: string
  granularity: "day" | "hour"
  totals: { totalSales: number; rows: number; days: number; campaigns: number }
  bySalesDate: { date: string; sales: number }[]
  byCampaign: { campaignName: string; sales: number }[]
  byScoreDate: { scoreGroup: string; date: string; count: number }[]
}

type FilterKey = "providerTypes" | "isInsurable"

type DiallerData = {
  campaignNames: string[]
  startDate: string
  endDate: string
  granularity: "day" | "halfHour"
  totals: {
    totalLeads: number
    rows: number
    days: number
    campaigns: number
    avgScore: number | null
  }
  byBucket: { bucket: string; leads: number }[]
  byStatus: { status: string; leads: number }[]
  byCampaign: { campaignName: string; leads: number }[]
  byScoreDate: { scoreGroup: string; date: string; count: number }[]
}

function DiallerDashboardPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([])
  const [startDate, setStartDate] = useState(todayLocalIso())
  const [endDate, setEndDate] = useState(todayLocalIso())
  const [data, setData] = useState<DiallerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [statusOptions, setStatusOptions] = useState<string[]>([])
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])

  // Load campaigns
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(d.error || `Failed to load campaigns (${res.status})`)
          return
        }
        setCampaigns(d.campaigns || [])
      } catch (err) {
        if (!cancelled) setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // Load CALL_STATUS options
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard/dialler-stats/filters")
        const d = await res.json()
        if (cancelled) return
        setStatusOptions(d.values?.callStatuses ?? [])
        setStatusError(d.errors?.callStatuses)
      } catch {
        /* swallow */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedCampaigns = useMemo(
    () => campaigns.filter((c) => selectedCampaignIds.includes(c.id)),
    [campaigns, selectedCampaignIds]
  )

  // Load dialler data when campaigns + dates set
  useEffect(() => {
    if (selectedCampaigns.length === 0 || !startDate || !endDate) {
      setData(null)
      return
    }
    if (startDate > endDate) {
      setError("Start date must be on or before end date.")
      setData(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          campaignNames: selectedCampaigns.map((c) => c.title).join(","),
          startDate,
          endDate,
        })
        if (selectedStatuses.length > 0)
          params.set("callStatuses", selectedStatuses.join(","))
        const res = await fetch(`/api/dashboard/dialler-stats?${params.toString()}`, {
          cache: "no-store",
        })
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(d.error || `Failed (${res.status})`)
        setData(d as DiallerData)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [selectedCampaigns, startDate, endDate, selectedStatuses])

  const toggleCampaign = (id: string) =>
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )

  const triggerLabel = campaignsLoading
    ? "Loading campaigns..."
    : selectedCampaigns.length === 0
    ? "Select campaigns..."
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">Dialler activity by campaign and date.</p>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Campaigns</Label>
            <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={campaignPickerOpen}
                  className="w-full justify-between"
                  disabled={campaignsLoading || !!campaignsError}
                >
                  <span className="truncate">{triggerLabel}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command
                  filter={(value, search) =>
                    value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput placeholder="Search title or ID..." />
                  <CommandList>
                    <CommandEmpty>No campaign found.</CommandEmpty>
                    <CommandGroup>
                      {campaigns.map((c) => {
                        const checked = selectedCampaignIds.includes(c.id)
                        return (
                          <CommandItem
                            key={c.id}
                            value={`${c.title}  ·  ${c.id}`}
                            onSelect={() => toggleCampaign(c.id)}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                checked ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col">
                              <span>{c.title}</span>
                              <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedCampaignIds.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {selectedCampaigns.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCampaign(c.id)}
                    className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                  >
                    {c.title}
                    <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedCampaignIds([])}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            )}
            {campaignsError && (
              <p className="mt-2 text-xs text-rose-400">
                Failed to load campaigns: {campaignsError}
              </p>
            )}
          </div>

          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Call start date</Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Start date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                aria-label="End date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  const t = todayLocalIso()
                  setStartDate(t)
                  setEndDate(t)
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Today
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <MultiSelectFilter
            label="Call status"
            options={statusOptions}
            selected={selectedStatuses}
            onChange={setSelectedStatuses}
            error={statusError}
          />
        </div>
      </div>

      {selectedCampaigns.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <LayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Pick one or more campaigns to load dialler stats.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {selectedCampaigns.length > 0 && loading && !data && (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading dialler stats...
        </div>
      )}

      {selectedCampaigns.length > 0 && data && <DiallerSummary data={data} />}
    </div>
  )
}

function DiallerSummary({ data }: { data: DiallerData }) {
  const dateLabel =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`
  const avgPerDay = data.totals.days > 0 ? data.totals.totalLeads / data.totals.days : 0

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <CompactStat
          label="Total leads"
          value={data.totals.totalLeads.toLocaleString()}
          accent="success"
        />
        <CompactStat label="Days" value={data.totals.days.toLocaleString()} accent="primary" />
        <CompactStat
          label="Campaigns"
          value={data.totals.campaigns.toLocaleString()}
          accent="primary"
        />
        <CompactStat
          label="Avg / day"
          value={data.totals.days > 0 ? avgPerDay.toFixed(1) : "—"}
          accent="muted"
        />
        <CompactStat
          label="Avg score"
          value={data.totals.avgScore === null ? "—" : data.totals.avgScore.toFixed(1)}
          accent="primary"
        />
      </div>

      {/* Leads over time / by half-hour */}
      {data.byBucket.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-2">
            <h3 className="font-medium text-foreground">
              {data.granularity === "halfHour" ? "Leads by half-hour" : "Leads over time"}
            </h3>
            <p className="text-sm text-muted-foreground">
              Sum of <span className="font-mono">LEADS</span>{" "}
              {data.granularity === "halfHour" ? (
                <>
                  per <span className="font-mono">TIME_BUCKET_30MIN</span> · {dateLabel}
                </>
              ) : (
                <>
                  per <span className="font-mono">CALL_START_TIME</span> · {dateLabel}
                </>
              )}
            </p>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data.byBucket}
                margin={{ top: 10, right: 16, bottom: 0, left: -10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  tickFormatter={(v: string) =>
                    data.granularity === "halfHour" ? v : v.slice(5)
                  }
                />
                <YAxis
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="leads"
                  name="Leads"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Heatgrid SCOREGROUP × CALL_START_TIME */}
      {data.byScoreDate.length > 0 && <ScoreDateHeatgrid data={data.byScoreDate} />}

      {/* Call status breakdown */}
      {data.byStatus.length > 0 && (
        <div>
          <div className="mb-2">
            <h3 className="font-medium text-foreground">Leads by call status</h3>
            <p className="text-sm text-muted-foreground">{dateLabel}</p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Call status</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byStatus.map((r) => (
                  <TableRow key={r.status}>
                    <TableCell className="font-mono text-sm">{r.status}</TableCell>
                    <TableCell className="text-right font-mono">
                      {r.leads.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Per-campaign breakdown */}
      {data.byCampaign.length > 1 && (
        <div>
          <div className="mb-2">
            <h3 className="font-medium text-foreground">Leads per campaign</h3>
            <p className="text-sm text-muted-foreground">{dateLabel}</p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign name</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byCampaign.map((r) => (
                  <TableRow key={r.campaignName}>
                    <TableCell className="text-sm">{r.campaignName}</TableCell>
                    <TableCell className="text-right font-mono">
                      {r.leads.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {data.totals.rows === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No dialler activity for the selected campaign{data.campaignNames.length === 1 ? "" : "s"}{" "}
          on {dateLabel}.
        </div>
      )}
    </>
  )
}

function SalesDashboardPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([])
  const [startDate, setStartDate] = useState(todayLocalIso())
  const [endDate, setEndDate] = useState(todayLocalIso())
  const [data, setData] = useState<SalesData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Extra filters
  const [filterValues, setFilterValues] = useState<Record<FilterKey, string[]>>({
    providerTypes: [],
    isInsurable: [],
  })
  const [filterErrors, setFilterErrors] = useState<Partial<Record<FilterKey, string>>>({})
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [selectedInsurable, setSelectedInsurable] = useState<string[]>([])

  // Load distinct filter values once.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard/sales-stats/filters")
        const d = await res.json()
        if (cancelled || !res.ok) return
        setFilterValues({
          providerTypes: d.values?.providerTypes ?? [],
          isInsurable: d.values?.isInsurable ?? [],
        })
        setFilterErrors(d.errors ?? {})
      } catch {
        /* swallow — filters degrade to disabled */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(d.error || `Failed to load campaigns (${res.status})`)
          return
        }
        setCampaigns(d.campaigns || [])
      } catch (err) {
        if (!cancelled) setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedCampaigns = useMemo(
    () => campaigns.filter((c) => selectedCampaignIds.includes(c.id)),
    [campaigns, selectedCampaignIds]
  )

  const toggleCampaign = (id: string) =>
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )

  const triggerLabel = campaignsLoading
    ? "Loading campaigns..."
    : selectedCampaigns.length === 0
    ? "Select campaigns..."
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  // Load sales data when campaigns + dates + extra filters are set.
  useEffect(() => {
    if (selectedCampaigns.length === 0 || !startDate || !endDate) {
      setData(null)
      return
    }
    if (startDate > endDate) {
      setError("Start date must be on or before end date.")
      setData(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          campaignNames: selectedCampaigns.map((c) => c.title).join(","),
          startDate,
          endDate,
        })
        if (selectedProviders.length > 0) params.set("providerTypes", selectedProviders.join(","))
        if (selectedInsurable.length > 0) params.set("isInsurable", selectedInsurable.join(","))
        const res = await fetch(`/api/dashboard/sales-stats?${params.toString()}`, {
          cache: "no-store",
        })
        const d = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(d.error || `Failed (${res.status})`)
        setData(d as SalesData)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [selectedCampaigns, startDate, endDate, selectedProviders, selectedInsurable])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Sales activity by campaign and date.
      </p>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Campaigns</Label>
            <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={campaignPickerOpen}
                  className="w-full justify-between"
                  disabled={campaignsLoading || !!campaignsError}
                >
                  <span className="truncate">{triggerLabel}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command
                  filter={(value, search) =>
                    value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                  }
                >
                  <CommandInput placeholder="Search title or ID..." />
                  <CommandList>
                    <CommandEmpty>No campaign found.</CommandEmpty>
                    <CommandGroup>
                      {campaigns.map((c) => {
                        const checked = selectedCampaignIds.includes(c.id)
                        return (
                          <CommandItem
                            key={c.id}
                            value={`${c.title}  ·  ${c.id}`}
                            onSelect={() => toggleCampaign(c.id)}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                checked ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col">
                              <span>{c.title}</span>
                              <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedCampaignIds.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {selectedCampaigns.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCampaign(c.id)}
                    className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
                    title="Click to remove"
                  >
                    {c.title}
                    <span className="text-muted-foreground group-hover:text-rose-300">×</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedCampaignIds([])}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            )}
            {campaignsError && (
              <p className="mt-2 text-xs text-rose-400">
                Failed to load campaigns: {campaignsError}
              </p>
            )}
          </div>

          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Created on</Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Start date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                aria-label="End date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate}
                className="w-44 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  const t = todayLocalIso()
                  setStartDate(t)
                  setEndDate(t)
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Today
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <MultiSelectFilter
            label="Provider type"
            options={filterValues.providerTypes}
            selected={selectedProviders}
            onChange={setSelectedProviders}
            error={filterErrors.providerTypes}
          />
          <MultiSelectFilter
            label="Insurable"
            options={filterValues.isInsurable}
            selected={selectedInsurable}
            onChange={setSelectedInsurable}
            error={filterErrors.isInsurable}
          />
        </div>
      </div>

      {selectedCampaigns.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <LayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Pick one or more campaigns to load sales stats.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {selectedCampaigns.length > 0 && loading && !data && (
        <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading sales stats...
        </div>
      )}

      {selectedCampaigns.length > 0 && data && <SalesSummary data={data} />}
    </div>
  )
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  error,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  error?: string
}) {
  const [open, setOpen] = useState(false)

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v])

  const triggerLabel =
    options.length === 0
      ? error
        ? `${label} unavailable`
        : `No ${label.toLowerCase()} values`
      : selected.length === 0
      ? `All ${label.toLowerCase()}s`
      : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`

  return (
    <div>
      <Label className="mb-2 block text-sm text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={options.length === 0}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command
            filter={(value, search) =>
              value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
            <CommandList>
              <CommandEmpty>No match.</CommandEmpty>
              <CommandGroup>
                {selected.length > 0 && (
                  <CommandItem value="__clear__" onSelect={() => onChange([])}>
                    <span className="text-xs text-muted-foreground">(Clear selection)</span>
                  </CommandItem>
                )}
                {options.map((v) => {
                  const checked = selected.includes(v)
                  return (
                    <CommandItem key={v} value={v} onSelect={() => toggle(v)}>
                      <Check
                        className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")}
                      />
                      <span className="font-mono text-sm">{v}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {selected.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => toggle(v)}
              className="group inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground hover:border-rose-500/40 hover:text-rose-300"
            >
              {v}
              <span className="text-muted-foreground group-hover:text-rose-300">×</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-1 text-xs text-amber-400" title={error}>
          {label} column unavailable in view
        </p>
      )}
    </div>
  )
}

function SalesSummary({ data }: { data: SalesData }) {
  const dateLabel =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`
  const avgPerDay =
    data.totals.days > 0 ? data.totals.totalSales / data.totals.days : 0

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
        <CompactStat
          label="Total sales"
          value={data.totals.totalSales.toLocaleString()}
          accent="success"
        />
        <CompactStat label="Rows" value={data.totals.rows.toLocaleString()} />
        <CompactStat label="Days" value={data.totals.days.toLocaleString()} accent="primary" />
        <CompactStat
          label="Campaigns"
          value={data.totals.campaigns.toLocaleString()}
          accent="primary"
        />
        <CompactStat
          label="Avg / day"
          value={data.totals.days > 0 ? avgPerDay.toFixed(1) : "—"}
          accent="muted"
        />
      </div>

      {/* Sales over time — by hour when single day, by date when range */}
      {data.bySalesDate.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-2">
            <h3 className="font-medium text-foreground">
              {data.granularity === "hour" ? "Sales by hour" : "Sales over time"}
            </h3>
            <p className="text-sm text-muted-foreground">
              Sum of <span className="font-mono">SALES</span>{" "}
              {data.granularity === "hour" ? (
                <>
                  per hour of <span className="font-mono">ORDERORDERDATE</span> ·{" "}
                  {dateLabel}
                </>
              ) : (
                <>
                  per <span className="font-mono">ORDERDATE</span> · {dateLabel}
                </>
              )}
            </p>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data.bySalesDate}
                margin={{ top: 10, right: 16, bottom: 0, left: -10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  tickFormatter={(v: string) =>
                    data.granularity === "hour" ? v : v.slice(5)
                  }
                />
                <YAxis
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "0.5rem",
                    fontSize: "0.875rem",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="sales"
                  name="Sales"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Heatgrid of score group × date with sales as the metric */}
      {data.byScoreDate.length > 0 && <ScoreDateHeatgrid data={data.byScoreDate} />}

      {/* Per-campaign breakdown */}
      {data.byCampaign.length > 1 && (
        <div>
          <div className="mb-2">
            <h3 className="font-medium text-foreground">Sales per campaign</h3>
            <p className="text-sm text-muted-foreground">{dateLabel}</p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign name</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byCampaign.map((r) => (
                  <TableRow key={r.campaignName}>
                    <TableCell className="text-sm">{r.campaignName}</TableCell>
                    <TableCell className="text-right font-mono">
                      {r.sales.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {data.totals.rows === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No sales for the selected campaign{data.campaignNames.length === 1 ? "" : "s"} on{" "}
          {dateLabel}.
        </div>
      )}
    </>
  )
}

function AvgScoreLineChart({
  data,
}: {
  data: { date: string; avgScore: number | null; count: number }[]
}) {
  // Filter out days with no leads (avgScore null) so the line doesn't drop to 0.
  const series = data
    .filter((r) => r.avgScore !== null)
    .map((r) => ({ date: r.date, avgScore: Number(r.avgScore!.toFixed(2)), count: r.count }))

  if (series.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        No score data to plot.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-2">
        <h3 className="font-medium text-foreground">Average score over time</h3>
        <p className="text-sm text-muted-foreground">
          Mean of <span className="font-mono">SCORE</span> per day · {series.length} day
          {series.length === 1 ? "" : "s"} with data
        </p>
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              domain={["auto", "auto"]}
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
              formatter={(value: number | string, name: string) => {
                if (name === "avgScore") return [Number(value).toFixed(2), "Avg score"]
                return [String(value), name]
              }}
            />
            <Line
              type="monotone"
              dataKey="avgScore"
              name="Avg score"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ScoreDateHeatgrid({
  data,
}: {
  data: { scoreGroup: string; date: string; count: number }[]
}) {
  // All score groups present in the data, ordered by their numeric bound.
  const allScoreGroups = useMemo(() => {
    const set = new Set(data.map((r) => r.scoreGroup))
    return Array.from(set).sort((a, b) => scoreGroupSortKey(a) - scoreGroupSortKey(b))
  }, [data])

  const [filterOpen, setFilterOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [mode, setMode] = useState<"count" | "percent">("count")

  // Reset filter to "all" whenever the list of groups changes (e.g. new query).
  useEffect(() => {
    setSelected(null)
  }, [allScoreGroups.join("|")])

  const isAllSelected = selected === null
  const activeSet = selected ?? new Set(allScoreGroups)

  const toggle = (sg: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? allScoreGroups)
      if (next.has(sg)) next.delete(sg)
      else next.add(sg)
      return next
    })

  const filteredRows = useMemo(
    () => data.filter((r) => activeSet.has(r.scoreGroup)),
    [data, activeSet]
  )

  // Score groups shown — keep numeric order, restrict to selected.
  const scoreGroups = useMemo(
    () => allScoreGroups.filter((sg) => activeSet.has(sg)),
    [allScoreGroups, activeSet]
  )

  // Only show dates that have at least one row (skip empty columns).
  const dates = useMemo(() => {
    const set = new Set(filteredRows.map((r) => r.date))
    return Array.from(set).sort()
  }, [filteredRows])

  // Lookup: scoreGroup|date → count
  const lookup = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of filteredRows) m.set(`${r.scoreGroup}|${r.date}`, r.count)
    return m
  }, [filteredRows])

  // Per-day totals (sum of counts across visible score groups for each date).
  const dayTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of dates) {
      let s = 0
      for (const sg of scoreGroups) s += lookup.get(`${sg}|${d}`) ?? 0
      m.set(d, s)
    }
    return m
  }, [dates, scoreGroups, lookup])

  const maxCount = Math.max(0, ...filteredRows.map((r) => r.count))

  // For percent mode: largest share any (visible) cell takes of its day.
  // Used to stretch the red→green gradient across the actual observed range
  // instead of the theoretical 0–100%.
  const maxPercent = useMemo(() => {
    let max = 0
    for (const r of filteredRows) {
      const total = dayTotals.get(r.date) ?? 0
      if (total > 0) {
        const pct = r.count / total
        if (pct > max) max = pct
      }
    }
    return max
  }, [filteredRows, dayTotals])

  const colorAtT = (t: number): string => {
    // Gradient: red (low, hue 0) → orange/yellow → green (high, hue 158)
    const clamped = Math.max(0, Math.min(1, t))
    const hue = clamped * 158
    const sat = 70
    const lightness = 32 + clamped * 12 // 32% (low/red) → 44% (high/green)
    return `hsl(${hue} ${sat}% ${lightness}%)`
  }

  // For counts: log scale against max count.
  // For percent: linear, scaled by the largest observed share so the gradient
  // spans the actual range rather than wasting it on 50–100% which never appears.
  const cellColor = (count: number, dayTotal: number): string => {
    if (count === 0) return "rgba(255,255,255,0.02)"
    if (mode === "percent") {
      if (dayTotal === 0 || maxPercent === 0) return "rgba(255,255,255,0.02)"
      const share = count / dayTotal
      return colorAtT(share / maxPercent)
    }
    if (maxCount === 0) return "rgba(255,255,255,0.02)"
    const t = Math.min(1, Math.log10(count + 1) / Math.log10(maxCount + 1))
    return colorAtT(t)
  }

  const formatCell = (count: number, dayTotal: number): string => {
    if (count === 0) return ""
    if (mode === "percent") {
      if (dayTotal === 0) return ""
      const pct = (count / dayTotal) * 100
      return pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`
    }
    return String(count)
  }

  const grandTotal = filteredRows.reduce((a, r) => a + r.count, 0)

  return (
    <div className="w-full min-w-0 rounded-xl border border-border bg-card p-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-foreground">Score group × created on</h3>
          <p className="text-sm text-muted-foreground">
            {mode === "percent"
              ? "Each cell as % of that day's total. Empty days hidden."
              : "Lead counts coloured by intensity. Empty days are hidden."}{" "}
            {scoreGroups.length} of {allScoreGroups.length} score group
            {allScoreGroups.length === 1 ? "" : "s"} · {dates.length} day
            {dates.length === 1 ? "" : "s"}
            {mode === "count" && ` · max ${maxCount.toLocaleString()}`}
            {mode === "percent" && maxPercent > 0 &&
              ` · max ${(maxPercent * 100).toFixed(1)}%`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-background/40 p-0.5">
            <button
              type="button"
              onClick={() => setMode("count")}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                mode === "count"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Counts
            </button>
            <button
              type="button"
              onClick={() => setMode("percent")}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                mode === "percent"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              % of day
            </button>
          </div>

          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                Filter score groups{" "}
                {!isAllSelected && (
                  <span className="ml-1 rounded-full bg-primary/20 px-1.5 text-xs text-primary">
                    {activeSet.size}/{allScoreGroups.length}
                  </span>
                )}
                <ChevronsUpDown className="ml-2 h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="end">
              <Command>
                <CommandInput placeholder="Search score groups..." />
                <CommandList>
                  <CommandEmpty>No match.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value="__all__"
                      onSelect={() => setSelected(null)}
                    >
                      <Check
                        className={cn("mr-2 h-4 w-4", isAllSelected ? "opacity-100" : "opacity-0")}
                      />
                      (Select all)
                    </CommandItem>
                    {allScoreGroups.map((sg) => {
                      const checked = activeSet.has(sg)
                      return (
                        <CommandItem key={sg} value={sg} onSelect={() => toggle(sg)}>
                          <Check
                            className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")}
                          />
                          <span className="font-mono text-sm">{sg}</span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="-mx-6 overflow-x-auto px-6">
        <table className="border-separate" style={{ borderSpacing: "2px" }}>
          <thead>
            <tr>
              <th className="sticky left-0 bg-card px-2 text-left text-xs font-medium text-muted-foreground">
                Score group
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className="px-1 text-xs font-medium text-muted-foreground"
                  style={{ minWidth: 32 }}
                >
                  <span className="block whitespace-nowrap" title={d}>
                    {d.slice(5)}
                  </span>
                </th>
              ))}
              <th className="px-2 text-right text-xs font-medium text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody>
            {scoreGroups.map((sg) => {
              const rowTotal = dates.reduce(
                (acc, d) => acc + (lookup.get(`${sg}|${d}`) ?? 0),
                0
              )
              const rowTotalLabel =
                mode === "percent"
                  ? grandTotal === 0
                    ? ""
                    : `${((rowTotal / grandTotal) * 100).toFixed(1)}%`
                  : rowTotal.toLocaleString()
              return (
                <tr key={sg}>
                  <td className="sticky left-0 bg-card px-2 py-1 pr-3 text-sm font-mono">{sg}</td>
                  {dates.map((d) => {
                    const count = lookup.get(`${sg}|${d}`) ?? 0
                    const dayTotal = dayTotals.get(d) ?? 0
                    const pct = dayTotal > 0 ? (count / dayTotal) * 100 : 0
                    return (
                      <td
                        key={d}
                        title={`${sg} · ${d}: ${count.toLocaleString()} (${pct.toFixed(1)}% of day)`}
                        style={{
                          backgroundColor: cellColor(count, dayTotal),
                          minWidth: 32,
                          height: 28,
                        }}
                        className="text-center align-middle text-xs font-mono text-foreground/80"
                      >
                        {formatCell(count, dayTotal)}
                      </td>
                    )
                  })}
                  <td className="px-2 text-right font-mono text-sm">{rowTotalLabel}</td>
                </tr>
              )
            })}
            {/* Column totals */}
            <tr>
              <td className="sticky left-0 bg-card px-2 pt-2 text-xs font-medium text-muted-foreground">
                Total
              </td>
              {dates.map((d) => {
                const colTotal = dayTotals.get(d) ?? 0
                const label =
                  mode === "percent"
                    ? colTotal > 0
                      ? "100%"
                      : ""
                    : colTotal
                    ? colTotal.toLocaleString()
                    : ""
                return (
                  <td
                    key={d}
                    className="pt-2 text-center font-mono text-xs text-muted-foreground"
                  >
                    {label}
                  </td>
                )
              })}
              <td className="pt-2 text-right font-mono text-xs text-muted-foreground">
                {mode === "percent"
                  ? grandTotal > 0
                    ? "100%"
                    : ""
                  : grandTotal.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Less</span>
        {[0.0, 0.25, 0.5, 0.75, 1.0].map((t) => (
          <span
            key={t}
            className="inline-block h-3 w-6 rounded"
            style={{ backgroundColor: colorAtT(t) }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}

function DashboardSummary({
  data,
  campaigns,
}: {
  data: DashboardData
  campaigns: Campaign[]
}) {
  const titleById = new Map(campaigns.map((c) => [c.id, c.title]))
  const dateLabel =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`
  return (
    <>
      {/* KPI strip — compact, two rows on most screens */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-10">
        <CompactStat label="Total leads" value={data.totals.total.toLocaleString()} />
        <CompactStat
          label="Batches"
          value={data.totals.distinctBatches.toLocaleString()}
          accent="primary"
        />
        <CompactStat
          label="Active"
          value={data.totals.active.toLocaleString()}
          accent="success"
        />
        <CompactStat
          label="Expired"
          value={data.totals.expired.toLocaleString()}
          accent={data.totals.expired > 0 ? "danger" : "muted"}
        />
        <CompactStat
          label="Distinct IDs"
          value={data.totals.distinctIdnumbers.toLocaleString()}
        />
        <CompactStat
          label="With ESTATUS"
          value={data.totals.withStatus.toLocaleString()}
          accent="muted"
        />
        <CompactStat
          label="Avg score"
          value={data.totals.avgScore === null ? "—" : data.totals.avgScore.toFixed(1)}
          accent="primary"
        />
        <CompactStat
          label="Avg salary"
          value={data.totals.avgSalary === null ? "—" : formatRand(data.totals.avgSalary)}
          accent="primary"
        />
        <CompactStat
          label="Avg available spend"
          value={
            data.totals.avgAvailableSpend === null
              ? "—"
              : formatRand(data.totals.avgAvailableSpend)
          }
          accent="primary"
        />
        <CompactStat
          label="Avg UDM8 LDA"
          value={data.totals.avgUdm8Lda === null ? "—" : data.totals.avgUdm8Lda.toFixed(2)}
          accent="primary"
        />
      </div>

      {/* Heatgrid: SCOREGROUP × CREATEDONDATE */}
      {data.byScoreDate.length > 0 && <ScoreDateHeatgrid data={data.byScoreDate} />}

      {/* Avg score by day */}
      {data.avgScoreByDay.length > 0 && <AvgScoreLineChart data={data.avgScoreByDay} />}

      {/* Status breakdown table */}
      {data.byStatus.length > 0 && (
        <div>
          <div className="mb-2">
            <h3 className="font-medium text-foreground">Status breakdown</h3>
            <p className="text-sm text-muted-foreground">
              ESTATUS distribution for {dateLabel}
            </p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ESTATUS</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byStatus.map((r) => (
                  <TableRow key={r.status}>
                    <TableCell className="font-mono text-sm">{r.status}</TableCell>
                    <TableCell className="text-right font-mono">{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* By campaign — only meaningful when more than one is selected */}
      {data.byCampaign.length > 1 && (
        <div>
          <div className="mb-2">
            <h3 className="font-medium text-foreground">Leads per campaign</h3>
            <p className="text-sm text-muted-foreground">
              Counts for {dateLabel} across {data.byCampaign.length} campaign
              {data.byCampaign.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Campaign ID</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byCampaign.map((r) => (
                  <TableRow key={r.campaignId}>
                    <TableCell className="text-sm">
                      {titleById.get(r.campaignId) ?? (
                        <span className="text-muted-foreground">(not in selection)</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.campaignId}</TableCell>
                    <TableCell className="text-right font-mono">{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {data.totals.total === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No leads loaded for the selected campaign{data.campaignIds.length === 1 ? "" : "s"} for{" "}
          {dateLabel}.
        </div>
      )}
    </>
  )
}

function SettingsContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Distribution-specific settings. App-wide auth settings live on the department picker.
        </p>
      </div>

      <CampaignSettingsPanel />
    </div>
  )
}

function CampaignSettingsPanel() {
  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setCampaignsLoading(true)
      setCampaignsError(null)
      try {
        const res = await fetch("/api/campaigns")
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setCampaignsError(data.error || `Failed to load campaigns (${res.status})`)
          setCampaigns([])
        } else {
          setCampaigns(data.campaigns || [])
        }
      } catch (err) {
        if (cancelled) return
        setCampaignsError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setCampaignsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedCampaign = campaigns.find((c) => c.id === campaignId)

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <SettingsIcon className="h-5 w-5 text-muted-foreground" />
        <h3 className="font-medium text-foreground">Campaign</h3>
      </div>
      <Label className="mb-2 block text-sm text-muted-foreground">Search by title</Label>
      <Popover open={campaignPickerOpen} onOpenChange={setCampaignPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={campaignPickerOpen}
            className="w-full max-w-md justify-between"
            disabled={campaignsLoading || !!campaignsError}
          >
            <span className="truncate">
              {campaignsLoading
                ? "Loading campaigns..."
                : selectedCampaign
                ? `${selectedCampaign.title}  ·  ${selectedCampaign.id}`
                : "Select a campaign..."}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command
            filter={(value, search) => {
              return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }}
          >
            <CommandInput placeholder="Search title or ID..." />
            <CommandList>
              <CommandEmpty>No campaign found.</CommandEmpty>
              <CommandGroup>
                {campaigns.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.title}  ·  ${c.id}`}
                    onSelect={() => {
                      setCampaignId(c.id)
                      setCampaignPickerOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        campaignId === c.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <div className="flex flex-col">
                      <span>{c.title}</span>
                      <span className="text-xs text-muted-foreground">ID: {c.id}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {campaignsError && (
        <p className="mt-2 text-xs text-rose-400">Failed to load campaigns: {campaignsError}</p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Selection isn&apos;t saved yet — per-campaign settings will be wired up once the settings
        table is defined.
      </p>
    </div>
  )
}

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
      <CheckCircle2 className="mr-1 h-3 w-3" />
      Found
    </Badge>
  ) : (
    <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300">
      <XCircle className="mr-1 h-3 w-3" />
      Missing
    </Badge>
  )
}

export function DistributionDashboard({ onBack }: { onBack?: () => void } = {}) {
  const { user, logout } = useAuth()
  const [activeNav, setActiveNav] = useState("dashboard")

  const renderContent = useCallback(() => {
    switch (activeNav) {
      case "dashboard":
        return <DashboardContent />
      case "manual":
        return <ManualContent />
      case "automation":
        return <AutomationContent />
      case "extend-expired":
        return <ExtendExpiredContent />
      case "daily-files":
        return <DailyFilesContent />
      case "recycle":
        return <RecycleContent />
      case "forecasting":
        return <ForecastingContent />
      case "settings":
        return <SettingsContent />
      default:
        return <DashboardContent />
    }
  }, [activeNav])

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <Truck className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">Distribution</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Options</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      onClick={() => setActiveNav(item.id)}
                      isActive={activeNav === item.id}
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
                <ArrowLeft className="h-4 w-4 mr-2" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Logout
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
                <ArrowLeft className="h-4 w-4" />
                Departments
              </Button>
            )}
            <span className="text-sm font-medium text-muted-foreground">Distribution Department</span>
          </div>
        </header>

        <main className="flex-1 overflow-auto min-w-0">
          <div className="min-w-0 p-6">{renderContent()}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
