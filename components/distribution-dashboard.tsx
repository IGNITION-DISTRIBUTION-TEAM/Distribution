"use client"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Legend,
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
  TableFooter,
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
import { DepartmentShell } from "@/components/department-shell"
import {
  Truck,
  Zap,
  Hand,
  Clock,
  Search,
  SearchIcon,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Check,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Download,
  Files,
  PlayCircle,
  Upload,
  Server,
  Database,
  Settings as SettingsIcon,
  DatabaseZap,
  Mail,
  TrendingUp,
  Recycle,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react"
import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  SKIP_VALUE,
  ALLOWED_SQL_TYPES,
  sanitizeColumnName,
  autoMatchColumn,
  type TargetColumn as SharedTargetColumn,
} from "@/lib/column-mapping"
import type { TaskRow } from "@/app/api/distribution/tasks/route"
import { StatTile } from "@/components/kit/stat-tile"
import { Banner } from "@/components/kit/banner"
import { Card } from "@/components/ui/card"
import { PageHeading, SectionHeading } from "@/components/kit/heading"
import { Skeleton, SkeletonPanel, SkeletonRows, SkeletonText } from "@/components/kit/skeleton"
import { useChartMotion } from "@/hooks/use-chart-motion"

type NavItem = {
  id: string
  label: string
  icon: React.ReactNode
}

const navItems: NavItem[] = [
  { id: "manual", label: "Manual", icon: <Hand className="h-4 w-4" /> },
  { id: "automation", label: "Automation", icon: <Zap className="h-4 w-4" /> },
  { id: "extend-expired", label: "Extend Expired Leads", icon: <Clock className="h-4 w-4" /> },
  { id: "daily-files", label: "Daily Files", icon: <Files className="h-4 w-4" /> },
  { id: "temp-upload", label: "Temp Upload", icon: <DatabaseZap className="h-4 w-4" /> },
  { id: "recycle", label: "Recycle", icon: <Recycle className="h-4 w-4" /> },
  { id: "forecasting", label: "Forecasting", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
]

type LeadSource = "file" | "sftp" | "snowflake"

// A step's live state in the run UI.
type StepView = { step: string; status: "pending" | "running" | "success" | "error" | "skipped"; message?: string }

// Fire the sync fire-and-forget. Snowflake runs a scripting block that records
// its outcome in the SYNC_RUNS marker table, so we don't wait for the ~2h sync.
async function submitSyncFireAndForget(configId: number | string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/distribution/configs/${configId}/sync`, { method: "POST" })
  const data = await res.json().catch(() => ({}))
  if ((data as { error?: string }).error) return { ok: false, error: (data as { error: string }).error }
  return { ok: true }
}

// Run a specific saved config, step-by-step. Thin wrapper over runStepwiseAt.
async function runConfigStepwise(
  configId: number | string,
  setSteps: (steps: StepView[]) => void
): Promise<{ ok: boolean; ran: number }> {
  return runStepwiseAt(`/api/distribution/configs/${configId}/run`, setSteps, configId)
}

// Client-orchestrated run: fetch the plan, then submit each step to Snowflake
// asynchronously and poll it to completion — each HTTP request is short, so a
// slow procedure can't hang or time out the page. The sync step is fire-and-
// forget (submitted, not waited on). Throws on plan errors (no config/inactive).
async function runStepwiseAt(
  base: string,
  setSteps: (steps: StepView[]) => void,
  configId?: number | string
): Promise<{ ok: boolean; ran: number }> {
  const planRes = await fetch(`${base}/plan`, { cache: "no-store" })
  const planData = await planRes.json().catch(() => ({}))
  if (!planRes.ok) throw new Error((planData as { error?: string }).error || `Failed to plan run (${planRes.status})`)
  const plan = ((planData as { steps?: { key: string; label: string }[] }).steps) || []

  const views: StepView[] = plan.map((s) => ({ step: s.label, status: "pending" }))
  setSteps([...views])
  if (!plan.length) return { ok: true, ran: 0 }

  let failed = false
  let ran = 0
  for (let i = 0; i < plan.length; i++) {
    views[i] = { step: plan[i].label, status: "running" }
    setSteps([...views])
    try {
      // Sync is fire-and-forget: submit and move on (it can run for hours).
      if (plan[i].key === "sync" && configId != null) {
        const r = await submitSyncFireAndForget(configId)
        if (!r.ok) throw new Error(r.error || "Failed to submit sync")
        views[i] = { step: plan[i].label, status: "success", message: "submitted — running in the background (safe to leave this page)" }
        ran++
        setSteps([...views])
        continue
      }
      const subRes = await fetch(`${base}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: plan[i].key }),
      })
      const sub = await subRes.json().catch(() => ({}))
      if ((sub as { error?: string }).error) throw new Error((sub as { error: string }).error)
      const handle = (sub as { handle?: string }).handle
      const ranSql = (sub as { sql?: string }).sql ?? ""
      if (!handle) throw new Error("No statement handle returned")
      // Poll the async statement until it completes or errors.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500))
        // The key goes back on the poll so a failure can name the procedure the
        // step called — the SQL is long gone by the time Snowflake reports a
        // compilation error.
        const pr = await fetch(
          `${base}/step?handle=${encodeURIComponent(handle)}&key=${encodeURIComponent(plan[i].key)}`,
          { cache: "no-store" }
        )
        const ps = (await pr.json().catch(() => ({ status: "error", error: "poll failed" }))) as { status?: string; error?: string }
        if (ps.status === "running") continue
        if (ps.status === "error") throw new Error(withRanSql(ps.error || "Step failed", ranSql))
        break
      }
      views[i] = { step: plan[i].label, status: "success", message: "done" }
      ran++
      setSteps([...views])
    } catch (e) {
      views[i] = { step: plan[i].label, status: "error", message: e instanceof Error ? e.message : String(e) }
      setSteps([...views])
      failed = true
      break
    }
  }

  const summary = views
    .map((v) => `${v.step}: ${v.status}${v.status === "error" && v.message ? ` — ${v.message}` : ""}`)
    .join(" | ")
  await fetch(`${base}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: !failed, summary, ran, steps: views }),
  }).catch(() => {})

  return { ok: !failed, ran }
}

// Log a single per-step run to the config's run history (so individual runs
// show up in "Previous runs", not just full runs).
async function recordStepRun(configId: number | string, label: string, ok: boolean, message?: string): Promise<void> {
  const status = ok ? "success" : "error"
  await fetch(`/api/distribution/configs/${configId}/run/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok,
      ran: ok ? 1 : 0,
      summary: `${label}: ${status}${!ok && message ? ` — ${message}` : ""}`,
      steps: [{ step: label, status, message }],
    }),
  }).catch(() => {})
}

/**
 * Append the statement that was actually submitted to a failure message.
 *
 * Reading the CALL is the fastest way to separate "the procedure is wrong" from
 * "the config edit was never saved" — the two look identical in Snowflake's
 * reply. Long statements (the HLL INSERT) are clipped; the head carries the
 * useful part.
 */
function withRanSql(message: string, sql: string): string {
  if (!sql) return message
  const shown = sql.length > 300 ? `${sql.slice(0, 300)}…` : sql
  return `${message}\nRan: ${shown}`
}

// Run a single step (submit async + poll to completion). Used by the per-step
// "Run" buttons in Settings.
async function runOneStepAt(
  base: string,
  key: string
): Promise<{ ok: boolean; error?: string; result?: string }> {
  const subRes = await fetch(`${base}/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  })
  const sub = await subRes.json().catch(() => ({}))
  if ((sub as { error?: string }).error) return { ok: false, error: (sub as { error: string }).error }
  const handle = (sub as { handle?: string }).handle
  const ranSql = (sub as { sql?: string }).sql ?? ""
  if (!handle) return { ok: false, error: "No statement handle returned" }
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    const pr = await fetch(
      `${base}/step?handle=${encodeURIComponent(handle)}&key=${encodeURIComponent(key)}`,
      { cache: "no-store" }
    )
    const ps = (await pr.json().catch(() => ({ status: "error", error: "poll failed" }))) as {
      status?: string
      error?: string
      result?: string
    }
    if (ps.status === "running") continue
    if (ps.status === "error") return { ok: false, error: withRanSql(ps.error || "Step failed", ranSql) }
    // What the statement returned — a procedure's own report, or the rows a DML
    // touched. "Done." says only that Snowflake did not object.
    return { ok: true, result: ps.result }
  }
}

// Icon for a step's state (spinner while running).
function StepStatusIcon({ status }: { status: StepView["status"] }) {
  if (status === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-400" />
  if (status === "success") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
  if (status === "error") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
  if (status === "pending") return <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
  return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
}

function ManualContent() {
  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [source, setSource] = useState<LeadSource | null>(null)
  // A campaign can have many configs; the Manual page runs one at a time.
  const [configs, setConfigs] = useState<CampaignConfig[]>([])
  const [configId, setConfigId] = useState<number | null>(null)
  const [configsLoading, setConfigsLoading] = useState(false)

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

  const selectedConfig = configs.find((c) => Number(c.CONFIG_ID) === configId)
  const sourceOfConfig = (c: CampaignConfig | undefined): LeadSource => {
    const ls = (c?.LEAD_SOURCE as string | undefined)?.toLowerCase()
    return ls === "sftp" || ls === "snowflake" ? ls : "file"
  }

  // When a campaign is picked, load its automation configs; default to the
  // first, and set the lead source from that config.
  useEffect(() => {
    if (!campaignId) { setConfigs([]); setConfigId(null); setSource(null); return }
    let cancelled = false
    setConfigsLoading(true); setSource(null); setConfigId(null)
    fetch(`/api/campaign-configs?campaignId=${campaignId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const list = (data?.configs as CampaignConfig[]) || []
        setConfigs(list)
        if (list.length > 0) {
          const first = list[0]
          setConfigId(Number(first.CONFIG_ID))
          setSource(sourceOfConfig(first))
        }
      })
      .catch(() => { if (!cancelled) setConfigs([]) })
      .finally(() => { if (!cancelled) setConfigsLoading(false) })
    return () => { cancelled = true }
  }, [campaignId])

  // Switch the active config (updates the shown lead source too).
  const selectConfig = (id: number) => {
    setConfigId(id)
    setSource(sourceOfConfig(configs.find((c) => Number(c.CONFIG_ID) === id)))
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Manual Lead Distribution</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Distribute leads to dialling systems and CRM. Pick the campaign first, then choose how to
          bring the leads in.
        </p>
      </div>

      {/* Step 1 — Campaign */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <SectionHeading>Campaign</SectionHeading>
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
      </Card>

      {/* Step 2 — choose source (only after campaign selected) */}
      {selectedCampaign && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              2
            </span>
            <SectionHeading>Automation &amp; lead source</SectionHeading>
          </div>

          {configsLoading ? (
            <p className="text-sm text-muted-foreground">Loading this campaign&apos;s automations…</p>
          ) : configs.length === 0 ? (
            <p className="text-sm text-amber-400">
              No automations configured for this campaign yet. Set one up in{" "}
              <span className="font-medium text-foreground">Settings → Campaign automation</span>.
            </p>
          ) : (
            <>
              {/* Pick which saved automation config to use. */}
              <div className="mb-4 max-w-md">
                <Label className="mb-1.5 block text-xs text-muted-foreground">Automation config</Label>
                <Select value={configId != null ? String(configId) : ""} onValueChange={(v) => selectConfig(Number(v))}>
                  <SelectTrigger><SelectValue placeholder="Select a config…" /></SelectTrigger>
                  <SelectContent>
                    {configs.map((c) => (
                      <SelectItem key={String(c.CONFIG_ID)} value={String(c.CONFIG_ID)}>
                        {c.CONFIG_NAME || "Automation"}{c.IS_ACTIVE === false ? " (inactive)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* The lead source is defined by the chosen config. */}
              {source && (
                <div className="grid gap-3 md:grid-cols-3">
                  {source === "file" && (
                    <SourceCard active onClick={() => {}} icon={<Upload className="h-5 w-5" />} title="Upload a file" description="CSV, Excel, or JSON" />
                  )}
                  {source === "sftp" && (
                    <SourceCard active onClick={() => {}} icon={<Server className="h-5 w-5" />} title="SFTP" description="Pull from a remote server" />
                  )}
                  {source === "snowflake" && (
                    <SourceCard active onClick={() => {}} icon={<Database className="h-5 w-5" />} title="Snowflake" description="Run the saved distribution" />
                  )}
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Lead source is set per config in <span className="font-medium text-foreground">Settings → Campaign automation</span>.
              </p>
            </>
          )}
        </Card>
      )}

      {/* Step 3 — source-specific config */}
      {selectedCampaign && source && configId != null && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              3
            </span>
            <SectionHeading>
              {source === "file" && "Upload file"}
              {source === "sftp" && "SFTP connection"}
              {source === "snowflake" && "Run distribution"}
            </SectionHeading>
          </div>

          {source === "file" && (
            <FileSourcePanel
              campaignId={selectedCampaign.id}
              configId={configId}
              parentStep={3}
            />
          )}
          {source === "sftp" && <SftpSourcePanel />}
          {source === "snowflake" && <SnowflakeSourcePanel configId={configId} configName={selectedConfig?.CONFIG_NAME ?? "Automation"} campaignId={selectedCampaign.id} />}
        </Card>
      )}

      {/* Steps 4 and 5 — extract, then email. Snowflake only: on a file source
          both live inside the panel above as tabs, next to the other tools, so
          repeating them here would be the same two buttons twice. */}
      {selectedCampaign && source === "snowflake" && configId != null && (
        <Card>
          <ExportDownloadStep campaignId={String(selectedCampaign.id)} step={4} />
        </Card>
      )}

      {selectedCampaign && source === "snowflake" && (
        <Card>
          <EmailExportStep campaignId={String(selectedCampaign.id)} step={5} />
        </Card>
      )}
    </div>
  )
}

/**
 * The heading of a step card. Numbered when it is one of the outer numbered
 * steps; bare when it sits inside a tab, where the tab label already carries
 * the number (or says "Tools ·" and deliberately has none).
 */
function StepHeading({ step, title }: { step?: number; title: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      {step != null && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {step}
        </span>
      )}
      <SectionHeading>{title}</SectionHeading>
    </div>
  )
}

function ExportDownloadStep({ campaignId, step }: { campaignId: string; step?: number }) {
  return (
    <div>
      <StepHeading step={step} title="Extract data" />
      <p className="mb-4 text-sm text-muted-foreground">
        Download today&apos;s distributed leads for campaign{" "}
        <span className="font-medium text-foreground">{campaignId}</span> in the CXM format (CSV,
        UTF-8, no BOM).
      </p>
      <Button variant="outline" asChild>
        <a href={`/api/distribution/export?campaignId=${encodeURIComponent(campaignId)}`}>
          <Download className="mr-2 h-4 w-4" /> Download data (CSV)
        </a>
      </Button>
    </div>
  )
}

function EmailExportStep({ campaignId, step }: { campaignId: string; step?: number }) {
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setSending(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch(
        `/api/distribution/export/email?campaignId=${encodeURIComponent(campaignId)}`,
        { method: "POST" }
      )
      const text = await res.text()
      let data: {
        ok?: boolean
        error?: string
        to?: string[]
        messages?: number
        split?: boolean
        sends?: { filename: string; rows: number }[]
      }
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`Server returned ${res.status} (not JSON): ${text.slice(0, 160)}`)
      }
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const n = data.messages ?? 1
      const names = (data.sends ?? []).map((f) => f.filename).join(", ")
      setResult(
        n > 1
          ? `Sent to ${(data.to ?? []).join(", ")} in ${n} emails — ${names}`
          : `Sent to ${(data.to ?? []).join(", ")} — ${names}`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <StepHeading step={step} title="Email data" />
      <p className="mb-4 text-sm text-muted-foreground">
        Send the same file to{" "}
        <span className="font-medium text-foreground">DATA Operations and Dialler</span>. The
        attachment is named after the batch; several batches are attached as separate files. Built
        from the same query as the download, so it is the identical file. A large export is
        compressed, and split across several emails if it still will not fit — each marked
        &ldquo;batch 1 of N&rdquo; with the batch name, and each carrying its own header row.
      </p>
      <Button variant="outline" onClick={send} disabled={sending}>
        {sending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Mail className="mr-2 h-4 w-4" />
        )}
        {sending ? "Sending..." : "Email data"}
      </Button>
      {result && <p className="mt-3 text-sm text-emerald-300">{result}</p>}
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
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

// Shared with the Task Automation SFTP wizard — see lib/column-mapping.ts.
// Kept in one place rather than copied: this file is ~9,500 lines and a second
// copy of autoMatchColumn would drift from the first the moment either changed.
type TargetColumn = SharedTargetColumn

type CreateColSpec = { sourceHeader: string; name: string; type: string }

/**
 * Parse a fetch Response expected to be JSON. When an upstream (hosting
 * platform / reverse proxy) rejects a request before it reaches our route —
 * most commonly a 413 "Request Entity Too Large" for an oversized upload — the
 * body is plain text, and a bare res.json() throws an opaque "Unexpected token"
 * error. This surfaces an actionable message instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON envelope of unknown shape; callers narrow it
async function parseJsonResponse(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const snippet = text.trim().replace(/\s+/g, " ").slice(0, 140)
    if (res.status === 413 || /request entity too large|too large/i.test(snippet)) {
      throw new Error(
        "File is too large for the upload endpoint (HTTP 413). Reduce the file size, or have an admin raise the request body limit."
      )
    }
    throw new Error(`Unexpected ${res.status} response: ${snippet || res.statusText}`)
  }
}

const MAX_PREVIEW_SAMPLE_ROWS = 10

/**
 * Build the file preview entirely in the browser. This previously POSTed the
 * file to /api/upload/preview, but on Vercel the ~4.5MB serverless request
 * body limit rejected larger files with a plain-text 413. xlsx parses fine
 * client-side, so we avoid the upload — and the limit — altogether. (The
 * "Load to Snowflake" step is not yet implemented, so no other step sends the
 * full file to the server.)
 */
async function buildFilePreview(file: File): Promise<{ preview: FilePreview; allRows: string[][] }> {
  const lower = file.name.toLowerCase()
  const isCsv = lower.endsWith(".csv")
  const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls")
  if (!isCsv && !isExcel) {
    throw new Error("Only .csv, .xlsx, and .xls files are accepted")
  }

  const XLSX = await import("xlsx")
  const workbook = isCsv
    ? XLSX.read(await file.text(), { type: "string" })
    : XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true })

  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error("File contains no sheets")

  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  })
  if (rows.length === 0) throw new Error("File contains no data rows")

  const headers = Object.keys(rows[0])
  const toCell = (v: unknown) => (v === null || v === undefined ? "" : String(v))
  const allRows = rows.map((row) => headers.map((h) => toCell(row[h])))
  const sample = allRows.slice(0, MAX_PREVIEW_SAMPLE_ROWS)

  return {
    preview: { fileName: file.name, sheetName, rowCount: rows.length, headers, sample },
    allRows,
  }
}

// Step 2 — run the campaign's "Load into history" procedure (stage → HLL).
function LoadHistorySection({
  campaignId,
  proc,
  configId,
}: {
  campaignId: string
  proc: string
  configId?: number | null
}) {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)

  const handleRun = async () => {
    setRunning(true)
    setDone(false)
    try {
      const res = await fetch("/api/leads/load-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, configId }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      toast.success("Load into history procedure completed")
      setDone(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <SectionHeading>Load into history</SectionHeading>
      <p className="mt-1 text-sm text-muted-foreground">
        Runs the campaign&apos;s configured procedure to load the stage table into the history (HLL)
        table.
      </p>
      <div className="mt-4">
        <Label className="mb-1.5 block text-xs text-muted-foreground">Procedure to run</Label>
        {proc ? (
          <code className="block rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
            CALL {proc}()
          </code>
        ) : (
          <p className="text-sm text-amber-300">
            No &quot;Load into history procedure&quot; is configured for this campaign. Set it in
            Settings → Campaign.
          </p>
        )}
      </div>
      <Button className="mt-4" onClick={handleRun} disabled={running || !proc}>
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Database className="mr-2 h-4 w-4" />
        )}
        {done ? "Run again" : "Run load into history"}
      </Button>
    </Card>
  )
}

type LabelCount = { label: string | null; leads: number }

type CountCheckResult = {
  stageTable: string
  stageCount: number
  hllCount: number
  match: boolean
  // null when the breakdown query failed; absent entirely from a deployment
  // that predates it. Those are different situations and the panel says which.
  byEstatus?: LabelCount[] | null
  byEstatusError?: string | null
  byRank?: LabelCount[] | null
  byRankError?: string | null
}

/**
 * One breakdown of today's loaded leads.
 *
 * Matching totals prove the load lost nothing. They say nothing at all about
 * what is IN the batch, and two columns answer that:
 *
 *   ESTATUS  where every upstream exclusion ends up, carried into the HLL
 *            rather than filtered out of it. A batch can reconcile perfectly
 *            and still be mostly leads that a DMASA, history or duplicate check
 *            already objected to.
 *   UDM30    the rank, written by the last update-HLL procedure. All NULL until
 *            that has run, which is exactly what the unset count tells you.
 *
 * Both are the same shape, so this renders either. The wording differs because
 * "unlabelled" and "unranked" are not the same news: one is the eligible lead
 * you want, the other is a step that has not run yet.
 */
function LabelBreakdown({
  title,
  rows,
  total,
  error,
  unsetLabel,
  unsetWord,
  setWord,
  footnote,
  missingNote,
  emptyNote,
}: {
  title: string
  rows: LabelCount[] | null | undefined
  total: number
  error?: string | null
  /** How the NULL row reads in the table. */
  unsetLabel: string
  /** The two halves of the summary line above the table. */
  unsetWord: string
  setWord: string
  footnote: string
  /** Said when every row is unset — the useful case for a rank. */
  missingNote?: string
  /** Said when there are no rows at all. A filtered breakdown needs its own
   *  wording: no rows means nothing matched the filter, not nothing loaded. */
  emptyNote?: string
}) {
  // Every reason this can be empty gets said out loud. Rendering nothing was
  // the original behaviour and it is indistinguishable from the feature being
  // missing — which is exactly how it read when the browser was still on a
  // build that predated the API returning it.
  const note = (text: string) => (
    <div className="mt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-xs text-amber-300">{text}</p>
    </div>
  )
  if (error) return note(`Could not read the breakdown: ${error}`)
  if (rows === undefined) {
    return note(
      "Not available from this deployment — the running build predates the breakdown. It appears after the next deploy; the counts above are unaffected."
    )
  }
  if (rows === null) return note("Could not read the breakdown.")
  if (rows.length === 0) {
    return note(
      emptyNote ??
        (total > 0
          ? "No rows grouped, though the HLL count above is not zero — worth a look."
          : "Nothing loaded today, so there is nothing to break down.")
    )
  }
  const unset = rows.filter((r) => r.label == null).reduce((a, r) => a + r.leads, 0)
  const set = total - unset
  const pct = (n: number) => (total > 0 ? `${((100 * n) / total).toFixed(1)}%` : "—")
  // A single all-NULL row is a step that has not run, not a distribution.
  const allUnset = rows.length === 1 && rows[0].label == null

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-emerald-300">{set.toLocaleString()}</span> {setWord}
          {" · "}
          <span className="font-medium text-amber-300">{unset.toLocaleString()}</span> {unsetWord}
        </span>
      </div>

      {allUnset && missingNote && <p className="mb-2 text-xs text-amber-300">{missingNote}</p>}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table className="text-xs">
          <TableHeader className="bg-card">
            <TableRow className="text-[10px] uppercase tracking-wide">
              <TableHead>{title.replace(/^By /i, "")}</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label ?? "__none__"}>
                <TableCell>
                  {r.label == null ? (
                    <span className="text-amber-300">{unsetLabel}</span>
                  ) : (
                    <span className="text-foreground">{r.label}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-foreground">
                  {r.leads.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {pct(r.leads)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{footnote}</p>
    </div>
  )
}

// Step 3 — compare the stage table row count to the HLL count for this campaign today.
function VerifyCountsSection({
  campaignId,
  configId,
}: {
  campaignId: string
  // Which config's upload target to check. Without it the API has to guess at
  // the campaign's active config, which is not necessarily the one on screen.
  configId?: number | null
}) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CountCheckResult | null>(null)

  const handleCheck = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch("/api/leads/count-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, configId }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setResult(data as CountCheckResult)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <SectionHeading>Verify counts</SectionHeading>
      <p className="mt-1 text-sm text-muted-foreground">
        Compares the stage table row count against the HLL (main) table for this campaign loaded
        today.
      </p>
      <Button className="mt-4" onClick={handleCheck} disabled={loading}>
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Search className="mr-2 h-4 w-4" />
        )}
        Check counts
      </Button>

      {result && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Stage rows" value={result.stageCount} tone="primary" />
          <StatTile label="HLL rows (today)" value={result.hllCount} tone="primary" />
          <div className="rounded-lg border border-border bg-background/40 p-4">
            <p className="text-xs text-muted-foreground">Match</p>
            <div className="mt-2">
              {result.match ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                >
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  Counts match
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-rose-500/30 bg-rose-500/10 text-rose-300"
                >
                  <XCircle className="mr-1 h-3 w-3" />
                  Mismatch
                </Badge>
              )}
            </div>
          </div>
        </div>
      )}

      {result && (
        <>
          <LabelBreakdown
            title="By ESTATUS"
            rows={result.byEstatus}
            total={result.hllCount}
            error={result.byEstatusError}
            unsetLabel="(no label — eligible)"
            setWord="labelled"
            unsetWord="unlabelled"
            footnote="Labelled leads are in this batch, not excluded from it — the load carries ESTATUS through rather than filtering on it. Whether that is right depends on what reads ESTATUS downstream."
          />
          <LabelBreakdown
            title="By rank (UDM30) — eligible leads only"
            rows={result.byRank}
            // The eligible count, not the batch total: this breakdown covers
            // only ESTATUS IS NULL rows, so a share of 23,000 would not add up
            // to 100% and every row would read as smaller than it is. The sum
            // of its own rows IS the eligible count, so no extra query.
            total={(result.byRank ?? []).reduce((a, r) => a + r.leads, 0)}
            error={result.byRankError}
            unsetLabel="(no rank)"
            setWord="ranked"
            unsetWord="unranked"
            missingNote="No eligible lead is ranked yet. UDM30 is written by the last update-HLL procedure, so this stays empty until that step has run."
            emptyNote="No eligible leads today — every lead in this batch carries an ESTATUS label, so there is nothing to rank."
            footnote="Eligible leads only (ESTATUS IS NULL), because a rank sets dialling order and a labelled lead is one something upstream objected to. Shares are of the eligible count, not the batch. Ordered by rank rather than by size; a rank that is not a number sorts last."
          />
        </>
      )}
    </Card>
  )
}

// Step 4 — run the campaign's "update HLL" proc, CALL proc(campaignId). The proc
// is the campaign-assigned one, or an override picked from the master list.
function UpdateHllSection({
  campaignId,
  configId,
}: {
  campaignId: string
  configId?: number | null
}) {
  const [procs, setProcs] = useState<HllProc[]>([])
  const [assignedProc, setAssignedProc] = useState("")
  const [override, setOverride] = useState("")
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [procsRes, assigned] = await Promise.all([
          fetch("/api/hll-procedures", { cache: "no-store" }),
          prefillFromConfig(campaignId, "UPDATE_HLL_PROCEDURE"),
        ])
        if (cancelled) return
        if (procsRes.ok) {
          const d = await procsRes.json()
          setProcs((d.rows as HllProc[]) ?? [])
        }
        if (assigned) setAssignedProc(assigned)
      } catch {
        // best-effort
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [campaignId])

  const effectiveProc = override || assignedProc

  const handleRun = async () => {
    setRunning(true)
    setDone(false)
    try {
      const res = await fetch("/api/leads/update-hll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, configId, procOverride: override || undefined }),
      })
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      toast.success(`Ran ${data.proc}(${campaignId})`)
      setDone(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <SectionHeading>Update HLL</SectionHeading>
      <p className="mt-1 text-sm text-muted-foreground">
        Runs the update-HLL procedure for this campaign — <span className="font-mono">CALL
        proc({campaignId})</span>. Uses the campaign&apos;s assigned procedure, or an override below.
      </p>

      <div className="mt-4 max-w-md">
        <Label className="mb-1.5 block text-xs text-muted-foreground">
          Procedure (override)
        </Label>
        <Select
          value={override || NONE_PROC}
          onValueChange={(v) => setOverride(v === NONE_PROC ? "" : v)}
        >
          <SelectTrigger className="font-mono text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_PROC}>
              {assignedProc ? `Use campaign default (${assignedProc})` : "Use campaign default"}
            </SelectItem>
            {procs.map((p) => (
              <SelectItem key={String(p.PROC_INDEX)} value={p.PROC_NAME}>
                {p.PROC_NAME}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        <Label className="mb-1.5 block text-xs text-muted-foreground">Will run</Label>
        {effectiveProc ? (
          <code className="block rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
            CALL {effectiveProc}({campaignId})
          </code>
        ) : (
          <p className="text-sm text-amber-300">
            No procedure assigned to this campaign and none selected. Assign one in Settings or pick
            an override.
          </p>
        )}
      </div>

      <Button className="mt-4" onClick={handleRun} disabled={running || !effectiveProc}>
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Database className="mr-2 h-4 w-4" />
        )}
        {done ? "Run again" : "Run update HLL"}
      </Button>
    </Card>
  )
}

// The file upload + column-mapping flow (select → preview → create → map →
// load), extracted so it can be reused both in the manual FileSourcePanel and
// embedded directly in the campaign Settings (Step 1 · Upload file to a table).
/**
 * Read one field off a campaign's saved automation config, for prefilling the
 * Manual page.
 *
 * There are two config tables. Settings writes the MULTI-config table
 * (/api/campaign-configs — a campaign can have several named automations); the
 * legacy single-config table (/api/campaign-config/:id) predates it and is only
 * still populated for campaigns set up before the change. Reading only the
 * legacy one — which every prefill here used to do — means anything configured
 * through the current Settings screen looks unset, and the Manual page asks
 * again for a value that is already saved.
 *
 * Multi-config wins. Among several, an active config with the field set is
 * preferred over an inactive one, since that is the automation that actually
 * runs. Returns null rather than throwing: a prefill that fails must leave the
 * field blank and editable, not break the page.
 */
async function prefillFromConfig(campaignId: string, field: string): Promise<string | null> {
  const pick = (rows: Record<string, unknown>[]): string | null => {
    const withValue = rows.filter((r) => {
      const v = r[field]
      return typeof v === "string" && v.trim() !== ""
    })
    if (withValue.length === 0) return null
    const active = withValue.find((r) => r.IS_ACTIVE !== false)
    return String((active ?? withValue[0])[field]).trim()
  }
  try {
    const res = await fetch(`/api/campaign-configs?campaignId=${encodeURIComponent(campaignId)}`, {
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json()
      const hit = pick((data?.configs as Record<string, unknown>[]) ?? [])
      if (hit) return hit
    }
  } catch {
    // fall through to the legacy table
  }
  try {
    const res = await fetch(`/api/campaign-config/${encodeURIComponent(campaignId)}`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    const v = data?.config?.[field]
    return typeof v === "string" && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

function FileUploadMapper({
  campaignId,
  targetTable: controlledTable,
  onTargetTableChange,
}: {
  campaignId: string
  // When provided, the target stage table is controlled by the parent (e.g. the
  // Settings staging-table field), so both stay in sync and the internal
  // config-prefill is skipped. When omitted, the component manages it itself.
  targetTable?: string
  onTargetTableChange?: (value: string) => void
}) {
  const controlled = controlledTable !== undefined
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<"select" | "preview" | "create" | "map">("select")

  // Preview state
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Mapping state
  const [internalTable, setInternalTable] = useState("")
  const targetTable = controlled ? (controlledTable as string) : internalTable
  const setTargetTable = (value: string) => {
    if (controlled) onTargetTableChange?.(value)
    else setInternalTable(value)
  }
  const [targetColumns, setTargetColumns] = useState<TargetColumn[] | null>(null)
  const [targetLoading, setTargetLoading] = useState(false)
  const [targetError, setTargetError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [targetFromConfig, setTargetFromConfig] = useState(false)
  // Only true after a read of the target table failed, so the create flow is an
  // explicit second choice rather than the default route.
  const [canOfferCreate, setCanOfferCreate] = useState(false)

  // Create-table state
  const [createSpec, setCreateSpec] = useState<CreateColSpec[]>([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Load state (full parsed rows kept client-side; batched to /api/upload/load)
  const [allRows, setAllRows] = useState<string[][]>([])
  const [loadOpen, setLoadOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadedRows, setLoadedRows] = useState(0)
  const [loadDone, setLoadDone] = useState(false)

  // Pre-fill the target stage table from this campaign's saved automation
  // config (Settings → Campaign → UPLOAD_TARGET_TABLE). Best-effort: if the
  // config table or value is missing, the field stays blank and editable.
  useEffect(() => {
    if (controlled) return // parent supplies the table; no internal prefill
    if (!campaignId) return
    let cancelled = false
    const load = async () => {
      const configured = await prefillFromConfig(campaignId, "UPLOAD_TARGET_TABLE")
      if (cancelled || !configured) return
      setInternalTable(configured)
      setTargetFromConfig(true)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [campaignId, controlled])

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
      const { preview: built, allRows: rows } = await buildFilePreview(file)
      setPreview(built)
      setAllRows(rows)
      setLoadDone(false)
      setLoadedRows(0)
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
      const data = await parseJsonResponse(res)
      if (res.status === 404) {
        // The table could not be read. Prepare a create spec but do NOT jump
        // into the create flow: in the normal case the table already exists and
        // this is a name mistake or a missing grant, so creating it is the wrong
        // answer and offering it as the only path invites someone to take it.
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
        setTargetError(
          data.error ||
            `Could not read ${targetTable.trim()}. Check the name, and that this app's Snowflake role has access to it.`
        )
        setCanOfferCreate(true)
        return
      }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      const cols = data.columns as TargetColumn[]
      setTargetColumns(cols)
      const initial: Record<string, string> = {}
      for (const h of preview.headers) initial[h] = autoMatchColumn(h, cols)
      setMapping(initial)
      setCanOfferCreate(false)
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
      const data = await parseJsonResponse(res)
      if (!res.ok) throw new Error(data.error || `Create failed (${res.status})`)
      toast.success(`Created ${data.table} with ${data.columns} columns`)

      // Now fetch the columns and proceed to mapping.
      const colsRes = await fetch("/api/snowflake/table-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: targetTable.trim() }),
      })
      const colsData = await parseJsonResponse(colsRes)
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

  // Load the mapped rows into the target table: TRUNCATE on the first batch,
  // then INSERT in chunks of 1000 (kept under Vercel's request body limit).
  const handleLoad = async () => {
    if (!preview || allRows.length === 0 || !targetTable.trim()) return

    const mapped = preview.headers
      .map((h, i) => ({ index: i, target: mapping[h] }))
      .filter((m): m is { index: number; target: string } => !!m.target && m.target !== SKIP_VALUE)
    if (mapped.length === 0) {
      toast.error("Map at least one column before loading")
      return
    }
    const columns = mapped.map((m) => m.target)
    const sourceIdx = mapped.map((m) => m.index)
    const hasCampaignCol = (targetColumns ?? []).some((c) => c.COLUMN_NAME === "CAMPAIGNID")
    const injectCampaignId = hasCampaignCol && !columns.includes("CAMPAIGNID")

    setLoading(true)
    setLoadedRows(0)
    setLoadDone(false)
    const BATCH = 1000
    try {
      let loaded = 0
      for (let i = 0; i < allRows.length; i += BATCH) {
        const slice = allRows.slice(i, i + BATCH)
        const rowsPayload = slice.map((row) =>
          sourceIdx.map((idx) => {
            const v = row[idx]
            return v === "" || v === undefined ? null : v
          })
        )
        const res = await fetch("/api/upload/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: targetTable.trim(),
            columns,
            rows: rowsPayload,
            campaignId,
            injectCampaignId,
            truncate: i === 0,
          }),
        })
        const data = await parseJsonResponse(res)
        if (!res.ok) {
          throw new Error(
            `${data.error || `Load failed (${res.status})`} — ${loaded} of ${allRows.length} rows loaded before the failure.`
          )
        }
        loaded += slice.length
        setLoadedRows(loaded)
      }
      setLoadDone(true)
      setLoadOpen(false)
      toast.success(`Loaded ${loaded} row${loaded === 1 ? "" : "s"} into ${targetTable.trim()}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setPreview(null)
    setTargetColumns(null)
    setMapping({})
    setAllRows([])
    setLoadDone(false)
    setLoadedRows(0)
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
            onChange={(e) => {
              setTargetTable(e.target.value)
              setTargetFromConfig(false)
              setCanOfferCreate(false)
              setTargetError(null)
            }}
            placeholder="e.g. DATAWAREHOUSE.SCHEMA.TABLE"
            className="w-full max-w-xl rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          {targetFromConfig && !targetError && (
            <p className="mt-2 text-xs text-emerald-300/80">
              From this campaign&apos;s saved automation — edit only to override it for this
              upload.
            </p>
          )}
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
          {canOfferCreate && (
            <Button variant="outline" onClick={() => setStage("create")}>
              Create it instead
            </Button>
          )}
        </div>
        {canOfferCreate && (
          <p className="text-xs text-muted-foreground">
            The load truncates and refills an existing table, so it does not need creating unless
            this really is a new one.
          </p>
        )}
      </div>
    )
  }

  // ---- STAGE: create stage table (when target table doesn't exist)
  if (stage === "create") {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="warning">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              <span className="font-mono">{targetTable}</span> doesn't exist. Define columns and
              create it. A <span className="font-mono">CREATED_AT TIMESTAMP_NTZ</span> audit column
              is added automatically.
            </span>
          </div>
        </Banner>

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
          <Banner tone="error">
            {createError}
          </Banner>
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
        <Button variant="ghost" onClick={() => setStage("preview")} disabled={loading}>
          Back
        </Button>
        <Button
          onClick={() => setLoadOpen(true)}
          disabled={loading || loadDone || mappedTargets.size === 0 || unmappedRequired.length > 0}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Database className="mr-2 h-4 w-4" />
          )}
          {loadDone
            ? `Loaded ${loadedRows} rows`
            : loading
            ? `Loading… ${loadedRows}/${preview.rowCount}`
            : `Load ${preview.rowCount} rows to Snowflake`}
        </Button>
      </div>

      <AlertDialog open={loadOpen} onOpenChange={(open) => !loading && setLoadOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Truncate &amp; load {preview.rowCount} rows?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This will run against Snowflake:</p>
                <ol className="ml-5 list-decimal space-y-1">
                  <li>
                    <span className="font-mono">TRUNCATE TABLE {targetTable.trim()}</span>
                  </li>
                  <li>
                    <span className="font-mono">INSERT</span> the {preview.rowCount} mapped rows in
                    batches of 1000.
                  </li>
                </ol>
                <p className="pt-1">
                  The truncate is destructive and cannot be undone. If a batch fails midway, the
                  table is left truncated and partially loaded.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleLoad} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Truncate &amp; load
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Run one configured step from the Manual page.
 *
 * Deliberately the same submit-and-poll path as the Settings step list, so a
 * step behaves identically wherever it is triggered from — including reporting
 * the statement it submitted when it fails.
 */
function ManualStepRunner({
  configId,
  stepKey,
  label,
}: {
  configId: number
  stepKey: string
  label: string
}) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const run = async () => {
    setRunning(true)
    setResult(null)
    const res = await runOneStepAt(`/api/distribution/configs/${configId}/run`, stepKey)
    setResult({
      ok: res.ok,
      message: res.ok ? res.result || "Done — the statement returned nothing." : res.error || "Step failed",
    })
    setRunning(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">{label}</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Runs against the campaign&apos;s <span className="font-medium text-foreground">saved</span>{" "}
          config — the same statement the automation would run for this step.
        </p>
      </div>
      <div>
        <Button onClick={run} disabled={running}>
          {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
          {running ? "Running..." : "Run this step"}
        </Button>
      </div>
      {result && (
        <Banner tone={result.ok ? "success" : "error"} className="whitespace-pre-wrap">
          {result.message}
        </Banner>
      )}
    </div>
  )
}

type GroupRunState = "pending" | "running" | "ok" | "error" | "skipped"

/**
 * All of a campaign's update-HLL procedures, in one tab, run in order.
 *
 * The plan emits one step per configured procedure, which the automation runs
 * in sequence. Giving each its own tab made a single stage look like four
 * stages, numbered as if they were independent, and left the order — which is
 * the whole point, since one procedure's output is the next one's input —
 * expressed nowhere on screen.
 *
 * So: one tab, the procedures listed in the order they run, and one button.
 * Sequential and strictly awaited, never Promise.all: they share the same rows
 * and running them together would race.
 *
 * IT STOPS AT THE FIRST FAILURE. Later procedures assume the earlier ones have
 * been applied — SP_VCD_VCCVM_POST_LOAD sets ESTATUS and the scores that the
 * ranking then reads — so carrying on past an error would rank a batch that was
 * never cleaned and report success for it. What did not run is marked skipped
 * rather than left blank, so the screen distinguishes "not reached" from
 * "not attempted".
 *
 * The per-row Run stays, because retrying one procedure after fixing it beats
 * re-running all four.
 */
function UpdateHllGroupRunner({
  configId,
  steps,
}: {
  configId: number
  steps: { key: string; label: string }[]
}) {
  const [state, setState] = useState<Record<string, GroupRunState>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [runningAll, setRunningAll] = useState(false)

  const runOne = async (key: string): Promise<boolean> => {
    setState((s) => ({ ...s, [key]: "running" }))
    setMessages((m) => ({ ...m, [key]: "" }))
    const res = await runOneStepAt(`/api/distribution/configs/${configId}/run`, key)
    setState((s) => ({ ...s, [key]: res.ok ? "ok" : "error" }))
    setMessages((m) => ({
      ...m,
      // The procedure's own words when it has any. A procedure that succeeds
      // while changing nothing reads identically to one that worked, unless it
      // gets to say so.
      [key]: res.ok ? res.result || "Done — the statement returned nothing." : res.error || "Step failed",
    }))
    return res.ok
  }

  const runAll = async () => {
    setRunningAll(true)
    setState(Object.fromEntries(steps.map((s) => [s.key, "pending" as GroupRunState])))
    setMessages({})
    for (let i = 0; i < steps.length; i++) {
      const ok = await runOne(steps[i].key)
      if (!ok) {
        // Everything after a failure is unattempted, and says so.
        const rest = steps.slice(i + 1)
        setState((s) => ({
          ...s,
          ...Object.fromEntries(rest.map((r) => [r.key, "skipped" as GroupRunState])),
        }))
        setMessages((m) => ({
          ...m,
          ...Object.fromEntries(
            rest.map((r) => [r.key, "Not run — an earlier procedure failed."])
          ),
        }))
        break
      }
    }
    setRunningAll(false)
  }

  const anyRunning = runningAll || Object.values(state).some((v) => v === "running")

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          Update HLL — {steps.length} procedure{steps.length === 1 ? "" : "s"}
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Run in the order below, one at a time, against the campaign&apos;s{" "}
          <span className="font-medium text-foreground">saved</span> config — the same order and the
          same statements the automation uses. Stops at the first failure, because each one assumes
          the ones before it have been applied.
        </p>
      </div>

      <div>
        <Button onClick={runAll} disabled={anyRunning}>
          {anyRunning ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="mr-2 h-4 w-4" />
          )}
          {runningAll ? "Running..." : `Run all ${steps.length} in order`}
        </Button>
      </div>

      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const st = state[s.key]
          const msg = messages[s.key]
          return (
            <li key={s.key} className="rounded-md border border-border bg-background/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  {st === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
                  {st === "ok" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                  {st === "error" && <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
                  <span className="truncate text-sm text-foreground">
                    {s.label.replace(/^Update HLL — /, "")}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={anyRunning}
                  onClick={() => runOne(s.key)}
                >
                  Run
                </Button>
              </div>
              {msg && (
                <p
                  className={cn(
                    "mt-2 whitespace-pre-wrap text-xs",
                    st === "ok"
                      ? "text-emerald-300"
                      : st === "error"
                        ? "text-rose-300"
                        : "text-muted-foreground"
                  )}
                >
                  {msg}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The manual file pipeline.
 *
 * The tabs after the upload come from the campaign's SAVED CONFIG, via the same
 * plan endpoint the automation runs — not from a fixed list. They used to be
 * hard-coded as upload / load-into-history / verify / update-HLL, which is the
 * older path and no longer what Settings describes: Settings' step 2 is "Load
 * into HLL" (a view mapping or a procedure), it can carry several update-HLL
 * procedures and a sync, and it has no notion of "load into history" unless one
 * is configured. So the two screens named the same pipeline differently and
 * listed different steps.
 *
 * Where a planned step has a purpose-built panel it keeps it; the rest get a
 * generic runner, which is the same submit-and-poll the Settings step list uses.
 * "Checks" is separated out because verifying counts is not a pipeline step —
 * it runs nothing and can be done at any point.
 */
function FileSourcePanel({
  campaignId,
  configId,
  parentStep,
}: {
  campaignId: string
  // Needed to read the plan and to run an individual step. Null before a config
  // is selected, in which case only the upload and the checks are offered.
  configId: number | null
  // The outer step this panel sits inside. Its tabs are numbered under it —
  // "3.1", "3.2" — because bare 1-4 read as a continuation of the outer
  // sequence, which then appears to jump straight from 4 to the next card.
  parentStep: number
}) {
  const [section, setSection] = useState<string>("upload")
  const [historyProc, setHistoryProc] = useState("")
  const [plan, setPlan] = useState<{ key: string; label: string }[]>([])
  const [planError, setPlanError] = useState<string | null>(null)

  // The configured steps, in the order they run.
  useEffect(() => {
    if (configId == null) { setPlan([]); setPlanError(null); return }
    let cancelled = false
    fetch(`/api/distribution/configs/${configId}/run/plan`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d?.error) { setPlan([]); setPlanError(String(d.error)); return }
        setPlan((d.steps as { key: string; label: string }[]) ?? [])
        setPlanError(null)
      })
      .catch(() => {
        if (!cancelled) setPlanError("Could not read this campaign's configured steps.")
      })
    return () => { cancelled = true }
  }, [configId])

  // Best-effort prefill of the load-history procedure from saved config.
  useEffect(() => {
    if (!campaignId) return
    let cancelled = false
    const load = async () => {
      const proc = await prefillFromConfig(campaignId, "LOAD_HISTORY_PROCEDURE")
      if (!cancelled && proc) setHistoryProc(proc)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [campaignId])

  // The update-HLL procedures are ONE stage, however many are configured.
  // The plan emits a step each because the automation runs them individually,
  // but on screen four procedures became 3.4, 3.5, 3.6, 3.7 — four numbered
  // stages for one, with the order that matters shown nowhere. They collapse
  // into a single tab that runs them in sequence.
  const updateHllSteps = plan.filter((st) => st.key.startsWith("update_hll"))
  const grouped: { key: string; label: string }[] = []
  let groupInserted = false
  for (const st of plan) {
    if (st.key.startsWith("update_hll")) {
      if (groupInserted) continue
      groupInserted = true
      grouped.push({
        key: "__update_hll_group__",
        label:
          updateHllSteps.length > 1
            ? `Update HLL — ${updateHllSteps.length} procedures`
            : "Update HLL",
      })
      continue
    }
    grouped.push(st)
  }

  // Upload first, then one tab per configured step, then the checks. Labels come
  // straight from the plan, so they read the same here as in Settings.
  const steps: { id: string; label: string }[] = [
    { id: "upload", label: `${parentStep}.1 · Upload to stage` },
    ...grouped.map((st, i) => ({
      id: `step:${st.key}`,
      // The plan prefixes file-source labels with "Load into HLL — "; that is
      // useful in a flat step list and redundant in a tab.
      label: `${parentStep}.${i + 2} · ${st.label.replace(/^Load into HLL — /, "")}`,
    })),
    { id: "verify", label: "Checks · Verify counts" },
    // Not steps: they act on whatever is already distributed, run as often as
    // you like, and are not part of the configured sequence — so they sit with
    // the other tools rather than taking a number of their own.
    { id: "adhoc-update", label: "Tools · Run an update-HLL procedure" },
    { id: "extract", label: "Tools · Extract data" },
    { id: "email", label: "Tools · Email data" },
  ]

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {steps.map((s) => (
          <Button
            key={s.id}
            type="button"
            variant={section === s.id ? "default" : "outline"}
            size="sm"
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Independent of each other — if the stage table is already loaded, skip straight to a later
        step. These are this campaign&apos;s configured steps, the same ones{" "}
        <span className="font-medium text-foreground">Settings</span> lists and the automation runs.
      </p>

      {planError && (
        <Banner tone="warning">
          {planError} Only the upload and the checks are available until that is fixed.
        </Banner>
      )}

      {section === "upload" && <FileUploadMapper campaignId={campaignId} />}
      {section === "verify" && (
        <VerifyCountsSection campaignId={campaignId} configId={configId} />
      )}
      {section === "adhoc-update" && <UpdateHllSection campaignId={campaignId} configId={configId} />}
      {section === "extract" && <ExportDownloadStep campaignId={campaignId} />}
      {section === "email" && <EmailExportStep campaignId={campaignId} />}

      {/* Keep the purpose-built panels for the steps that have one. */}
      {section === "step:load_history" && (
        <LoadHistorySection campaignId={campaignId} proc={historyProc} configId={configId} />
      )}

      {/* The update-HLL procedures, as one stage run in order. */}
      {section === "step:__update_hll_group__" && configId != null && (
        <UpdateHllGroupRunner configId={configId} steps={updateHllSteps} />
      )}

      {/* Everything else runs through the same submit-and-poll as Settings.
          Each of the grouped update-HLL steps still runs through it too, from
          inside the group above — the picker panel under Tools cannot stand in
          for them, because it would run whatever is selected in it rather than
          the procedure the config names for that position. */}
      {section.startsWith("step:") &&
        section !== "step:load_history" &&
        section !== "step:__update_hll_group__" &&
        configId != null && (
          <ManualStepRunner
            configId={configId}
            stepKey={section.slice("step:".length)}
            label={
              plan.find((st) => `step:${st.key}` === section)?.label ?? section.slice(5)
            }
          />
        )}
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
            <Banner tone="error" className="mt-3">
              {error}
            </Banner>
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
            <Banner tone="error">
              {error}
            </Banner>
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
                    <SkeletonRows cols={5} rows={3} />
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
                <Banner tone="error" className="mt-3 p-2">
                  {previewError}
                </Banner>
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

// Runs one saved automation config (Step 1 source → load history → update HLL
// → sync) via the config orchestrator. The config is edited in Settings.
function SnowflakeSourcePanel({ configId, configName, campaignId }: { configId: number; configName: string; campaignId: string }) {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<StepView[]>([])
  const [history, setHistory] = useState<RunHistoryRow[]>([])
  const [plan, setPlan] = useState<{ key: string; label: string }[]>([])
  const [stepState, setStepState] = useState<Record<string, { status: StepView["status"]; message?: string }>>({})
  const [syncBg, setSyncBg] = useState<{ status: string; at?: string | null; finishedAt?: string | null; error?: string } | null>(null)

  const loadHistory = useCallback(async () => {
    if (!campaignId) { setHistory([]); return }
    try {
      const res = await fetch(`/api/distribution/campaigns/${campaignId}/history`, { cache: "no-store" })
      const data = await res.json()
      setHistory(Array.isArray(data.rows) ? (data.rows as RunHistoryRow[]) : [])
    } catch { setHistory([]) }
  }, [campaignId])

  const checkSync = useCallback(async () => {
    try {
      const res = await fetch(`/api/distribution/configs/${configId}/sync`, { cache: "no-store" })
      const d = await res.json()
      setSyncBg(d && d.status ? d : null)
    } catch { setSyncBg(null) }
  }, [configId])

  useEffect(() => { loadHistory() }, [loadHistory])
  useEffect(() => { checkSync() }, [checkSync])

  // Load the config's step plan for the per-step Run buttons.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/distribution/configs/${configId}/run/plan`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPlan(Array.isArray(d.steps) ? d.steps : []) })
      .catch(() => { if (!cancelled) setPlan([]) })
    return () => { cancelled = true }
  }, [configId])

  const run = async () => {
    setRunning(true)
    setSteps([])
    try {
      const res = await runConfigStepwise(configId, setSteps)
      if (res.ok) toast.success(`Distribution complete — ${res.ran} step(s) ran`)
      else toast.error("Distribution failed — see steps below")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      loadHistory()
      checkSync()
    }
  }

  // Run a single step (sync is fire-and-forget). Each run is logged to history.
  const runOne = async (key: string) => {
    const label = plan.find((p) => p.key === key)?.label ?? key
    setStepState((s) => ({ ...s, [key]: { status: "running" } }))
    try {
      if (key === "sync") {
        const r = await submitSyncFireAndForget(configId)
        setStepState((s) => ({ ...s, [key]: { status: r.ok ? "success" : "error", message: r.ok ? "submitted — running in the background (safe to leave this page)" : r.error } }))
        await recordStepRun(configId, label, r.ok, r.ok ? "submitted (background)" : r.error)
        if (r.ok) toast.success("Sync submitted — running in the background")
        else toast.error(r.error || "Failed to submit sync")
        return
      }
      const res = await runOneStepAt(`/api/distribution/configs/${configId}/run`, key)
      setStepState((s) => ({ ...s, [key]: { status: res.ok ? "success" : "error", message: res.error } }))
      await recordStepRun(configId, label, res.ok, res.error)
      if (res.ok) toast.success("Step complete")
      else toast.error(res.error || "Step failed")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStepState((s) => ({ ...s, [key]: { status: "error", message: msg } }))
      await recordStepRun(configId, label, false, msg)
      toast.error(msg)
    } finally {
      loadHistory()
      checkSync()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Runs the <span className="font-medium text-foreground">{configName}</span> automation in order — Initial
        source → Load into history → Update HLL → Sync — stopping at the first failure. The <span className="font-medium text-foreground">Sync</span> step
        is fire-and-forget (keeps running if you leave). Edit the config in <span className="font-medium text-foreground">Settings → Campaign automation</span>.
      </div>

      {/* Live status of the fire-and-forget sync. */}
      {syncBg && syncBg.status !== "none" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
          {syncBg.status === "running" ? <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            : syncBg.status === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            : <XCircle className="h-4 w-4 text-rose-400" />}
          <span className="text-muted-foreground">Sync:</span>
          <span className={
            syncBg.status === "done" ? "font-medium text-emerald-400"
            : syncBg.status === "error" ? "font-medium text-rose-400"
            : "font-medium text-sky-400"
          }>
            {syncBg.status === "running" ? "still running…" : syncBg.status}
          </span>
          {syncBg.at && <span className="text-xs text-muted-foreground">· started {syncBg.at}</span>}
          {syncBg.finishedAt && <span className="text-xs text-muted-foreground">· finished {syncBg.finishedAt}</span>}
          {syncBg.status === "error" && syncBg.error && <span className="text-xs text-rose-400">· {syncBg.error}</span>}
          <Button type="button" variant="ghost" size="sm" onClick={checkSync}>Refresh</Button>
        </div>
      )}

      <Button onClick={run} disabled={running} className="w-full">
        {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
        {running ? "Running…" : "Run full distribution"}
      </Button>

      {/* Run each step individually. */}
      {plan.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Run individual steps</div>
          <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
            {plan.map((s) => {
              const st = stepState[s.key]
              return (
                <li key={s.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="flex items-center gap-2">
                    {st ? <StepStatusIcon status={st.status} /> : <span className="h-4 w-4" />}
                    <span className="text-foreground">{s.label}</span>
                    {st?.status === "error" && st.message && <span className="whitespace-pre-wrap text-rose-400">— {st.message}</span>}
                  </span>
                  <Button type="button" variant="ghost" size="sm" disabled={running || st?.status === "running"} onClick={() => runOne(s.key)}>
                    {st?.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Run"}
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {steps.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {steps.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <StepStatusIcon status={r.status} />
              <span className="font-medium text-foreground">{r.step}:</span>
              <span className="whitespace-pre-wrap text-muted-foreground">{r.status === "running" ? "running…" : r.message}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Previous runs for this campaign (all its configs). */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Previous runs</div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs recorded yet.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Automation</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Steps</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                  <th className="px-3 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.ID} className="border-t border-border/50 align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{h.CREATED_AT ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-foreground">{h.CONFIG_NAME ?? "—"}</td>
                    <td className="px-3 py-1.5">
                      <span className={h.STATUS === "Success" ? "font-medium text-emerald-400" : "font-medium text-rose-400"}>{h.STATUS ?? "—"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{h.RAN ?? 0}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{h.SUMMARY ?? ""}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{h.CREATED_BY ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The server's row type, not a copy of it. The previous hand-copied version
 * drifted: it lacked SCHEDULE_FREQUENCY / SCHEDULE_DOW / SCHEDULE_TIME, which the
 * API selects and this component reads, and only `ignoreBuildErrors` hid the
 * nine resulting type errors. A type-only import is erased at compile time, so
 * nothing server-side reaches the client bundle (lib/distribution-steps.ts
 * already imports from this route file the same way).
 */
type AutomationTask = TaskRow
type ConfiguredCampaign = { id: string; title: string }
type ColInfo = { name: string; type: string }
const SOURCE_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "— No lead source —" },
  { value: "proc", label: "Stored procedure → table" },
  { value: "view", label: "View (read directly)" },
]
const TASK_TYPES = ["CRM", "Dialling", "Custom"]
const TASK_STATUSES = ["Draft", "Active", "Paused", "Completed"]
const PROC_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "— No procedure —" },
  { value: "load_history", label: "Load into history" },
  { value: "update_hll", label: "Update HLL" },
  { value: "sync", label: "Sync leads" },
  { value: "full", label: "Full run (all configured)" },
]
const procKindLabel = (k: string | null) => PROC_KIND_OPTIONS.find((o) => o.value === (k ?? "none"))?.label ?? "—"
type TaskForm = { name: string; type: string; status: string; target: string; schedule: string; scheduleFrequency: string; scheduleDow: string; scheduleTime: string; description: string; campaignId: string; campaignTitle: string; procKind: string; sourceKind: string; sourceObject: string; sourceTable: string; mapping: Record<string, string>; standaloneProc: string }
const EMPTY_FORM: TaskForm = { name: "", type: "Custom", status: "Draft", target: "", schedule: "", scheduleFrequency: "manual", scheduleDow: "Mon", scheduleTime: "08:00", description: "", campaignId: "", campaignTitle: "", procKind: "none", sourceKind: "none", sourceObject: "", sourceTable: "", mapping: {}, standaloneProc: "" }
const FREQUENCY_OPTIONS = [
  { value: "manual", label: "Manual (Run now only)" },
  { value: "hourly", label: "Hourly (~every hour)" },
  { value: "daily", label: "Daily (at a time)" },
  { value: "weekly", label: "Weekly (day + time)" },
]
const DOW_OPTIONS = [
  { value: "Mon", label: "Monday" }, { value: "Tue", label: "Tuesday" }, { value: "Wed", label: "Wednesday" },
  { value: "Thu", label: "Thursday" }, { value: "Fri", label: "Friday" }, { value: "Sat", label: "Saturday" }, { value: "Sun", label: "Sunday" },
]

function taskStatusClass(s: string): string {
  switch (s) {
    case "Active": return "border-emerald-500/30 bg-emerald-500/12 text-emerald-300"
    case "Paused": return "border-amber-500/30 bg-amber-500/12 text-amber-300"
    case "Completed": return "border-sky-500/30 bg-sky-500/12 text-sky-300"
    default: return "border-border bg-muted text-muted-foreground"
  }
}

function AutomationContent() {
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<null | "new" | AutomationTask>(null)
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTask, setDeleteTask] = useState<AutomationTask | null>(null)
  const [campaigns, setCampaigns] = useState<ConfiguredCampaign[]>([])
  const [runningId, setRunningId] = useState<string | number | null>(null)
  const [hllCols, setHllCols] = useState<ColInfo[]>([])
  const [srcCols, setSrcCols] = useState<ColInfo[]>([])
  const [colsLoading, setColsLoading] = useState(false)
  const [colsMsg, setColsMsg] = useState<string | null>(null)

  // Load HLL + source columns for the mapping UI, auto-matching by name.
  const loadColumns = async () => {
    const readFrom = form.sourceKind === "proc" ? form.sourceTable.trim() : form.sourceObject.trim()
    if (!readFrom) { setColsMsg(form.sourceKind === "proc" ? "Enter the proc's output table or view first." : "Enter the view name first."); return }
    setColsLoading(true); setColsMsg(null)
    try {
      const [hllRes, srcRes] = await Promise.all([
        fetch("/api/distribution/columns?object=hll").then((r) => r.json()),
        fetch(`/api/distribution/columns?object=${encodeURIComponent(readFrom)}`).then((r) => r.json()),
      ])
      if (hllRes.error) throw new Error(`HLL: ${hllRes.error}`)
      if (srcRes.error) throw new Error(`Source: ${srcRes.error}`)
      const hll: ColInfo[] = hllRes.columns ?? []
      const src: ColInfo[] = srcRes.columns ?? []
      if (!src.length) throw new Error("No columns found on the source (check the name / grants).")
      setHllCols(hll); setSrcCols(src)
      // Auto-match by identical column name (case-insensitive), keeping any existing mapping.
      setForm((f) => {
        const m = { ...f.mapping }
        for (const h of hll) {
          if (m[h.name]) continue
          const hit = src.find((s) => s.name.toLowerCase() === h.name.toLowerCase())
          if (hit) m[h.name] = hit.name
        }
        return { ...f, mapping: m }
      })
    } catch (e) {
      setColsMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setColsLoading(false)
    }
  }
  const setMap = (hllCol: string, srcCol: string) =>
    setForm((f) => {
      const m = { ...f.mapping }
      if (srcCol === "__none__") delete m[hllCol]
      else m[hllCol] = srcCol
      return { ...f, mapping: m }
    })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/distribution/tasks")
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Failed to load (${r.status})`)
      setTasks(d.rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  // Campaigns that have automation config (with procedures) — for the picker.
  useEffect(() => {
    fetch("/api/campaign-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const rows: Record<string, unknown>[] = d?.rows ?? []
        setCampaigns(rows.map((r) => ({ id: String(r.CAMPAIGNID), title: String(r.CAMPAIGN_TITLE ?? `Campaign ${r.CAMPAIGNID}`) })))
      })
      .catch(() => {})
  }, [])

  const runNow = async (t: AutomationTask) => {
    setRunningId(t.ID)
    try {
      const r = await fetch(`/api/distribution/tasks/${t.ID}/run`, { method: "POST" })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Run failed (${r.status})`)
      toast.success(d.message || "Procedure(s) ran successfully")
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      load()
    } finally {
      setRunningId(null)
    }
  }

  const openNew = (type = "Custom") => { setForm({ ...EMPTY_FORM, type }); setEditing("new") }
  const openEdit = (t: AutomationTask) => {
    let mapping: Record<string, string> = {}
    try { mapping = t.MAPPING_JSON ? JSON.parse(t.MAPPING_JSON) : {} } catch { mapping = {} }
    setForm({ name: t.NAME, type: t.TASK_TYPE, status: t.STATUS, target: t.TARGET ?? "", schedule: t.SCHEDULE ?? "", scheduleFrequency: t.SCHEDULE_FREQUENCY ?? "manual", scheduleDow: t.SCHEDULE_DOW ?? "Mon", scheduleTime: t.SCHEDULE_TIME ?? "08:00", description: t.DESCRIPTION ?? "", campaignId: t.CAMPAIGN_ID ?? "", campaignTitle: t.CAMPAIGN_TITLE ?? "", procKind: t.PROC_KIND ?? "none", sourceKind: t.SOURCE_KIND ?? "none", sourceObject: t.SOURCE_OBJECT ?? "", sourceTable: t.SOURCE_TABLE ?? "", mapping, standaloneProc: t.STANDALONE_PROC ?? "" })
    setHllCols([]); setSrcCols([]); setColsMsg(null)
    setEditing(t)
  }
  const setF = (k: keyof TaskForm, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.name.trim()) { toast.error("Task name is required"); return }
    setSaving(true)
    try {
      const isEdit = editing && editing !== "new"
      const url = isEdit ? `/api/distribution/tasks/${(editing as AutomationTask).ID}` : "/api/distribution/tasks"
      const r = await fetch(url, { method: isEdit ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`)
      toast.success(isEdit ? "Task updated" : "Task created")
      setEditing(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTask) return
    try {
      const r = await fetch(`/api/distribution/tasks/${deleteTask.ID}`, { method: "DELETE" })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`)
      toast.success("Task deleted")
      setDeleteTask(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageHeading>Automated Lead Distribution</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Create, track and edit distribution automation tasks. Stored in Snowflake.
          </p>
        </div>
        <Button size="sm" onClick={() => openNew()}><Plus className="mr-2 h-4 w-4" /> New task</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div>
              <SectionHeading>CRM Integration</SectionHeading>
              <p className="mt-1 text-sm text-muted-foreground">Connect to your CRM to automatically distribute leads in real-time.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => openNew("CRM")}>Configure CRM</Button>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Truck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <SectionHeading>Dialling System Integration</SectionHeading>
              <p className="mt-1 text-sm text-muted-foreground">Route leads to dialling systems for immediate agent engagement.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => openNew("Dialling")}>Configure Dialling</Button>
            </div>
          </div>
        </Card>
      </div>

      {editing !== null && (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-foreground">{editing === "new" ? "New automation task" : "Edit task"}</h3>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label htmlFor="task-name">Name</Label>
              <Input id="task-name" className="mt-1" value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Push new leads to dialler" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setF("type", v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{TASK_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setF("status", v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-target">Target</Label>
              <Input id="task-target" className="mt-1" value={form.target} onChange={(e) => setF("target", e.target.value)} placeholder="CRM / dialler / campaign" />
            </div>
            <div>
              <Label>Frequency</Label>
              <Select value={form.scheduleFrequency} onValueChange={(v) => setF("scheduleFrequency", v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{FREQUENCY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {form.scheduleFrequency === "manual"
                  ? "Runs only when you click Run now."
                  : "Runs automatically when the task is Active (checked every 15 min, times in SAST). Requires the scheduler to be enabled."}
              </p>
              {(form.scheduleFrequency === "daily" || form.scheduleFrequency === "weekly") && (
                <div className="mt-2 flex flex-wrap gap-3">
                  {form.scheduleFrequency === "weekly" && (
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground">Day</Label>
                      <Select value={form.scheduleDow} onValueChange={(v) => setF("scheduleDow", v)}>
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>{DOW_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                  <div>
                    <Label htmlFor="task-time" className="mb-1 block text-xs text-muted-foreground">Time (SAST)</Label>
                    <Input id="task-time" type="time" className="w-32" value={form.scheduleTime} onChange={(e) => setF("scheduleTime", e.target.value)} />
                  </div>
                </div>
              )}
            </div>
            <div>
              <Label>Campaign</Label>
              <Select
                value={form.campaignId || "none"}
                onValueChange={(v) => {
                  if (v === "none") setForm((f) => ({ ...f, campaignId: "", campaignTitle: "" }))
                  else setForm((f) => ({ ...f, campaignId: v, campaignTitle: campaigns.find((c) => c.id === v)?.title ?? "" }))
                }}
              >
                <SelectTrigger className="mt-1"><SelectValue placeholder="Link a campaign…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— No campaign —</SelectItem>
                  {campaigns.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Procedure to run</Label>
              <Select value={form.procKind} onValueChange={(v) => setF("procKind", v)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{PROC_KIND_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="task-standalone">Standalone procedure</Label>
              <Input
                id="task-standalone"
                className="mt-1 font-mono text-xs"
                value={form.standaloneProc}
                onChange={(e) => setF("standaloneProc", e.target.value)}
                placeholder="DATAWAREHOUSE.SCHEMA.SP_NAME(608)"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Optional. A fully-qualified procedure to run on its own (with optional args), independent of a campaign — e.g. a cleanup or maintenance proc. If set, <span className="font-medium text-foreground">Run now</span> calls it directly.
              </p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="task-desc">Description</Label>
              <Textarea id="task-desc" className="mt-1" value={form.description} onChange={(e) => setF("description", e.target.value)} placeholder="What this automation does…" rows={3} />
            </div>
          </div>
          {form.campaignId && form.procKind !== "none" && (
            <p className="mt-3 text-xs text-muted-foreground">
              This task runs the campaign&apos;s configured <span className="font-medium text-foreground">{procKindLabel(form.procKind)}</span> procedure(s).
              Save it, then use <span className="font-medium text-foreground">Run now</span> in the table below (or a scheduled trigger) to load leads.
            </p>
          )}

          {/* Lead source → HLL */}
          <div className="mt-5 rounded-lg border border-border/70 bg-background/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-foreground">Lead source → HLL</h4>
                <p className="text-xs text-muted-foreground">Run a proc (then read its table) or a view, and map the columns into <span className="font-mono">TM_HLL_HISTORYLEADSLOADED</span> (append).</p>
              </div>
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <Label>Source type</Label>
                <Select value={form.sourceKind} onValueChange={(v) => { setF("sourceKind", v); setHllCols([]); setSrcCols([]); setColsMsg(null) }}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{SOURCE_KIND_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {form.sourceKind !== "none" && (
                <div>
                  <Label htmlFor="src-obj">
                    {form.sourceKind === "proc"
                      ? "Stored procedure (DB.SCHEMA.NAME, with any arguments)"
                      : "View (DB.SCHEMA.NAME)"}
                  </Label>
                  <Input id="src-obj" className="mt-1 font-mono text-xs" value={form.sourceObject} onChange={(e) => setF("sourceObject", e.target.value)} placeholder={form.sourceKind === "proc" ? "DATAWAREHOUSE.SCHEMA.PROC(1)" : "DATAWAREHOUSE.SCHEMA.NAME"} />
                  {form.sourceKind === "proc" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Exactly as you would write the <span className="font-mono">CALL</span> — Snowflake matches on
                      name and argument count, so include the arguments.
                    </p>
                  )}
                </div>
              )}
              {form.sourceKind === "proc" && (
                <div>
                  <Label htmlFor="src-tbl">Output to read — table or view (DB.SCHEMA.NAME)</Label>
                  <Input id="src-tbl" className="mt-1 font-mono text-xs" value={form.sourceTable} onChange={(e) => setF("sourceTable", e.target.value)} placeholder="DATAWAREHOUSE.SCHEMA.NAME" />
                </div>
              )}
            </div>

            {form.sourceKind !== "none" && (
              <div className="mt-4">
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={loadColumns} disabled={colsLoading}>
                    {colsLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading columns…</> : <>Load columns &amp; map</>}
                  </Button>
                  {Object.keys(form.mapping).length > 0 && <span className="text-xs text-muted-foreground">{Object.keys(form.mapping).length} column(s) mapped</span>}
                </div>
                {colsMsg && <p className="mt-2 text-xs text-rose-400">{colsMsg}</p>}

                {hllCols.length > 0 && (
                  <div className="mt-3 max-h-72 overflow-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card">
                        <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">HLL column</th>
                          <th className="px-3 py-2 font-medium">Source column</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hllCols.map((h) => (
                          <tr key={h.name} className="border-t border-border/50">
                            <td className="px-3 py-1.5">
                              <span className="font-mono text-xs text-foreground">{h.name}</span>
                              <span className="ml-2 text-[10px] text-muted-foreground">{h.type}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <Select value={form.mapping[h.name] ?? "__none__"} onValueChange={(v) => setMap(h.name, v)}>
                                <SelectTrigger className="h-8 w-full"><SelectValue placeholder="— skip —" /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">— skip —</SelectItem>
                                  {srcCols.map((s) => <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {Object.keys(form.mapping).length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">On <span className="font-medium text-foreground">Run now</span>, the mapped columns are inserted into the HLL table (append).</p>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : editing === "new" ? "Create task" : "Save changes"}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Active Distributions</h3>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} /> Refresh</Button>
        </div>
        {error ? (
          <Banner tone="error"><span>{error}</span></Banner>
        ) : loading ? (
          <div className="py-2"><SkeletonText lines={5} /></div>
        ) : tasks.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No distribution tasks yet. Create your first one with “New task”.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={String(t.ID)}>
                    <TableCell className="font-medium text-foreground">
                      {t.NAME}
                      {t.DESCRIPTION && <div className="text-xs font-normal text-muted-foreground">{t.DESCRIPTION}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.TASK_TYPE}</TableCell>
                    <TableCell className="text-muted-foreground">{t.TARGET || "—"}</TableCell>
                    <TableCell><Badge variant="outline" className={taskStatusClass(t.STATUS)}>{t.STATUS}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.SCHEDULE_FREQUENCY === "hourly" ? "Hourly"
                        : t.SCHEDULE_FREQUENCY === "daily" ? `Daily ${t.SCHEDULE_TIME ?? ""}`.trim()
                        : t.SCHEDULE_FREQUENCY === "weekly" ? `Weekly ${t.SCHEDULE_DOW ?? ""} ${t.SCHEDULE_TIME ?? ""}`.trim()
                        : (t.SCHEDULE || "Manual")}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.LAST_RUN_AT ? (
                        <div className="flex flex-col gap-0.5" title={t.LAST_RUN_MESSAGE ?? undefined}>
                          <span className={t.LAST_RUN_STATUS === "Success" ? "font-medium text-emerald-400" : "font-medium text-rose-400"}>{t.LAST_RUN_STATUS ?? "—"}</span>
                          <span className="text-muted-foreground">{t.LAST_RUN_AT}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {(t.STANDALONE_PROC || (t.CAMPAIGN_ID && t.PROC_KIND && t.PROC_KIND !== "none") || t.SOURCE_KIND === "proc" || t.SOURCE_KIND === "view") && (
                          <Button
                            variant="ghost" size="icon" className="h-8 w-8 text-emerald-400 hover:text-emerald-300"
                            onClick={() => runNow(t)} disabled={runningId === t.ID}
                            aria-label="Run now"
                            title={t.STANDALONE_PROC ? `Run ${t.STANDALONE_PROC}` : t.SOURCE_KIND === "proc" || t.SOURCE_KIND === "view" ? "Run source → HLL" : `Run ${procKindLabel(t.PROC_KIND)} for ${t.CAMPAIGN_TITLE ?? "campaign"}`}
                          >
                            {runningId === t.ID ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(t)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-rose-400 hover:text-rose-300" onClick={() => setDeleteTask(t)} aria-label="Delete"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <AlertDialog open={!!deleteTask} onOpenChange={(o) => !o && setDeleteTask(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes “{deleteTask?.NAME}” from Snowflake. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-rose-600 text-white hover:bg-rose-700">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  historyEstatus: string | null
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

  // Idnumbers eligible for the extend/upload run. Two cases qualify:
  //   1. In history AND in the SS expired view AND the SS expiry is in the past — a true extension.
  //   2. In history but NOT in SS at all — there's nothing to extend, so the run acts as an upload.
  // A lead that is in SS but still active (not expired) is intentionally excluded.
  const extendableIdnumbers = useMemo(() => {
    if (!results) return []
    return Array.from(
      new Set(
        results
          .filter(
            (r) =>
              r.inHistory &&
              r.idnumber &&
              (!r.inSs || expiryStatus(ssExpiryFor(r)) === "expired")
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
        <PageHeading>Extend Expired Leads</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Re-activate expired leads at the client's request — verifies distribution history and pulls the
          current expiry date from Silver Surfer CRM.
        </p>
      </div>

      {/* Step 1 — Campaign */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <SectionHeading>Campaign</SectionHeading>
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
      </Card>

      {/* Step 2 — Lookup */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            2
          </span>
          <SectionHeading>Leads to extend</SectionHeading>
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
      </Card>

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
        <Banner tone="error">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{checkError}</span>
          </div>
        </Banner>
      )}

      {/* Step 3 — Results */}
      {results && summary && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              3
            </span>
            <SectionHeading>Results</SectionHeading>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Submitted" value={summary.total} />
            <StatTile label="In history" value={summary.inHistory} tone="primary" />
            <StatTile label="Expired (history)" value={summary.expired} tone="success" />
            <StatTile label="Active (not expired)" value={summary.active} tone="muted" />
            <StatTile label="In SS expired" value={summary.inSs} tone="primary" />
          </div>

          {ssMeta?.error && (
            <Banner tone="warning" className="mb-3">
              SS check skipped: {ssMeta.error}
            </Banner>
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
                  <TableHead>ESTATUS</TableHead>
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
                      {!r.inHistory ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.historyEstatus == null ||
                        ["SALE", "SALE MADE"].includes(
                          String(r.historyEstatus).trim().toUpperCase()
                        ) ? (
                        // NULL and SALE / SALE MADE are all extendable/uploadable.
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {r.historyEstatus == null ? "NULL" : String(r.historyEstatus)}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-amber-200"
                        >
                          <AlertCircle className="mr-1 h-3 w-3" />
                          {String(r.historyEstatus)}
                        </Badge>
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
                ? `${extendableIdnumbers.length} lead${extendableIdnumbers.length === 1 ? "" : "s"} eligible (in history and either SS-expired, or not in SS — uploaded as new).`
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
        </Card>
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
        <StatTile label="Total rows" value={parsed.totalRows ?? "—"} />
        <StatTile
          label="Successful"
          value={parsed.successful ?? "—"}
          tone={parsed.successful !== null && parsed.successful > 0 ? "success" : "muted"}
        />
        <StatTile
          label="Failed"
          value={parsed.failed ?? 0}
          tone={parsed.failed && parsed.failed > 0 ? "danger" : "muted"}
        />
        <StatTile label="Success rate" value={parsed.successRate ?? "—"} tone="success" />
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

type IntradayPace = {
  series: { hour: string; sales: number | null; predicted: number | null }[]
  dayTotal: number
  soFar: number
  elapsedShare: number
  basisHours: number
  profileDays: number
}

/**
 * Intraday pacing for the single-day view: project today's total from how much
 * of a typical day has already happened, then spread it over the remaining hours
 * by the historical hour-of-day shape.
 *
 *   dayTotal = sales in complete hours / share of a day those hours normally carry
 *
 * The most recent hour is still in progress and therefore under-reports, so it is
 * excluded from the basis whenever there is more than one hour to work with —
 * including it would drag every projection low all day.
 *
 * The estimator recovers the true total exactly when a day follows the profile;
 * what it cannot know is a day that breaks the pattern. Early on, the basis is a
 * few percent of a day and the projection swings hard on small numbers, so the
 * elapsed share is reported alongside it rather than left implicit.
 */
function paceIntradaySales(
  observed: { date: string; sales: number }[],
  profile: { hour: string; share: number }[],
  profileDays: number
): IntradayPace | null {
  if (profile.length === 0) return null
  const share = new Map(profile.map((q) => [q.hour, q.share]))
  const obs = observed.filter((o) => o.sales != null && share.has(o.date))
  if (obs.length === 0) return null

  const complete = obs.length >= 2 ? obs.slice(0, -1) : obs
  const basisSales = complete.reduce((a, o) => a + o.sales, 0)
  const basisShare = complete.reduce((a, o) => a + (share.get(o.date) ?? 0), 0)
  if (!(basisShare > 0) || !(basisSales > 0)) return null
  const dayTotal = basisSales / basisShare

  const obsByHour = new Map(obs.map((o) => [o.date, o.sales]))
  const hours = [...new Set([...profile.map((q) => q.hour), ...obs.map((o) => o.date)])].sort()
  return {
    series: hours.map((h) => ({
      hour: h,
      sales: obsByHour.has(h) ? (obsByHour.get(h) as number) : null,
      predicted: dayTotal * (share.get(h) ?? 0),
    })),
    dayTotal,
    soFar: obs.reduce((a, o) => a + o.sales, 0),
    elapsedShare: basisShare,
    basisHours: complete.length,
    profileDays,
  }
}

/** Colour for a predicted series. Emerald is the actual line; violet separates
 *  from it at dE 29.6 under deuteranopia (orange manages only 10.8), and matches
 *  "predicted" in the quality mix outlook. */
const PREDICTED_LINE = "#7c3aed"

/**
 * Sales-vs-forecast state colours — green above the forecast, amber on it, red
 * below.
 *
 * Red-against-green is the pair roughly 8% of men cannot separate by hue, so the
 * separation here is carried by LIGHTNESS as well: validated against the card
 * surface (#15181e) in dark mode, this red/green pair measures dE 19.5 under
 * deuteranopia, where the obvious emerald/red pairing (#0ca30c / #d03b3b)
 * measures 4.1 and is effectively one colour to those readers. All three clear
 * 3:1 contrast on the card.
 *
 * Colour is still only the reinforcement — the marker shape carries the same
 * three states, and position relative to the dashed forecast line carries it a
 * third time.
 */
const VARIANCE_COLOUR = {
  above: "#34d399",
  on: "#fab219",
  below: "#dc2626",
} as const

type VarianceState = keyof typeof VARIANCE_COLOUR

/**
 * Which side of the forecast a point sits on.
 *
 * Exact equality never happens between two continuous numbers, so "on the line"
 * is a band: 2% of the forecast, floored at half a sale so an hour predicting 3
 * does not flip colour on a rounding difference.
 */
function varianceState(sales: number, predicted: number): VarianceState {
  const tolerance = Math.max(0.5, Math.abs(predicted) * 0.02)
  const diff = sales - predicted
  if (Math.abs(diff) <= tolerance) return "on"
  return diff > 0 ? "above" : "below"
}

type VarianceSeries = {
  /** Per-point state, null where there is nothing to compare. */
  states: (VarianceState | null)[]
  /** Hard-step gradient stops for the stroke; empty when a solid colour will do. */
  stops: { offset: number; colour: string }[]
  /** Set instead of stops when only one point is drawn and a gradient is moot. */
  solid: string | null
}

/**
 * Per-point state plus the gradient that paints the stroke.
 *
 * SVG has no per-segment stroke colour, so the line is drawn once with a
 * horizontal gradient of hard steps. Each drawn point owns a band reaching
 * halfway to its neighbours, so the colour changes where the line crosses the
 * forecast rather than at the data point itself.
 *
 * Offsets are relative to the FIRST and LAST drawn point, not to the whole
 * series. The gradient resolves against the path's own bounding box, and on a
 * forecast chart the sales path stops well before the last x value — measuring
 * from the series ends would shift every band.
 */
function varianceSeries(
  series: { sales: number | null; predicted: number | null }[]
): VarianceSeries {
  const states = series.map((p) =>
    p.sales == null || p.predicted == null ? null : varianceState(p.sales, p.predicted)
  )
  const drawn: number[] = []
  states.forEach((s, i) => {
    if (s !== null) drawn.push(i)
  })
  if (drawn.length === 0) return { states, stops: [], solid: null }
  if (drawn.length === 1) {
    return { states, stops: [], solid: VARIANCE_COLOUR[states[drawn[0]] as VarianceState] }
  }

  const first = drawn[0]
  const span = drawn[drawn.length - 1] - first
  const pos = (i: number) => (i - first) / span
  const stops: { offset: number; colour: string }[] = []
  drawn.forEach((idx, k) => {
    const colour = VARIANCE_COLOUR[states[idx] as VarianceState]
    const start = k === 0 ? 0 : (pos(drawn[k - 1]) + pos(idx)) / 2
    const end = k === drawn.length - 1 ? 1 : (pos(idx) + pos(drawn[k + 1])) / 2
    stops.push({ offset: start, colour }, { offset: end, colour })
  })
  return { states, stops, solid: null }
}

/**
 * Markers that repeat the state in a second channel: pointing up above the
 * forecast, down below it, a diamond on it. A reader who cannot separate the red
 * from the green still gets the answer from the shape.
 */
function VarianceMarker({
  cx,
  cy,
  state,
  r = 4,
}: {
  cx: number
  cy: number
  state: VarianceState
  r?: number
}) {
  const points =
    state === "above"
      ? `${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}`
      : state === "below"
      ? `${cx},${cy + r} ${cx + r},${cy - r} ${cx - r},${cy - r}`
      : `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
  return (
    <polygon
      points={points}
      fill={VARIANCE_COLOUR[state]}
      // A surface-coloured ring so markers stay separable where the line doubles
      // back on itself. Set through style, since a presentation attribute would
      // not resolve the CSS variable.
      style={{ stroke: "hsl(var(--card))", strokeWidth: 1 }}
    />
  )
}

/** Legend for the variance colouring — colour, shape and words together. */
function VarianceLegend({ predictedLabel }: { predictedLabel: string }) {
  const items: { state: VarianceState; label: string }[] = [
    { state: "above", label: `Above ${predictedLabel}` },
    { state: "on", label: `On ${predictedLabel}` },
    { state: "below", label: `Below ${predictedLabel}` },
  ]
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.state} className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <VarianceMarker cx={6} cy={6} state={i.state} r={5} />
          </svg>
          {i.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
          <line
            x1="0"
            y1="6"
            x2="16"
            y2="6"
            stroke={PREDICTED_LINE}
            strokeWidth="2"
            strokeDasharray="5 4"
          />
        </svg>
        {predictedLabel.charAt(0).toUpperCase() + predictedLabel.slice(1)}
      </span>
    </div>
  )
}

type SalesForecast = {
  merged: { date: string; sales: number | null; predicted: number | null; projected: boolean }[]
  firstProjectedDate: string | null
  mape: number | null
  slopePerDay: number
  horizon: number
}

/**
 * Daily sales forecast: day-of-week factors times a linear trend on the
 * deseasonalised series.
 *
 * The series has strong weekly structure — weekends run roughly half a weekday —
 * so a plain trend line would predict weekend peaks and weekday troughs. Taking
 * the day-of-week factor out, fitting the trend on what remains, then putting the
 * factor back gives a shape that follows the real rhythm.
 *
 * Holdout tested on a synthetic series in this shape: 5.3% MAPE over 14 days,
 * against 7.9% for seasonal-naive (same weekday last week) and 28.2% for carrying
 * the last value forward.
 *
 * It extrapolates the recent pattern and nothing else. A campaign starting or
 * stopping, a price change, or a decision to push volume are invisible to it —
 * hence the fitted line over history, so its record is visible not asserted.
 */
function forecastDailySales(
  fitSeries: { date: string; sales: number | null }[],
  displaySeries: { date: string; sales: number | null }[],
  horizon = 14
): SalesForecast | null {
  const clean = (a: { date: string; sales: number | null }[]) =>
    a.filter(
      (q): q is { date: string; sales: number } =>
        q.sales != null && Number.isFinite(q.sales) && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
    )
  // Fit on the wider history; fall back to the displayed range if none came back.
  const pts = clean(fitSeries.length > 0 ? fitSeries : displaySeries)
  // Two weeks gives roughly two observations per weekday — the floor for
  // day-of-week factors to mean anything.
  if (pts.length < 14) return null

  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const overall = mean(pts.map((q) => q.sales))
  if (!(overall > 0)) return null

  // Multiplicative day-of-week factors, clamped so one sparse day cannot swing
  // the whole forecast.
  const factors = new Map<number, number>()
  for (let d = 0; d < 7; d++) {
    const vals = pts.filter((q) => dow(q.date) === d).map((q) => q.sales)
    const f = vals.length >= 2 ? mean(vals) / overall : 1
    factors.set(d, Math.min(2, Math.max(0.2, f)))
  }

  // Least-squares trend on the deseasonalised values.
  const des = pts.map((q, i) => ({ t: i, v: q.sales / (factors.get(dow(q.date)) ?? 1) }))
  const n = des.length
  const st = des.reduce((a, q) => a + q.t, 0)
  const sv = des.reduce((a, q) => a + q.v, 0)
  const stt = des.reduce((a, q) => a + q.t * q.t, 0)
  const stv = des.reduce((a, q) => a + q.t * q.v, 0)
  const denom = n * stt - st * st
  const slope = denom === 0 ? 0 : (n * stv - st * sv) / denom
  const intercept = (sv - slope * st) / n
  const at = (t: number, date: string) =>
    Math.max(0, (intercept + slope * t) * (factors.get(dow(date)) ?? 1))

  // Index every fitted date so a displayed point is scored at its true position
  // in the fitted series, not at its position within the visible window.
  const tByDate = new Map(pts.map((q, i) => [q.date, i]))
  const shown = clean(displaySeries)
  const merged: SalesForecast["merged"] = shown.map((q) => ({
    date: q.date,
    sales: q.sales,
    predicted: at(tByDate.get(q.date) ?? pts.length - 1, q.date),
    projected: false,
  }))

  const last = new Date(`${shown.length > 0 ? shown[shown.length - 1].date : pts[pts.length - 1].date}T00:00:00Z`)
  let firstProjectedDate: string | null = null
  for (let h = 1; h <= horizon; h++) {
    const d = new Date(last)
    d.setUTCDate(d.getUTCDate() + h)
    const ds = d.toISOString().slice(0, 10)
    if (h === 1) firstProjectedDate = ds
    merged.push({ date: ds, sales: null, predicted: at(n - 1 + h, ds), projected: true })
  }

  const scored = merged.filter((m) => !m.projected && (m.sales ?? 0) > 0)
  const mape =
    scored.length > 0
      ? mean(scored.map((m) => Math.abs((m.predicted ?? 0) - (m.sales ?? 0)) / (m.sales ?? 1))) * 100
      : null

  return { merged, firstProjectedDate, mape, slopePerDay: slope, horizon }
}

/**
 * Quick date ranges shared by the Distributed / Sales / Dialler reports, so they
 * match the quality mix report's shortcuts instead of offering only "Today".
 *
 * Month arithmetic is done on a local Date and read back with the same
 * todayLocalIso() formatting, so a range never lands a day out through a UTC
 * conversion. "This month" starts on the 1st; the "last N months" ranges are
 * calendar-relative, not 30-day multiples.
 */
type DateRangePreset = { label: string; range: () => { start: string; end: string } }

const localIso = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const monthsBack = (n: number): { start: string; end: string } => {
  const end = new Date()
  // setMonth() overflows on month-end dates — from 31 Aug it lands on 3 Mar
  // rather than 28 Feb — so build the target month and clamp the day to its
  // length.
  const start = new Date(end.getFullYear(), end.getMonth() - n, 1)
  const lastDayOfTarget = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
  start.setDate(Math.min(end.getDate(), lastDayOfTarget))
  return { start: localIso(start), end: localIso(end) }
}

const DATE_PRESETS: DateRangePreset[] = [
  {
    label: "Today",
    range: () => ({ start: todayLocalIso(), end: todayLocalIso() }),
  },
  {
    label: "Last 7 days",
    range: () => {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 6)
      return { start: localIso(start), end: localIso(end) }
    },
  },
  {
    label: "This month",
    range: () => {
      const now = new Date()
      return { start: localIso(new Date(now.getFullYear(), now.getMonth(), 1)), end: localIso(now) }
    },
  },
  { label: "Last 3 months", range: () => monthsBack(3) },
  { label: "Last 6 months", range: () => monthsBack(6) },
  { label: "Last 12 months", range: () => monthsBack(12) },
]

/**
 * Re-run the report against the filters already on screen.
 *
 * A bumped counter in the fetch effect's dependencies rather than a remount:
 * remounting would clear the campaign picker, the dates and every filter, and a
 * refresh that resets what you were looking at is worse than no refresh at all.
 */
function ReportRefreshButton({
  busy,
  onRefresh,
}: {
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRefresh}
      disabled={busy}
      title="Re-run with the current filters"
    >
      <RefreshCw className={cn("mr-2 h-3.5 w-3.5", busy && "animate-spin")} />
      Refresh
    </Button>
  )
}

function DatePresets({
  onPick,
}: {
  onPick: (start: string, end: string) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {DATE_PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => {
            const { start, end } = p.range()
            onPick(start, end)
          }}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

function ForecastingContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Forecasting</PageHeading>
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

type TempUploadResult = {
  ok?: boolean
  ran?: boolean
  error?: string
  columns?: { name: string; type: string }[]
  rows?: unknown[][]
  steps?: { step: string; ms: number; detail?: string }[]
  ranBy?: string
  ranAt?: string
}

/**
 * Temp upload — truncate TEMP_UPLOAD, run SP_SYNC_BATCH_COUNTS_TODAY, show the
 * result.
 *
 * The table is rendered from the returned column metadata rather than a fixed
 * BATCHNAME / SYSTEMMESSAGE / COUNT shape, so a change to the procedure's output
 * shows up instead of being silently dropped. Numeric columns are right-aligned
 * and totalled.
 */
type DupesResult = {
  ok?: boolean
  scanned?: boolean
  deleted?: boolean
  error?: string
  columns?: { name: string; type: string }[]
  rows?: unknown[][]
  summary?: {
    duplicateGroups: number
    rowsInDuplicateGroups: number
    rowsToDelete: number
  }
  truncated?: boolean
  topN?: number
  rescanError?: string | null
  steps?: { step: string; ms: number; detail?: string }[]
  ranBy?: string
  ranAt?: string
}

/**
 * Remove duplicates from Upload.TempUpload, the SQL Server staging table.
 *
 * Scan and delete are separate on purpose. The scan reads and writes only the
 * Snowflake side; the delete removes rows from SQL Server with no dry run and no
 * undo, so it stays behind a confirmation that names the count.
 */
function RemoveDuplicatesTab() {
  const [data, setData] = useState<DupesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [topN, setTopN] = useState("1000")
  const [keepNewest, setKeepNewest] = useState(true)
  // Deleting is only offered after a scan in this session. The stored counts
  // otherwise describe whatever the last person left in the table, which may be
  // hours old and no longer true.
  const [scannedNow, setScannedNow] = useState(false)

  const call = useCallback(
    async (init?: RequestInit, kind: "load" | "scan" | "delete" = "load") => {
      if (kind === "scan") setScanning(true)
      else if (kind === "delete") setDeleting(true)
      else setLoading(true)
      setError(null)
      try {
        const res = await fetch("/api/distribution/temp-upload/duplicates", {
          cache: "no-store",
          ...init,
        })
        const text = await res.text()
        let json: DupesResult
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`Server returned ${res.status} (not JSON): ${text.slice(0, 200)}`)
        }
        if (!res.ok || !json.ok) {
          setData(json)
          throw new Error(json.error || `HTTP ${res.status}`)
        }
        setData(json)
        if (kind === "scan") setScannedNow(true)
        if (kind === "delete") {
          setScannedNow(false)
          toast.success("Duplicates deleted from Upload.TempUpload")
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setScanning(false)
        setDeleting(false)
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    call()
  }, [call])

  const scan = () =>
    call(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan", topN: Number(topN) || 1000, keepNewest }),
      },
      "scan"
    )

  const runDelete = () => {
    setConfirmOpen(false)
    call(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          confirm: "DELETE",
          keepNewest,
          topN: Number(topN) || 1000,
        }),
      },
      "delete"
    )
  }

  const columns = data?.columns ?? []
  const rows = data?.rows ?? []
  const summary = data?.summary
  const busy = loading || scanning || deleting

  // RN is only present when the bridge was given an order_by. 1 is the row that
  // survives; anything higher is a row the delete would remove.
  const rnIndex = columns.findIndex((c) => c.name.toUpperCase() === "RN")

  const exportCsv = () => {
    if (columns.length === 0) return
    const esc = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v)
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
    }
    const lines = [
      columns.map((c) => esc(c.name)).join(","),
      ...rows.map((r) => r.map(esc).join(",")),
    ]
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `temp_upload_duplicates_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <SectionHeading>Find duplicates</SectionHeading>
            <p className="mt-1 text-sm text-muted-foreground">
              Reads <span className="font-mono text-xs">Upload.TempUpload</span> and lands the
              duplicate rows in <span className="font-mono text-xs">TEMP_UPLOAD_DUPES</span>.
              Nothing in SQL Server is changed by a scan.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              A duplicate is a repeated{" "}
              <span className="font-mono">CELLNUMBER + CAMPAIGNID + IDNUMBER</span>, among rows
              where <span className="font-mono">PROCESSEDFAILED = 0</span>. Both are fixed — they
              decide which rows get destroyed.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Keep</Label>
              <Select
                value={keepNewest ? "newest" : "oldest"}
                onValueChange={(v) => setKeepNewest(v === "newest")}
              >
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest (highest ID)</SelectItem>
                  <SelectItem value="oldest">Oldest (lowest ID)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">Scan limit</Label>
              <Input
                type="number"
                min={1}
                max={50000}
                value={topN}
                onChange={(e) => setTopN(e.target.value)}
                className="w-28 font-mono text-sm"
              />
            </div>
            <Button onClick={scan} disabled={busy}>
              {scanning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              {scanning ? "Scanning..." : "Scan for duplicates"}
            </Button>
          </div>
        </div>

        {data?.ranAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Last run {new Date(data.ranAt).toLocaleString()}
            {data.ranBy ? ` by ${data.ranBy}` : ""}
            {data.steps && data.steps.length > 0
              ? ` · ${data.steps.map((st) => `${st.step} ${(st.ms / 1000).toFixed(1)}s`).join(" · ")}`
              : ""}
          </p>
        )}
      </Card>

      {error && (
        <Banner tone="error">
          {error}
          {data?.steps && data.steps.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-rose-200/80">
              {data.steps.map((st, i) => (
                <li key={i}>
                  {st.step} — {(st.ms / 1000).toFixed(1)}s{st.detail ? " — failed" : " — ok"}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {data?.rescanError && (
        <Banner tone="warning">
          The delete succeeded, but re-reading the duplicates afterwards failed, so the figures
          below are the pre-delete ones. Scan again to see the current state. ({data.rescanError})
        </Banner>
      )}

      {summary && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile size="sm" label="Duplicate groups" value={summary.duplicateGroups.toLocaleString()} />
          <StatTile size="sm"
            label="Rows in those groups"
            value={summary.rowsInDuplicateGroups.toLocaleString()}
          />
          <StatTile size="sm"
            label="Rows that would be deleted"
            value={summary.rowsToDelete.toLocaleString()}
            tone={summary.rowsToDelete > 0 ? "danger" : "muted"}
          />
        </div>
      )}

      {data?.truncated && (
        <Banner tone="warning">
          <span className="font-medium">The scan hit its limit.</span> It returned exactly{" "}
          <span className="font-mono">{(data.topN ?? 0).toLocaleString()}</span> rows, so the counts
          above are a floor, not a total — there are more duplicates than shown.{" "}
          <span className="font-medium">The delete is not limited</span> and will remove all of
          them. Raise the scan limit if you want to see the real figure first.
        </Banner>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <SectionHeading>
            Duplicate rows{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({rows.length.toLocaleString()} shown)
            </span>
            {rnIndex >= 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                RN 1 is kept · RN 2+ would be deleted
              </span>
            )}
          </SectionHeading>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || !scannedNow || (summary?.rowsToDelete ?? 0) === 0}
              title={
                !scannedNow
                  ? "Scan first — the stored counts may be out of date"
                  : (summary?.rowsToDelete ?? 0) === 0
                  ? "Nothing to delete"
                  : undefined
              }
              onClick={() => setConfirmOpen(true)}
            >
              {deleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete duplicates
            </Button>
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c.name}>{c.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {busy && (
                deleting ? (
                <TableRow>
                  <TableCell colSpan={Math.max(1, columns.length)} className="text-center text-sm text-muted-foreground">
                    Deleting…
                  </TableCell>
                </TableRow>
              ) : (
                <SkeletonRows cols={Math.max(1, columns.length)} rows={5} />
              )
              )}
              {!busy && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={Math.max(1, columns.length)}
                    className="text-center text-sm text-muted-foreground"
                  >
                    No duplicates found — scan to check again.
                  </TableCell>
                </TableRow>
              )}
              {!busy &&
                rows.map((row, ri) => {
                  const keeper = rnIndex >= 0 && Number(row[rnIndex]) === 1
                  return (
                    <TableRow key={ri} className={keeper ? undefined : "bg-rose-500/5"}>
                      {columns.map((c, ci) => {
                        const v = row[ci]
                        const empty = v === null || v === undefined || v === ""
                        return (
                          <TableCell key={c.name} className="whitespace-nowrap font-mono text-xs">
                            {empty ? <span className="text-muted-foreground">—</span> : String(v)}
                            {ci === rnIndex && (
                              <span
                                className={cn(
                                  "ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                                  keeper
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : "bg-rose-500/15 text-rose-300"
                                )}
                              >
                                {keeper ? "keep" : "delete"}
                              </span>
                            )}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })}
            </TableBody>
          </Table>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete duplicates from Upload.TempUpload?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This deletes rows from SQL Server. There is no dry run and no undo.
                </p>
                <p>
                  Keeping the{" "}
                  <span className="font-medium text-foreground">
                    {keepNewest ? "newest" : "oldest"}
                  </span>{" "}
                  row of each{" "}
                  <span className="font-mono text-xs">CELLNUMBER + CAMPAIGNID + IDNUMBER</span>{" "}
                  group, among rows where{" "}
                  <span className="font-mono text-xs">PROCESSEDFAILED = 0</span>.
                </p>
                {data?.truncated ? (
                  <p className="text-amber-300">
                    The scan was capped at {(data.topN ?? 0).toLocaleString()} rows, so more than
                    the {(summary?.rowsToDelete ?? 0).toLocaleString()} shown will be deleted. The
                    delete is not capped.
                  </p>
                ) : (
                  <p>
                    About{" "}
                    <span className="font-mono text-foreground">
                      {(summary?.rowsToDelete ?? 0).toLocaleString()}
                    </span>{" "}
                    row(s) will be removed.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={runDelete}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              Delete duplicates
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Temp Upload — batch counts, and de-duplicating the SQL Server staging table. */
function TempUploadContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Temp Upload</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Today&apos;s batch counts, and duplicate removal on the upload staging table.
        </p>
      </div>
      <Tabs defaultValue="counts">
        <TabsList>
          <TabsTrigger value="counts">Batch counts</TabsTrigger>
          <TabsTrigger value="duplicates">Remove duplicates</TabsTrigger>
        </TabsList>
        <TabsContent value="counts" className="mt-4">
          <TempUploadCountsTab />
        </TabsContent>
        <TabsContent value="duplicates" className="mt-4">
          <RemoveDuplicatesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TempUploadCountsTab() {
  const [data, setData] = useState<TempUploadResult | null>(null)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // When this table was last read. Without it a screen showing yesterday's shape
  // is indistinguishable from one showing today's, and TEMP_UPLOAD's columns
  // change depending on which process wrote it last.
  const [readAt, setReadAt] = useState<Date | null>(null)

  const load = useCallback(async (method: "GET" | "POST") => {
    if (method === "POST") setRunning(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/distribution/temp-upload", { method, cache: "no-store" })
      const text = await res.text()
      let json: TempUploadResult
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`Server returned ${res.status} (not JSON): ${text.slice(0, 200)}`)
      }
      if (!res.ok || !json.ok) {
        setData(json)
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setData(json)
      setReadAt(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load("GET")
  }, [load])

  const columns = data?.columns ?? []
  const rows = data?.rows ?? []

  // Which columns are numeric, for alignment and totals.
  const numericIdx = useMemo(() => {
    const set = new Set<number>()
    columns.forEach((c, i) => {
      if (/^(FIXED|NUMBER|INTEGER|FLOAT|REAL|DECIMAL)/i.test(c.type || "")) set.add(i)
    })
    return set
  }, [columns])

  const totals = useMemo(() => {
    const out = new Map<number, number>()
    for (const i of numericIdx) {
      let sum = 0
      for (const row of rows) {
        const n = Number(row[i])
        if (Number.isFinite(n)) sum += n
      }
      out.set(i, sum)
    }
    return out
  }, [rows, numericIdx])

  const exportCsv = () => {
    if (columns.length === 0) return
    const esc = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v)
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
    }
    const lines = [
      columns.map((c) => esc(c.name)).join(","),
      ...rows.map((r) => r.map(esc).join(",")),
    ]
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `temp_upload_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-6">

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionHeading>Refresh batch counts</SectionHeading>
            <p className="mt-1 text-sm text-muted-foreground">
              Empties <span className="font-mono text-xs">TEMP_UPLOAD</span>, runs{" "}
              <span className="font-mono text-xs">SP_SYNC_BATCH_COUNTS_TODAY()</span>, then reads the
              table back. The truncate is intended — this table is a staging area for this process.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => load("GET")} disabled={running || loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Reload
            </Button>
            <Button onClick={() => load("POST")} disabled={running || loading}>
              {running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <DatabaseZap className="mr-2 h-4 w-4" />
              )}
              {running ? "Running..." : "Run refresh"}
            </Button>
          </div>
        </div>

        {data?.ranAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Last run {new Date(data.ranAt).toLocaleString()}
            {data.ranBy ? ` by ${data.ranBy}` : ""}
            {data.steps && data.steps.length > 0
              ? ` · ${data.steps.map((st) => `${st.step} ${(st.ms / 1000).toFixed(1)}s`).join(" · ")}`
              : ""}
          </p>
        )}
      </Card>

      {error && (
        <Banner tone="error">
          {error}
          {data?.steps && data.steps.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-rose-200/80">
              {data.steps.map((st, i) => (
                <li key={i}>
                  {st.step} — {(st.ms / 1000).toFixed(1)}s{st.detail ? " — failed" : " — ok"}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <Card padding="none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <SectionHeading>
            TEMP_UPLOAD{" "}
            <span className="text-sm text-muted-foreground">
              ({rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"},{" "}
              {columns.length} column{columns.length === 1 ? "" : "s"})
            </span>
            {readAt && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                read {readAt.toLocaleTimeString()}
              </span>
            )}
          </SectionHeading>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
        <div className="max-h-[640px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c, i) => (
                  <TableHead key={c.name} className={numericIdx.has(i) ? "text-right" : undefined}>
                    {c.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(loading || running) && (
                <SkeletonRows cols={Math.max(1, columns.length)} rows={5} />
              )}
              {!loading && !running && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={Math.max(1, columns.length)}
                    className="text-center text-sm text-muted-foreground"
                  >
                    Empty — run the refresh to populate it.
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                !running &&
                rows.map((row, ri) => (
                  <TableRow key={ri}>
                    {columns.map((c, ci) => {
                      const v = row[ci]
                      const isNum = numericIdx.has(ci)
                      const empty = v === null || v === undefined || v === ""
                      return (
                        <TableCell
                          key={c.name}
                          className={
                            isNum
                              ? "text-right font-mono text-sm"
                              : "font-mono text-xs text-foreground"
                          }
                        >
                          {empty ? (
                            <span className="text-muted-foreground">—</span>
                          ) : isNum ? (
                            Number(v).toLocaleString()
                          ) : (
                            String(v)
                          )}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
            </TableBody>
            {rows.length > 0 && numericIdx.size > 0 && (
              <TableFooter>
                <TableRow className="border-t-2 border-border">
                  {columns.map((c, i) => (
                    <TableCell
                      key={c.name}
                      className={
                        numericIdx.has(i)
                          ? "text-right font-mono text-sm font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      {i === 0
                        ? "Total"
                        : numericIdx.has(i)
                        ? (totals.get(i) ?? 0).toLocaleString()
                        : ""}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </Card>
    </div>
  )
}

function RecycleContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>Recycle</PageHeading>
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

// The Distributed / Sales / Dialler panels below are rendered by the Reporting
// department (components/reporting-dashboard.tsx), not from here. The tab
// wrapper that used to host them was removed with the Dashboard nav entry.
export function DistributedDashboardPanel() {
  // Bumped by the Refresh button; the data effect depends on it.
  const [reloadKey, setReloadKey] = useState(0)
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
  }, [selectedCampaignIds, startDate, endDate, reloadKey])

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
    ? "All campaigns"
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">Leads loaded by campaign and date.</p>

      {/* Filters */}
      <Card>
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
              {/* Inside the date row, not under the presets — it belongs with the
                  controls that decide what is fetched. */}
              <ReportRefreshButton busy={loading} onRefresh={() => setReloadKey((k) => k + 1)} />
            </div>
            <DatePresets
              onPick={(start, end) => {
                setStartDate(start)
                setEndDate(end)
              }}
            />
          </div>
        </div>
      </Card>

      {error && (
        <Banner tone="error">
          {error}
        </Banner>
      )}

      {selectedCampaignIds.length > 0 && loading && !data && (
        <SkeletonPanel title="Dashboard" tiles={4} height={256} />
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
  dailyHistory?: { date: string; sales: number }[]
  historyFrom?: string
  hourProfile?: {
    hours: { hour: string; share: number }[]
    days: number
    from: string
    to: string
  }
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

export function DiallerDashboardPanel() {
  // Bumped by the Refresh button; the data effect depends on it.
  const [reloadKey, setReloadKey] = useState(0)
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
    if (!startDate || !endDate) {
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
  }, [selectedCampaigns, startDate, endDate, selectedStatuses, reloadKey])

  const toggleCampaign = (id: string) =>
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )

  const triggerLabel = campaignsLoading
    ? "Loading campaigns..."
    : selectedCampaigns.length === 0
    ? "All campaigns"
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">Dialler activity by campaign and date.</p>

      <Card>
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
              {/* Inside the date row, not under the presets — it belongs with the
                  controls that decide what is fetched. */}
              <ReportRefreshButton busy={loading} onRefresh={() => setReloadKey((k) => k + 1)} />
            </div>
            <DatePresets
              onPick={(start, end) => {
                setStartDate(start)
                setEndDate(end)
              }}
            />
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
      </Card>

      {error && (
        <Banner tone="error">
          {error}
        </Banner>
      )}

      {selectedCampaigns.length > 0 && loading && !data && (
        <SkeletonPanel title="Dialler stats" tiles={4} height={256} />
      )}

      {selectedCampaigns.length > 0 && data && <DiallerSummary data={data} />}
    </div>
  )
}

function DiallerSummary({ data }: { data: DiallerData }) {
  const chartMotion = useChartMotion()
  const dateLabel =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`
  const avgPerDay = data.totals.days > 0 ? data.totals.totalLeads / data.totals.days : 0

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile size="sm"
          label="Total leads"
          value={data.totals.totalLeads.toLocaleString()}
          tone="success"
        />
        <StatTile size="sm" label="Days" value={data.totals.days.toLocaleString()} tone="primary" />
        <StatTile size="sm"
          label="Campaigns"
          value={data.totals.campaigns.toLocaleString()}
          tone="primary"
        />
        <StatTile size="sm"
          label="Avg / day"
          value={data.totals.days > 0 ? avgPerDay.toFixed(1) : "—"}
          tone="muted"
        />
        <StatTile size="sm"
          label="Avg score"
          value={data.totals.avgScore === null ? "—" : data.totals.avgScore.toFixed(1)}
          tone="primary"
        />
      </div>

      {/* Leads over time / by half-hour */}
      {data.byBucket.length > 0 && (
        <Card>
          <div className="mb-2">
            <SectionHeading>
              {data.granularity === "halfHour" ? "Leads by half-hour" : "Leads over time"}
            </SectionHeading>
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
                {...chartMotion}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Heatgrid SCOREGROUP × CALL_START_TIME */}
      {data.byScoreDate.length > 0 && <ScoreDateHeatgrid data={data.byScoreDate} />}

      {/* Call status breakdown */}
      {data.byStatus.length > 0 && (
        <div>
          <div className="mb-2">
            <SectionHeading>Leads by call status</SectionHeading>
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
            <SectionHeading>Leads per campaign</SectionHeading>
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

export function SalesDashboardPanel() {
  // Bumped by the Refresh button; the data effect depends on it.
  const [reloadKey, setReloadKey] = useState(0)
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
    ? "All campaigns"
    : selectedCampaigns.length === 1
    ? `${selectedCampaigns[0].title}  ·  ${selectedCampaigns[0].id}`
    : `${selectedCampaigns.length} campaigns selected`

  // Load sales data when campaigns + dates + extra filters are set.
  useEffect(() => {
    if (!startDate || !endDate) {
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
  }, [selectedCampaigns, startDate, endDate, selectedProviders, selectedInsurable, reloadKey])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Sales activity by campaign and date.
      </p>

      <Card>
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
              {/* Inside the date row, not under the presets — it belongs with the
                  controls that decide what is fetched. */}
              <ReportRefreshButton busy={loading} onRefresh={() => setReloadKey((k) => k + 1)} />
            </div>
            <DatePresets
              onPick={(start, end) => {
                setStartDate(start)
                setEndDate(end)
              }}
            />
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
      </Card>

      {error && (
        <Banner tone="error">
          {error}
        </Banner>
      )}

      {selectedCampaigns.length > 0 && loading && !data && (
        <SkeletonPanel title="Sales stats" tiles={4} height={256} />
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
  const chartMotion = useChartMotion()
  const dateLabel =
    data.startDate === data.endDate ? data.startDate : `${data.startDate} → ${data.endDate}`
  const avgPerDay =
    data.totals.days > 0 ? data.totals.totalSales / data.totals.days : 0

  // Forecast only makes sense on the daily series; a single day is bucketed by
  // hour and has no day-of-week structure to model.
  const salesForecast = useMemo(
    () =>
      data.granularity !== "hour"
        ? forecastDailySales(data.dailyHistory ?? [], data.bySalesDate, 14)
        : null,
    [data]
  )

  // Single day → pace the rest of today against the recent hour-of-day shape.
  const intraday = useMemo(
    () =>
      data.granularity === "hour" && data.hourProfile
        ? paceIntradaySales(data.bySalesDate, data.hourProfile.hours, data.hourProfile.days)
        : null,
    [data]
  )

  const chartSeries = salesForecast
    ? salesForecast.merged
    : intraday
    ? intraday.series
    : data.bySalesDate

  // Only colour by variance when there is something to vary against. Without a
  // forecast the line keeps its plain emerald, since green would otherwise read
  // as "above target" on a chart that has no target.
  const hasPrediction = Boolean(salesForecast || intraday)
  const variance = useMemo(
    () =>
      hasPrediction
        ? varianceSeries(chartSeries as { sales: number | null; predicted: number | null }[])
        : null,
    [hasPrediction, chartSeries]
  )
  const predictedLabel = intraday ? "expected pace" : "forecast"

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
        <StatTile size="sm"
          label="Total sales"
          value={data.totals.totalSales.toLocaleString()}
          tone="success"
        />
        <StatTile size="sm" label="Rows" value={data.totals.rows.toLocaleString()} />
        <StatTile size="sm" label="Days" value={data.totals.days.toLocaleString()} tone="primary" />
        <StatTile size="sm"
          label="Campaigns"
          value={data.totals.campaigns.toLocaleString()}
          tone="primary"
        />
        <StatTile size="sm"
          label="Avg / day"
          value={data.totals.days > 0 ? avgPerDay.toFixed(1) : "—"}
          tone="muted"
        />
      </div>

      {/* Sales over time — by hour when single day, by date when range */}
      {data.bySalesDate.length > 0 && (
        <Card>
          <div className="mb-2">
            <SectionHeading>
              {data.granularity === "hour" ? "Sales by hour" : "Sales over time"}
            </SectionHeading>
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
              <LineChart data={chartSeries} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
                {variance && variance.stops.length > 0 && (
                  <defs>
                    <linearGradient id="salesVariance" x1="0" y1="0" x2="1" y2="0">
                      {variance.stops.map((s, i) => (
                        <stop
                          key={i}
                          offset={`${(s.offset * 100).toFixed(4)}%`}
                          stopColor={s.colour}
                        />
                      ))}
                    </linearGradient>
                  </defs>
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey={intraday ? "hour" : "date"}
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
                  // Spell out the gap in words as well as colour, so the reading
                  // does not depend on telling the red from the green.
                  formatter={(value, name, item) => {
                    const n = Number(value)
                    if (name !== "Sales" || !variance) return [n.toLocaleString(), name]
                    const predicted = (item?.payload as { predicted?: number | null } | undefined)
                      ?.predicted
                    if (predicted == null) return [n.toLocaleString(), name]
                    const state = varianceState(n, predicted)
                    const diff = n - predicted
                    const gap =
                      state === "on"
                        ? `on ${predictedLabel}`
                        : `${diff > 0 ? "+" : ""}${Math.round(diff).toLocaleString()} vs ${predictedLabel}`
                    return [`${n.toLocaleString()} (${gap})`, name]
                  }}
                />
                {!variance && (salesForecast || intraday) && (
                  <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
                )}
                {salesForecast?.firstProjectedDate && (
                  <ReferenceLine
                    x={salesForecast.firstProjectedDate}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 4"
                    label={{
                      value: "forecast",
                      position: "insideTopRight",
                      fill: "hsl(var(--muted-foreground))",
                      fontSize: 10,
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="sales"
                  name="Sales"
                  stroke={
                    // Never reference the gradient unless it was actually
                    // rendered — a dangling url() paints nothing at all.
                    variance && variance.stops.length > 0
                      ? "url(#salesVariance)"
                      : variance?.solid ?? "#10b981"
                  }
                  strokeWidth={2}
                  dot={
                    variance
                      ? (props) => {
                          const { cx, cy, index } = props as {
                            cx?: number
                            cy?: number
                            index?: number
                          }
                          const state = index == null ? null : variance.states[index]
                          // Recharts still calls this for gaps in the series.
                          if (cx == null || cy == null || !state) return <g />
                          return <VarianceMarker cx={cx} cy={cy} state={state} />
                        }
                      : { r: 3 }
                  }
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                  legendType={variance ? "none" : "line"}
                {...chartMotion}
                />
                {(salesForecast || intraday) && (
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    name={intraday ? "Expected pace" : "Predicted"}
                    stroke={PREDICTED_LINE}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls
                    legendType={variance ? "none" : "line"}
                  {...chartMotion}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {variance && <VarianceLegend predictedLabel={predictedLabel} />}
          {intraday && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p>
                On pace for{" "}
                <span className="font-mono text-foreground">
                  {Math.round(intraday.dayTotal).toLocaleString()}
                </span>{" "}
                today —{" "}
                <span className="font-mono">{intraday.soFar.toLocaleString()}</span> so far, from{" "}
                {intraday.basisHours} completed hour{intraday.basisHours === 1 ? "" : "s"} carrying{" "}
                <span className="font-mono">{(intraday.elapsedShare * 100).toFixed(0)}%</span> of a
                typical day.
                {intraday.elapsedShare < 0.25 && (
                  <span className="text-amber-200">
                    {" "}
                    Early in the day this swings on small numbers — treat it as indicative.
                  </span>
                )}
              </p>
              <p>
                Expected pace is the hour-of-day shape from the last {intraday.profileDays} trading
                day{intraday.profileDays === 1 ? "" : "s"}, scaled to today. The in-progress hour is
                left out of the basis, since it always under-reports and would drag the projection
                low all day.
              </p>
            </div>
          )}
          {salesForecast && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p>
                Predicted line: the day-of-week pattern times the trend of the deseasonalised series,
                projected {salesForecast.horizon} days
                {data.historyFrom && <> · fitted on sales since {data.historyFrom}</>}.
                {salesForecast.mape !== null && (
                  <>
                    {" "}
                    Across the history shown it lands within{" "}
                    <span className="font-mono text-foreground">
                      {salesForecast.mape.toFixed(1)}%
                    </span>{" "}
                    of actual on average
                  </>
                )}
                {Math.abs(salesForecast.slopePerDay) >= 0.1 && (
                  <>
                    , on an underlying trend of{" "}
                    <span
                      className={
                        salesForecast.slopePerDay > 0 ? "text-emerald-300" : "text-rose-300"
                      }
                    >
                      {salesForecast.slopePerDay > 0 ? "+" : ""}
                      {salesForecast.slopePerDay.toFixed(1)} sales/day
                    </span>
                  </>
                )}
                .
              </p>
              <p>
                It extrapolates the recent pattern and nothing else — a campaign starting or stopping,
                a price change, or a decision to push volume are invisible to it. Judge it by the gap
                between the two lines over history, not by how far the dashes reach.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Heatgrid of score group × date with sales as the metric */}
      {data.byScoreDate.length > 0 && <ScoreDateHeatgrid data={data.byScoreDate} />}

      {/* Per-campaign breakdown */}
      {data.byCampaign.length > 1 && (
        <div>
          <div className="mb-2">
            <SectionHeading>Sales per campaign</SectionHeading>
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
  filterNote,
}: {
  data: { date: string; avgScore: number | null; count: number }[]
  /** Set when the caller has narrowed the series with the grid's date filter. */
  filterNote?: string
}) {
  const chartMotion = useChartMotion()
  // Filter out days with no leads (avgScore null) so the line doesn't drop to 0.
  const series = data
    .filter((r) => r.avgScore !== null)
    .map((r) => ({ date: r.date, avgScore: Number(r.avgScore!.toFixed(2)), count: r.count }))

  if (series.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {filterNote
          ? "No score data for the selected days — widen the date filter on the grid."
          : "No score data to plot."}
      </div>
    )
  }

  return (
    <Card>
      <div className="mb-2">
        <SectionHeading>Average score over time</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Mean of <span className="font-mono">SCORE</span> per day · {series.length} day
          {series.length === 1 ? "" : "s"} with data
          {filterNote && <> · {filterNote}</>}
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
            {...chartMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function ScoreDateHeatgrid({
  data,
  selectedDates: controlledDates,
  onSelectedDatesChange,
}: {
  data: { scoreGroup: string; date: string; count: number }[]
  /**
   * Optional controlled date selection. When a parent passes the handler, the
   * date filter is lifted out of this card so the same day selection can narrow
   * other panels — the Distributed report uses it for the average-score line, so
   * the grid and the line always describe the same days. Left out, the grid owns
   * the selection itself.
   */
  selectedDates?: Set<string> | null
  onSelectedDatesChange?: (next: Set<string> | null) => void
}) {
  // All score groups present in the data, ordered by their numeric bound.
  const allScoreGroups = useMemo(() => {
    const set = new Set(data.map((r) => r.scoreGroup))
    return Array.from(set).sort((a, b) => scoreGroupSortKey(a) - scoreGroupSortKey(b))
  }, [data])

  // All dates present in the data (the window picked by the main filter),
  // sorted — the date filter lets users drop specific days within it.
  const allDates = useMemo(() => {
    const set = new Set(data.map((r) => r.date))
    return Array.from(set).sort()
  }, [data])

  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFilterOpen, setDateFilterOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [ownSelectedDates, setOwnSelectedDates] = useState<Set<string> | null>(null)
  const [mode, setMode] = useState<"count" | "percent">("count")

  const datesControlled = onSelectedDatesChange !== undefined
  const selectedDates = datesControlled ? controlledDates ?? null : ownSelectedDates
  const setSelectedDates = datesControlled ? onSelectedDatesChange : setOwnSelectedDates

  // Reset filters whenever the underlying data changes (e.g. new query). When
  // the dates are controlled the owner resets them — clearing from here as well
  // would fight it.
  useEffect(() => {
    setSelected(null)
    if (!datesControlled) setOwnSelectedDates(null)
  }, [allScoreGroups.join("|"), allDates.join("|"), datesControlled])

  const isAllSelected = selected === null
  const activeSet = selected ?? new Set(allScoreGroups)
  const isAllDatesSelected = selectedDates === null
  const activeDateSet = selectedDates ?? new Set(allDates)

  const toggle = (sg: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? allScoreGroups)
      if (next.has(sg)) next.delete(sg)
      else next.add(sg)
      return next
    })

  // Computed from the current value rather than an updater callback, since the
  // controlled setter is a plain handler and cannot take one.
  const toggleDate = (d: string) => {
    const next = new Set(selectedDates ?? allDates)
    if (next.has(d)) next.delete(d)
    else next.add(d)
    setSelectedDates(next)
  }

  const filteredRows = useMemo(
    () => data.filter((r) => activeSet.has(r.scoreGroup) && activeDateSet.has(r.date)),
    [data, activeSet, activeDateSet]
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
  /**
   * Date columns or time-of-day columns?
   *
   * Read off the data rather than passed in, because the column key is
   * whatever the route bucketed by and only the data can be wrong about that:
   * Sales sends `HH:00` when one day is picked, Dialler sends `HH:MM`
   * half-hours, everything else sends `YYYY-MM-DD`. A prop could be passed
   * inconsistently with the rows it labels; this cannot.
   */
  const axisKind: "date" | "time" =
    dates.length > 0 && dates.every((d) => /^\d{2}:\d{2}$/.test(d)) ? "time" : "date"
  const unit = axisKind === "time" ? "hour" : "day"

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
          <SectionHeading>Score group × {axisKind === "time" ? "hour" : "created on"}</SectionHeading>
          <p className="text-sm text-muted-foreground">
            {mode === "percent"
              ? `Each cell as % of that ${unit}'s total. Empty ${unit}s hidden.`
              : `Lead counts coloured by intensity. Empty ${unit}s are hidden.`}{" "}
            {scoreGroups.length} of {allScoreGroups.length} score group
            {allScoreGroups.length === 1 ? "" : "s"} · {dates.length} {unit}
            {dates.length === 1 ? "" : "s"}
            {mode === "count" && ` · max ${maxCount.toLocaleString()}`}
            {mode === "percent" && maxPercent > 0 &&
              ` · max ${(maxPercent * 100).toFixed(1)}%`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Popover open={dateFilterOpen} onOpenChange={setDateFilterOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                Filter {unit}s{" "}
                {!isAllDatesSelected && (
                  <span className="ml-1 rounded-full bg-primary/20 px-1.5 text-xs text-primary">
                    {activeDateSet.size}/{allDates.length}
                  </span>
                )}
                <ChevronsUpDown className="ml-2 h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="end">
              <Command>
                <CommandInput placeholder={`Search ${unit}s...`} />
                <CommandList>
                  <CommandEmpty>No match.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem value="__all__" onSelect={() => setSelectedDates(null)}>
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          isAllDatesSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      (Select all)
                    </CommandItem>
                    {allDates.map((d) => {
                      const checked = activeDateSet.has(d)
                      return (
                        <CommandItem key={d} value={d} onSelect={() => toggleDate(d)}>
                          <Check
                            className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")}
                          />
                          <span className="font-mono text-sm">{d}</span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
              % of {unit}
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
                    {axisKind === "time" ? d : d.slice(5)}
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

  // The grid's date filter is owned here rather than inside the grid so it also
  // narrows the average-score line. Dropping a day from the grid and leaving it
  // on the line had the two panels describing different days on the same screen.
  const gridDates = useMemo(() => {
    const set = new Set(data.byScoreDate.map((r) => r.date))
    return Array.from(set).sort()
  }, [data.byScoreDate])

  const [selectedDates, setSelectedDates] = useState<Set<string> | null>(null)

  // A new query brings a new window — start from all of it.
  useEffect(() => {
    setSelectedDates(null)
  }, [gridDates.join("|")])

  const avgScoreSeries = useMemo(
    () =>
      selectedDates === null
        ? data.avgScoreByDay
        : data.avgScoreByDay.filter((r) => selectedDates.has(r.date)),
    [data.avgScoreByDay, selectedDates]
  )

  const dateFilterNote =
    selectedDates === null
      ? undefined
      : `${selectedDates.size} of ${gridDates.length} days selected in the grid filter`

  return (
    <>
      {/* KPI strip — compact, two rows on most screens */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-10">
        <StatTile size="sm" label="Total leads" value={data.totals.total.toLocaleString()} />
        <StatTile size="sm"
          label="Batches"
          value={data.totals.distinctBatches.toLocaleString()}
          tone="primary"
        />
        <StatTile size="sm"
          label="Active"
          value={data.totals.active.toLocaleString()}
          tone="success"
        />
        <StatTile size="sm"
          label="Expired"
          value={data.totals.expired.toLocaleString()}
          tone={data.totals.expired > 0 ? "danger" : "muted"}
        />
        <StatTile size="sm"
          label="Distinct IDs"
          value={data.totals.distinctIdnumbers.toLocaleString()}
        />
        <StatTile size="sm"
          label="With ESTATUS"
          value={data.totals.withStatus.toLocaleString()}
          tone="muted"
        />
        <StatTile size="sm"
          label="Avg score"
          value={data.totals.avgScore === null ? "—" : data.totals.avgScore.toFixed(1)}
          tone="primary"
        />
        <StatTile size="sm"
          label="Avg salary"
          value={data.totals.avgSalary === null ? "—" : formatRand(data.totals.avgSalary)}
          tone="primary"
        />
        <StatTile size="sm"
          label="Avg available spend"
          value={
            data.totals.avgAvailableSpend === null
              ? "—"
              : formatRand(data.totals.avgAvailableSpend)
          }
          tone="primary"
        />
        <StatTile size="sm"
          label="Avg UDM8 LDA"
          value={data.totals.avgUdm8Lda === null ? "—" : data.totals.avgUdm8Lda.toFixed(2)}
          tone="primary"
        />
      </div>

      {/* Heatgrid: SCOREGROUP × CREATEDONDATE */}
      {data.byScoreDate.length > 0 && (
        <ScoreDateHeatgrid
          data={data.byScoreDate}
          selectedDates={selectedDates}
          onSelectedDatesChange={setSelectedDates}
        />
      )}

      {/* Avg score by day — follows the grid's date filter */}
      {data.avgScoreByDay.length > 0 && (
        <AvgScoreLineChart data={avgScoreSeries} filterNote={dateFilterNote} />
      )}

      {/* Status breakdown table */}
      {data.byStatus.length > 0 && (
        <div>
          <div className="mb-2">
            <SectionHeading>Status breakdown</SectionHeading>
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
            <SectionHeading>Leads per campaign</SectionHeading>
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
        <PageHeading>Settings</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Distribution-specific settings. App-wide auth settings live on the department picker.
        </p>
      </div>

      <CampaignSettingsPanel />
    </div>
  )
}

type HllProc = { PROC_INDEX: number | string; PROC_NAME: string; CREATED_AT?: string | null }

// Sentinel for the "no procedure" option in a Radix Select (which can't use "").
const NONE_PROC = "__none__"

type CampaignConfig = {
  CONFIG_ID?: number | string | null
  CONFIG_NAME?: string | null
  LEAD_SOURCE?: string | null
  SFTP_HOST?: string | null
  SFTP_PORT?: number | string | null
  SFTP_USERNAME?: string | null
  SFTP_PASSWORD?: string | null
  SFTP_PRIVATE_KEY?: string | null
  SFTP_REMOTE_PATH?: string | null
  SFTP_AUTH_TYPE?: string | null
  UPLOAD_TARGET_TABLE?: string | null
  LOAD_HISTORY_PROCEDURE?: string | null
  UPDATE_HLL_PROCEDURE?: string | null
  UPDATE_HLL_PROCEDURES?: string | null
  SYNC_PROCEDURE?: string | null
  SYNC_SOURCE_VIEW?: string | null
  SYNC_TARGET_TABLE?: string | null
  SYNC_COLUMNS?: string | null
  SYNC_BATCH_SIZE?: number | string | null
  SOURCE_KIND?: string | null
  SOURCE_OBJECT?: string | null
  SOURCE_LOAD_FROM?: string | null
  SOURCE_MAPPING_JSON?: string | null
  LEAD_EXPIRY_DAYS?: number | string | null
  BATCH_NAME_TEMPLATE?: string | null
  IS_ACTIVE?: boolean | null
  LAST_RUN_AT?: string | null
  LAST_RUN_STATUS?: string | null
  LAST_RUN_MESSAGE?: string | null
}

type RunHistoryRow = {
  ID: number | string
  CREATED_AT: string | null
  CONFIG_NAME: string | null
  STATUS: string | null
  RAN: number | string | null
  SUMMARY: string | null
  CREATED_BY: string | null
}

function CampaignSettingsPanel() {
  // --- Campaign picker ---
  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)

  // --- Multi-config: a campaign can have many named automation configs ---
  const [configs, setConfigs] = useState<CampaignConfig[]>([])
  const [configId, setConfigId] = useState<number | null>(null) // null = new/unsaved
  const [configName, setConfigName] = useState("Automation")
  const [settingsOpen, setSettingsOpen] = useState(true)

  // --- Config form ---
  // How this campaign's leads arrive: file (default) / sftp / snowflake.
  const [leadSource, setLeadSource] = useState<"file" | "sftp" | "snowflake">("file")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("22")
  const [username, setUsername] = useState("")
  const [authType, setAuthType] = useState<"password" | "privateKey">("password")
  const [password, setPassword] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [remotePath, setRemotePath] = useState("")
  const [targetTable, setTargetTable] = useState("")
  const [, setLoadHistoryProc] = useState("")
  const [updateHllProcs, setUpdateHllProcs] = useState<string[]>([])
  const [syncProcedure, setSyncProcedure] = useState("")
  // Structured sync (SP_SYNC_TO_SQLSERVER_LARGE): the source view is interchangeable.
  const [syncSourceView, setSyncSourceView] = useState("")
  const [syncTargetTable, setSyncTargetTable] = useState("")
  const [syncColumns, setSyncColumns] = useState("")
  const [syncBatch, setSyncBatch] = useState("10000")
  // Step 1 — initial source
  const [sourceKind, setSourceKind] = useState<"none" | "proc" | "view">("none")
  const [sourceObject, setSourceObject] = useState("")
  // Optional: what the mapped INSERT reads, when the procedure writes somewhere
  // other than the upload target. Blank means "the upload target".
  const [sourceLoadFrom, setSourceLoadFrom] = useState("")
  const [sourceMapping, setSourceMapping] = useState<Record<string, string>>({})
  // Lead expiry: LEADEXPIRY = today + this many days (default 45).
  const [leadExpiryDays, setLeadExpiryDays] = useState("45")
  // Batch name template: {date} → today as YYYYMMDD. Editable per campaign.
  const [batchTemplate, setBatchTemplate] = useState("BATCH_ONAIR_ULTRA5{date}")
  const [hllCols, setHllCols] = useState<{ name: string; type: string }[]>([])
  const [viewCols, setViewCols] = useState<{ name: string; type: string }[]>([])
  const [colsLoading, setColsLoading] = useState(false)
  const [colsMsg, setColsMsg] = useState<string | null>(null)
  // Separate from colsMsg, which renders as an error. Dropping a stale mapping
  // is a successful cleanup, not a failure, and must not look like one.
  const [colsNote, setColsNote] = useState<string | null>(null)
  const [isActive, setIsActive] = useState(true)
  // --- Full-distribution run ---
  const [running, setRunning] = useState(false)
  const [runSteps, setRunSteps] = useState<StepView[]>([])
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)
  const [lastRunStatus, setLastRunStatus] = useState<string | null>(null)
  const [lastRunMessage, setLastRunMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<RunHistoryRow[]>([])
  // Per-step run: the saved config's plan + each step's transient status.
  const [plan, setPlan] = useState<{ key: string; label: string }[]>([])
  const [stepState, setStepState] = useState<Record<string, { status: StepView["status"]; message?: string }>>({})
  const [syncBg, setSyncBg] = useState<{ status: string; at?: string | null; finishedAt?: string | null; error?: string } | null>(null)

  /**
   * Unsaved-change detection for the fields a run actually builds SQL from.
   *
   * Running uses the last SAVED config, so an edited-but-unsaved procedure keeps
   * sending the old CALL — and Snowflake's reply looks identical either way,
   * which is a genuinely hard thing to diagnose from the error alone. The note
   * under the buttons said as much and still got missed, so the mismatch is now
   * called out where it matters.
   *
   * Only run-critical fields count. SFTP credentials and the config name are
   * left out deliberately: they change nothing about the statements, and
   * flagging them would train people to ignore the warning.
   */
  const runKey = useMemo(
    () =>
      JSON.stringify([
        sourceKind, sourceObject.trim(), targetTable.trim(), updateHllProcs,
        syncProcedure.trim(), syncSourceView.trim(), syncTargetTable.trim(),
        syncColumns.trim(), syncBatch.trim(), String(leadExpiryDays).trim(),
        batchTemplate.trim(), sourceMapping, isActive,
      ]),
    [sourceKind, sourceObject, targetTable, updateHllProcs, syncProcedure, syncSourceView,
     syncTargetTable, syncColumns, syncBatch, leadExpiryDays, batchTemplate, sourceMapping, isActive]
  )
  const [savedRunKey, setSavedRunKey] = useState<string | null>(null)
  // Set when a config has just been loaded into the form; the snapshot is taken
  // on the following render, once React has flushed all of applyConfig's setters.
  const wantRunSnapshot = useRef(false)
  useEffect(() => {
    if (!wantRunSnapshot.current) return
    wantRunSnapshot.current = false
    setSavedRunKey(runKey)
  }, [runKey])
  const runDirty = savedRunKey !== null && runKey !== savedRunKey

  // Run history is shown for the whole campaign (all its configs).
  const loadHistory = useCallback(async (cid: string) => {
    if (!cid) { setHistory([]); return }
    try {
      const res = await fetch(`/api/distribution/campaigns/${cid}/history`, { cache: "no-store" })
      const data = await res.json()
      setHistory(Array.isArray(data.rows) ? (data.rows as RunHistoryRow[]) : [])
    } catch { setHistory([]) }
  }, [])

  const loadSourceColumns = async () => {
    // Proc source maps FROM the stage/upload target table; view maps FROM the view.
    const readFrom =
      sourceLoadFrom.trim() || (sourceKind === "proc" ? targetTable.trim() : sourceObject.trim())
    if (!readFrom) { setColsMsg(sourceKind === "proc" ? "Set the Upload target (table or view) below first, or a Load from object." : "Enter the view name first."); return }
    setColsLoading(true); setColsMsg(null); setColsNote(null)
    try {
      const [h, v] = await Promise.all([
        fetch("/api/distribution/columns?object=hll").then((r) => r.json()),
        fetch(`/api/distribution/columns?object=${encodeURIComponent(readFrom)}`).then((r) => r.json()),
      ])
      if (h.error) throw new Error(`HLL: ${h.error}`)
      if (v.error) throw new Error(`Source: ${v.error}`)
      const hc = h.columns ?? []
      const vc = v.columns ?? []
      if (!vc.length) throw new Error("No columns found on the source (check name / grants).")
      setHllCols(hc); setViewCols(vc)
      // Built synchronously rather than in a setState updater: the updater runs
      // during a later render, so anything it collects is not available to the
      // lines below it. This is a click handler, so the current state is the
      // current render's state.
      const stale: string[] = []
      {
        const next = { ...sourceMapping }
        // These HLL columns are auto-filled (campaign id / today / today+N) —
        // never map them from a source column (drop any stale entries too).
        const AUTO = ["CAMPAIGNID", "CREATEDONDATE", "LEADEXPIRY", "BATCHNAME"]
        for (const a of AUTO) delete next[a]

        // Drop entries whose SOURCE column is not on this object. A mapping is
        // saved against the object it was built from and outlives it, so
        // repointing a config at another view leaves the old one's columns
        // behind. Matching by name below cannot clear them — it skips anything
        // already mapped — so this ran as a pure add and a stale entry survived
        // every attempt to fix it from here, then failed the INSERT with
        // "invalid identifier". An entry naming a column that does not exist has
        // no other outcome available to it, so there is nothing to preserve.
        const srcNames = new Set(vc.map((s: { name: string }) => s.name.toUpperCase()))
        for (const [hcol, scol] of Object.entries(next)) {
          if (!srcNames.has(String(scol).toUpperCase())) { stale.push(`${hcol} ← ${scol}`); delete next[hcol] }
        }

        for (const hcol of hc) {
          if (AUTO.includes(hcol.name.toUpperCase())) continue
          if (next[hcol.name]) continue
          const hit = vc.find((s: { name: string }) => s.name.toLowerCase() === hcol.name.toLowerCase())
          if (hit) next[hcol.name] = hit.name
        }
        setSourceMapping(next)
      }
      // Say so — a mapping silently changing under you is worse than the error.
      if (stale.length > 0) {
        setColsNote(
          `Dropped ${stale.length} stale mapping${stale.length === 1 ? "" : "s"} — ` +
            `${stale.join(", ")} — because ${stale.length === 1 ? "that column is" : "those columns are"} ` +
            `not on ${readFrom}. Save to keep this.`
        )
      }
    } catch (e) {
      setColsMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setColsLoading(false)
    }
  }
  const setSrcMap = (hllCol: string, viewCol: string) =>
    setSourceMapping((m) => {
      const next = { ...m }
      if (viewCol === "__none__") delete next[hllCol]
      else next[hllCol] = viewCol
      return next
    })
  const [configLoading, setConfigLoading] = useState(false)
  const [configExists, setConfigExists] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // New-procedure input for the per-campaign update-HLL list.
  const [newHllProc, setNewHllProc] = useState("")
  const PROC_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\s*\([A-Za-z0-9_,\s]*\))?$/
  const addHllProc = () => {
    const p = newHllProc.trim()
    if (!p) return
    if (!PROC_RE.test(p)) { toast.error('Procedure must be "DATABASE.SCHEMA.PROC" with optional (args), e.g. DB.SCHEMA.SP(608)'); return }
    if (updateHllProcs.includes(p)) { setNewHllProc(""); return }
    setUpdateHllProcs((prev) => [...prev, p])
    setNewHllProc("")
  }
  // One-click import from the old shared TSK_HLL_UPDATE_PROCEDURES list, so the
  // procedures that used to live there can be pulled into this campaign's list.
  const importLegacyProcs = async () => {
    try {
      const res = await fetch("/api/hll-procedures", { cache: "no-store" })
      const data = await res.json()
      const names = ((data.rows as { PROC_NAME: string }[]) || []).map((r) => r.PROC_NAME).filter(Boolean)
      if (!names.length) { toast("No procedures found in the old shared list to import."); return }
      let added = 0
      setUpdateHllProcs((prev) => {
        const merged = [...prev]
        for (const n of names) if (!merged.includes(n)) { merged.push(n); added++ }
        return merged
      })
      toast.success(`Imported ${added} procedure(s) from the shared list — review, then Save.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

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

  const resetForm = useCallback(() => {
    setLeadSource("file")
    setHost("")
    setPort("22")
    setUsername("")
    setAuthType("password")
    setPassword("")
    setPrivateKey("")
    setRemotePath("")
    setTargetTable("")
    setLoadHistoryProc("")
    setUpdateHllProcs([])
    setSyncProcedure("")
    setSyncSourceView(""); setSyncTargetTable(""); setSyncColumns(""); setSyncBatch("10000")
    setSourceKind("none")
    setSourceObject("")
    setSourceLoadFrom("")
    setSourceMapping({})
    setLeadExpiryDays("45")
    setBatchTemplate("BATCH_ONAIR_ULTRA5{date}")
    setHllCols([]); setViewCols([]); setColsMsg(null)
    setIsActive(true)
    setConfigExists(false)
    setRunSteps([])
    setLastRunAt(null); setLastRunStatus(null); setLastRunMessage(null)
  }, [])

  // Fill the whole form from a config row.
  const loadConfigIntoForm = useCallback((c: CampaignConfig) => {
    setConfigId(c.CONFIG_ID != null ? Number(c.CONFIG_ID) : null)
    setConfigName(c.CONFIG_NAME ?? "Automation")
    setLeadSource((c.LEAD_SOURCE as "file" | "sftp" | "snowflake") || "file")
    setHost(c.SFTP_HOST ?? "")
    setPort(c.SFTP_PORT != null ? String(c.SFTP_PORT) : "22")
    setUsername(c.SFTP_USERNAME ?? "")
    setAuthType(c.SFTP_AUTH_TYPE === "privateKey" ? "privateKey" : "password")
    setPassword(c.SFTP_PASSWORD ?? "")
    setPrivateKey(c.SFTP_PRIVATE_KEY ?? "")
    setRemotePath(c.SFTP_REMOTE_PATH ?? "")
    setTargetTable(c.UPLOAD_TARGET_TABLE ?? "")
    setLoadHistoryProc(c.LOAD_HISTORY_PROCEDURE ?? "")
    try {
      const arr = c.UPDATE_HLL_PROCEDURES ? JSON.parse(c.UPDATE_HLL_PROCEDURES) : null
      if (Array.isArray(arr) && arr.length) setUpdateHllProcs(arr.map((s: unknown) => String(s)))
      else setUpdateHllProcs(c.UPDATE_HLL_PROCEDURE ? [c.UPDATE_HLL_PROCEDURE] : [])
    } catch { setUpdateHllProcs(c.UPDATE_HLL_PROCEDURE ? [c.UPDATE_HLL_PROCEDURE] : []) }
    setSyncProcedure(c.SYNC_PROCEDURE ?? "")
    setSyncSourceView(c.SYNC_SOURCE_VIEW ?? "")
    setSyncTargetTable(c.SYNC_TARGET_TABLE ?? "")
    setSyncColumns(c.SYNC_COLUMNS ?? "")
    setSyncBatch(c.SYNC_BATCH_SIZE != null ? String(c.SYNC_BATCH_SIZE) : "10000")
    setSourceKind((c.SOURCE_KIND as "none" | "proc" | "view") || "none")
    setSourceObject(c.SOURCE_OBJECT ?? "")
    setSourceLoadFrom(c.SOURCE_LOAD_FROM ?? "")
    try {
      const parsedMap = c.SOURCE_MAPPING_JSON ? JSON.parse(c.SOURCE_MAPPING_JSON) : {}
      for (const a of ["CAMPAIGNID", "CREATEDONDATE", "LEADEXPIRY", "BATCHNAME"]) delete parsedMap[a]
      setSourceMapping(parsedMap)
    } catch { setSourceMapping({}) }
    setLeadExpiryDays(c.LEAD_EXPIRY_DAYS != null ? String(c.LEAD_EXPIRY_DAYS) : "45")
    setBatchTemplate(c.BATCH_NAME_TEMPLATE ?? "BATCH_ONAIR_ULTRA5{date}")
    setHllCols([]); setViewCols([]); setColsMsg(null)
    setIsActive(c.IS_ACTIVE !== false)
    setRunSteps([])
    setLastRunAt(c.LAST_RUN_AT ?? null)
    setLastRunStatus(c.LAST_RUN_STATUS ?? null)
    setLastRunMessage(c.LAST_RUN_MESSAGE ?? null)
    setConfigExists(c.CONFIG_ID != null)
    setSettingsOpen(true)
    // Everything above is now the saved state; snapshot it next render.
    wantRunSnapshot.current = true
  }, [])

  // Load all configs for a campaign; select one (default first / "last" / by id).
  const loadConfigs = useCallback(async (cid: string, selectId?: number | "last") => {
    setConfigLoading(true); setLoadError(null)
    try {
      const res = await fetch(`/api/campaign-configs?campaignId=${cid}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load configs (${res.status})`)
      const list = (data.configs as CampaignConfig[]) || []
      setConfigs(list)
      if (list.length === 0) {
        // No configs — start a fresh, unsaved one.
        resetForm(); setConfigId(null); setConfigName("Automation 1"); setSettingsOpen(true); setHistory([])
        return
      }
      let pick = list[0]
      if (selectId === "last") pick = list[list.length - 1]
      else if (typeof selectId === "number") pick = list.find((c) => Number(c.CONFIG_ID) === selectId) ?? list[0]
      loadConfigIntoForm(pick)
      loadHistory(cid)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfigLoading(false)
    }
  }, [loadConfigIntoForm, resetForm, loadHistory])

  // Reload configs when the campaign changes.
  useEffect(() => {
    if (!campaignId) { setConfigs([]); resetForm(); setConfigId(null); setHistory([]); setLoadError(null); return }
    loadConfigs(campaignId)
  }, [campaignId, loadConfigs, resetForm])

  // "New automation" button — a blank, unsaved config.
  const startNewAutomation = () => {
    resetForm()
    setConfigId(null)
    setConfigName(`Automation ${configs.length + 1}`)
    setSettingsOpen(true)
    setHistory([])
  }

  const handleSave = async () => {
    if (!campaignId) return
    setSaving(true)
    try {
      const res = await fetch("/api/campaign-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configId, name: configName || "Automation",
          campaignId, campaignTitle: selectedCampaign?.title ?? null,
          leadSource,
          sftpHost: host, sftpPort: port, sftpUsername: username, sftpAuthType: authType,
          sftpPassword: password, sftpPrivateKey: privateKey, sftpRemotePath: remotePath,
          uploadTargetTable: targetTable, loadHistoryProcedure: "",
          updateHllProcedures: updateHllProcs, syncProcedure,
          syncSourceView, syncTargetTable, syncColumns, syncBatchSize: syncBatch,
          sourceKind, sourceObject, sourceLoadFrom, sourceMapping,
          leadExpiryDays: Number(leadExpiryDays) || 45, batchNameTemplate: batchTemplate, isActive,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      if (data.warning) toast.warning(data.warning)
      else toast.success("Automation saved")
      // Refetch and keep editing (existing id, or the newest on create).
      await loadConfigs(campaignId, configId ?? "last")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const deleteConfig = async () => {
    if (configId == null) { startNewAutomation(); return }
    if (typeof window !== "undefined" && !window.confirm("Delete this automation?")) return
    try {
      const res = await fetch(`/api/campaign-configs/${configId}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || `Delete failed (${res.status})`)
      toast.success("Automation deleted")
      await loadConfigs(campaignId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // Run the whole distribution in order: initial source → load history →
  // update HLL → sync. Stops at the first failed step.
  // Load the saved config's step plan (for the per-step Run buttons).
  useEffect(() => {
    if (configId == null) { setPlan([]); setStepState({}); return }
    let cancelled = false
    fetch(`/api/distribution/configs/${configId}/run/plan`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPlan(Array.isArray(d.steps) ? d.steps : []) })
      .catch(() => { if (!cancelled) setPlan([]) })
    setStepState({})
    return () => { cancelled = true }
  }, [configId])

  const runFullDistribution = async () => {
    if (configId == null) { toast.error("Save this automation before running it."); return }
    setRunning(true)
    setRunSteps([])
    try {
      const res = await runConfigStepwise(configId, setRunSteps)
      const now = new Date().toISOString().slice(0, 16).replace("T", " ")
      setLastRunAt(now)
      setLastRunStatus(res.ok ? "Success" : "Error")
      if (res.ok) toast.success(`Distribution complete — ${res.ran} step(s) ran`)
      else toast.error("Distribution failed — see steps below")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      loadHistory(campaignId) // refresh the history list with this run
    }
  }

  // Check the last fire-and-forget sync's status (for reopening later).
  const checkSyncStatus = useCallback(async (cfgId: number | null) => {
    if (cfgId == null) { setSyncBg(null); return }
    try {
      const res = await fetch(`/api/distribution/configs/${cfgId}/sync`, { cache: "no-store" })
      const d = await res.json()
      setSyncBg(d && d.status ? d : null)
    } catch { setSyncBg(null) }
  }, [])

  // Refresh background-sync status when the config changes.
  useEffect(() => { checkSyncStatus(configId) }, [configId, checkSyncStatus])

  // Run a single step of the saved config. The sync is fire-and-forget. Each
  // per-step run is logged to run history.
  const runOneStep = async (key: string) => {
    if (configId == null) { toast.error("Save this automation first."); return }
    const label = plan.find((p) => p.key === key)?.label ?? key
    setStepState((s) => ({ ...s, [key]: { status: "running" } }))
    try {
      if (key === "sync") {
        const r = await submitSyncFireAndForget(configId)
        setStepState((s) => ({ ...s, [key]: { status: r.ok ? "success" : "error", message: r.ok ? "submitted — running in the background (safe to leave this page)" : r.error } }))
        await recordStepRun(configId, label, r.ok, r.ok ? "submitted (background)" : r.error)
        if (r.ok) toast.success("Sync submitted — running in the background")
        else toast.error(r.error || "Failed to submit sync")
        return
      }
      const res = await runOneStepAt(`/api/distribution/configs/${configId}/run`, key)
      setStepState((s) => ({ ...s, [key]: { status: res.ok ? "success" : "error", message: res.error } }))
      await recordStepRun(configId, label, res.ok, res.error)
      if (res.ok) toast.success("Step complete")
      else toast.error(res.error || "Step failed")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStepState((s) => ({ ...s, [key]: { status: "error", message: msg } }))
      await recordStepRun(configId, label, false, msg)
      toast.error(msg)
    } finally {
      loadHistory(campaignId)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <SettingsIcon className="h-5 w-5 text-muted-foreground" />
          <SectionHeading>Campaign</SectionHeading>
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
      </Card>

      {selectedCampaign && (
        <Card>
          <div className="mb-1 flex items-center justify-between">
            <SectionHeading>Automation config</SectionHeading>
            {configLoading ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <Badge variant="outline" className="text-xs">
                {configExists ? "Saved" : "Not configured"}
              </Badge>
            )}
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            SFTP source, destination table, and sync procedure for the automated distribution of{" "}
            <span className="font-medium text-foreground">{selectedCampaign.title}</span>{" "}
            (campaign {selectedCampaign.id}).
          </p>

          {loadError && (
            <p className="mb-3 text-xs text-rose-400">Failed to load config: {loadError}</p>
          )}

          {/* This campaign's automations — pick one, or add a new one. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {configs.map((c) => {
              const cid = c.CONFIG_ID != null ? Number(c.CONFIG_ID) : null
              const active = cid === configId
              return (
                <button
                  key={cid ?? "row-new"}
                  type="button"
                  onClick={() => cid != null && loadConfigIntoForm(c)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs",
                    active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {c.CONFIG_NAME || "Automation"}
                  {c.IS_ACTIVE === false && <span className="ml-1 text-[10px] text-muted-foreground">(inactive)</span>}
                </button>
              )
            })}
            {configId === null && (
              <span className="rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs text-foreground">
                {configName || "New automation"} <span className="text-[10px] text-muted-foreground">(unsaved)</span>
              </span>
            )}
            <Button type="button" variant="outline" size="sm" onClick={startNewAutomation}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New automation
            </Button>
          </div>

          {/* Name + collapse + delete for the current automation. */}
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label className="mb-1.5 block text-xs text-muted-foreground">Automation name</Label>
              <Input value={configName} onChange={(e) => setConfigName(e.target.value)} placeholder="Automation" />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsOpen((o) => !o)}>
              {settingsOpen ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronRight className="mr-1 h-4 w-4" />}
              {settingsOpen ? "Collapse settings" : "Expand settings"}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-rose-400 hover:text-rose-300" onClick={deleteConfig} disabled={configId == null}>
              <Trash2 className="mr-1 h-4 w-4" /> Delete
            </Button>
          </div>

          <div className="flex flex-col gap-5">
            {settingsOpen && (<>
            <div>
              <h4 className="mb-3 text-sm font-medium text-foreground">Lead source</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">How this campaign gets its leads</Label>
                  <Select value={leadSource} onValueChange={(v) => setLeadSource(v as "file" | "sftp" | "snowflake")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="file">Upload a file (default)</SelectItem>
                      <SelectItem value="sftp">SFTP</SelectItem>
                      <SelectItem value="snowflake">Snowflake (stored proc / view)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <p className="text-xs text-muted-foreground">
                    Pre-selects the source on the Manual Distribution page.{" "}
                    {leadSource === "sftp"
                      ? "Configure the SFTP connection below."
                      : leadSource === "snowflake"
                      ? "Configure the initial source, mapping and procedures below."
                      : "Leads are uploaded as a CSV / Excel / JSON file."}
                  </p>
                </div>
              </div>
            </div>

            {leadSource === "sftp" && (<>
            <Separator />

            <div>
              <h4 className="mb-3 text-sm font-medium text-foreground">SFTP source</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Host</Label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="sftp.example.com" />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Port</Label>
                  <Input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    inputMode="numeric"
                    placeholder="22"
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Username</Label>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Auth type</Label>
                  <Select value={authType} onValueChange={(v) => setAuthType(v as "password" | "privateKey")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="password">Password</SelectItem>
                      <SelectItem value="privateKey">Private key</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {authType === "password" ? (
                  <div className="sm:col-span-2">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">Password</Label>
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                ) : (
                  <div className="sm:col-span-2">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">Private key (PEM)</Label>
                    <Textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      rows={4}
                      className="font-mono text-xs"
                    />
                  </div>
                )}
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Remote path</Label>
                  <Input
                    value={remotePath}
                    onChange={(e) => setRemotePath(e.target.value)}
                    placeholder="/incoming/campaign-files"
                  />
                </div>
              </div>
              <p className="mt-2 text-xs text-amber-400/80">
                Credentials are stored in plaintext in Snowflake. Restrict access to this table.
              </p>
            </div>
            </>)}

            {leadSource === "file" && (<>
            <Separator />

            <div>
              <h4 className="mb-1 text-sm font-medium text-foreground">Upload file to a table (Step 1)</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Where uploaded leads land before they go to the HLL. Set the staging table, then pick a file to
                preview it, create the table if needed, and <b>map the file&apos;s columns to the table&apos;s columns</b>.
                The staging table is <b>truncated before every load</b> (replaced, not appended). &ldquo;Load into
                HLL&rdquo; below then reads this table into the HLL.
              </p>
              <div className="mb-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Staging table (DB.SCHEMA.NAME)</Label>
                  <Input
                    value={targetTable}
                    onChange={(e) => setTargetTable(e.target.value)}
                    placeholder="DATABASE.SCHEMA.NAME"
                    className="font-mono text-sm"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Saved as the upload target; also prefilled below and on the Manual page.
                  </p>
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background/40 p-4">
                {campaignId ? (
                  <FileUploadMapper
                    campaignId={campaignId}
                    targetTable={targetTable}
                    onTargetTableChange={setTargetTable}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Select a campaign to upload a file.</p>
                )}
              </div>
            </div>
            </>)}

            {(leadSource === "snowflake" || leadSource === "file") && (<>
            <Separator />

            <div>
              <h4 className="mb-1 text-sm font-medium text-foreground">
                {leadSource === "file" ? "Load into HLL (Step 2)" : "Initial source (Step 1)"}
              </h4>
              <p className="mb-3 text-xs text-muted-foreground">
                {leadSource === "file" ? (
                  <>How the staged rows reach the HLL table. A <b>view or table</b> is read straight in
                  via a column mapping. A <b>procedure</b> runs first — to shape or enrich the staged
                  rows — and the mapping then reads its output into HLL.</>
                ) : (
                  <>What generates this campaign&apos;s leads at the start of a distribution. A <b>procedure</b> fills the upload
                  target table below (then &ldquo;Load into history&rdquo; moves it to HLL); a <b>view</b> is read straight
                  into the HLL table via a column mapping.</>
                )}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Source type</Label>
                  <Select value={sourceKind} onValueChange={(v) => { setSourceKind(v as "none" | "proc" | "view"); setHllCols([]); setViewCols([]); setColsMsg(null) }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— None —</SelectItem>
                      <SelectItem value="proc">
                        {leadSource === "file"
                          ? "Stored procedure → HLL"
                          : "Stored procedure → stage table"}
                      </SelectItem>
                      <SelectItem value="view">{leadSource === "file" ? "View or table → HLL" : "View → HLL (direct)"}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {sourceKind !== "none" && (
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                      {sourceKind === "proc" ? "Procedure (DB.SCHEMA.NAME, with any arguments)" : "View (DB.SCHEMA.NAME)"}
                    </Label>
                    <Input
                      value={sourceObject}
                      onChange={(e) => setSourceObject(e.target.value)}
                      placeholder={sourceKind === "proc" ? "DATABASE.SCHEMA.PROC(1)" : "DATABASE.SCHEMA.NAME"}
                      className="font-mono text-sm"
                    />
                  </div>
                )}
                {sourceKind === "proc" && (
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                      Load from — optional (DB.SCHEMA.NAME)
                    </Label>
                    <Input
                      value={sourceLoadFrom}
                      onChange={(e) => setSourceLoadFrom(e.target.value)}
                      placeholder={targetTable.trim() || "defaults to the Upload target"}
                      className="font-mono text-sm"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      What the mapping reads after the procedure has run. Leave blank to read the
                      Upload target.
                    </p>
                  </div>
                )}
              </div>
              {sourceKind === "proc" && (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Write it exactly as you would the <span className="font-mono">CALL</span>. Snowflake matches a
                    procedure on its name <em>and</em> its argument count, so one that takes an argument has to be
                    written <span className="font-mono">…NAME(1)</span> — without the argument it reports the
                    procedure as unknown rather than as wrongly called.
                  </p>
                  {leadSource === "file" ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Two steps, in this order: the procedure runs against the staged rows, then the
                      column mapping reads them into HLL. By default the mapping reads the{" "}
                      <span className="font-mono">Upload target</span> — the same staging table the
                      file landed in — so a procedure that updates it in place needs nothing else.
                      Set <span className="font-medium">Load from</span> if the procedure writes its
                      output to a different table or view.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">The procedure must populate the <span className="font-mono">Upload target</span> (a table or view) set below. Then map its columns into HLL here (or leave it to a &ldquo;Load into history&rdquo; procedure).</p>
                  )}
                </>
              )}
              {sourceKind !== "none" && (
                <div className="mt-3">
                  <div className="flex items-center gap-3">
                    <Button type="button" variant="outline" size="sm" onClick={loadSourceColumns} disabled={colsLoading}>
                      {colsLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</> : <>Load columns &amp; map {sourceKind === "proc" ? "(stage → HLL)" : "(view → HLL)"}</>}
                    </Button>
                    {/* A procedure source maps FROM the upload target, which sits two
                        sections further down — say so here rather than after a click
                        that could only fail. */}
                    {sourceKind === "proc" && !targetTable.trim() && !sourceLoadFrom.trim() && (
                      <span className="text-xs text-amber-400">
                        Set <span className="font-medium">Upload target</span> first — under
                        &ldquo;Destination &amp; sync&rdquo; below. The columns come from there, not from the
                        procedure.
                      </span>
                    )}
                    {Object.keys(sourceMapping).length > 0 && <span className="text-xs text-muted-foreground">{Object.keys(sourceMapping).length} column(s) mapped</span>}
                  </div>
                  {colsMsg && <p className="mt-2 text-xs text-rose-400">{colsMsg}</p>}
                  {colsNote && <p className="mt-2 text-xs text-amber-300">{colsNote}</p>}
                  {hllCols.length > 0 && (
                    <div className="mt-3 max-h-72 overflow-auto rounded-md border border-border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card">
                          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2 font-medium">HLL column</th>
                            <th className="px-3 py-2 font-medium">{sourceKind === "proc" ? "Upload column (table/view)" : "View column"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hllCols.map((h) => {
                            const up = h.name.toUpperCase()
                            const autoLabel =
                              up === "CAMPAIGNID" ? `= campaign id${campaignId ? ` (${campaignId})` : ""} · auto`
                              : up === "CREATEDONDATE" ? "= today · auto"
                              : up === "LEADEXPIRY" ? `= today + ${leadExpiryDays || "45"} days · auto`
                              : up === "BATCHNAME" ? `= ${batchTemplate || "BATCH…{date}"} · auto`
                              : null
                            return (
                            <tr key={h.name} className="border-t border-border/50">
                              <td className="px-3 py-1.5"><span className="font-mono text-xs text-foreground">{h.name}</span> <span className="ml-1 text-[10px] text-muted-foreground">{h.type}</span></td>
                              <td className="px-3 py-1.5">
                                {autoLabel ? (
                                  <span className="inline-flex items-center rounded bg-emerald-500/10 px-2 py-1 font-mono text-xs text-emerald-400" title="Filled automatically — not mapped from the source">
                                    {autoLabel}
                                  </span>
                                ) : (
                                  <Select value={sourceMapping[h.name] ?? "__none__"} onValueChange={(v) => setSrcMap(h.name, v)}>
                                    <SelectTrigger className="h-8 w-full"><SelectValue placeholder="— skip —" /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">— skip —</SelectItem>
                                      {viewCols.map((s) => <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                )}
                              </td>
                            </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Label htmlFor="lead-expiry" className="text-xs text-muted-foreground">Lead expiry (days after load)</Label>
                    <Input
                      id="lead-expiry"
                      type="number"
                      min={1}
                      max={3650}
                      value={leadExpiryDays}
                      onChange={(e) => setLeadExpiryDays(e.target.value)}
                      className="h-8 w-24 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono">LEADEXPIRY</span> = today + this many days. Default 45.
                    </span>
                  </div>
                  <div className="mt-3">
                    <Label htmlFor="batch-name" className="text-xs text-muted-foreground">Batch name</Label>
                    <Input
                      id="batch-name"
                      value={batchTemplate}
                      onChange={(e) => setBatchTemplate(e.target.value)}
                      placeholder="BATCH_ONAIR_ULTRA5{date}"
                      className="mt-1 font-mono text-sm"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-mono">{"{date}"}</span> is today,{" "}
                      <span className="font-mono">{"{expiry}"}</span> is today + the lead-expiry days
                      above — both YYYYMMDD. Example today:{" "}
                      <span className="font-mono text-foreground">
                        {(() => {
                          const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "")
                          const today = new Date()
                          const exp = new Date(today)
                          exp.setDate(exp.getDate() + (Number(leadExpiryDays) || 45))
                          return (
                            (batchTemplate || "")
                              .split("{date}").join(ymd(today))
                              .split("{expiry}").join(ymd(exp)) || "—"
                          )
                        })()}
                      </span>
                    </p>
                  </div>
                </div>
              )}
            </div>

            <Separator />

            <div>
              <h4 className="mb-3 text-sm font-medium text-foreground">Destination &amp; sync</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                {leadSource !== "file" && (
                  <div>
                    <Label className="mb-1.5 block text-xs text-muted-foreground">Upload target (table or view)</Label>
                    <Input
                      value={targetTable}
                      onChange={(e) => setTargetTable(e.target.value)}
                      placeholder="DATABASE.SCHEMA.NAME"
                      className="font-mono text-sm"
                    />
                  </div>
                )}
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">
                    Update HLL procedures{updateHllProcs.length > 0 && <span className="text-muted-foreground/70"> · {updateHllProcs.length}</span>}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={newHllProc}
                      onChange={(e) => setNewHllProc(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHllProc() } }}
                      placeholder="DATABASE.SCHEMA.SP_NAME(608)"
                      className="font-mono text-sm"
                    />
                    <Button type="button" variant="outline" onClick={addHllProc}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add
                    </Button>
                    <Button type="button" variant="ghost" onClick={importLegacyProcs} title="Pull procedures from the old shared list">
                      Import old list
                    </Button>
                  </div>
                  {updateHllProcs.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      None yet — add the update-HLL procedures to run for <span className="font-medium text-foreground">this campaign</span>, in order.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col divide-y divide-border/60 rounded-md border border-border">
                      {updateHllProcs.map((p, i) => (
                        <li key={`${p}-${i}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                          <span className="font-mono text-xs text-foreground">
                            <span className="mr-2 text-muted-foreground">{i + 1}.</span>{p}
                          </span>
                          <button
                            type="button"
                            className="text-xs text-rose-400 hover:text-rose-300"
                            onClick={() => setUpdateHllProcs((prev) => prev.filter((_, idx) => idx !== i))}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Specific to this campaign. In the run they execute in this order (Step 4). Include any argument, e.g. <span className="font-mono">…SP_X(608)</span>.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Sync procedure</Label>
                  <Input
                    value={syncProcedure}
                    onChange={(e) => setSyncProcedure(e.target.value)}
                    placeholder="DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE"
                    className="font-mono text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    If a <span className="font-medium text-foreground">source view</span> is set below, the sync runs
                    <span className="font-mono"> CALL proc(&apos;view&apos;, &apos;target&apos;, &apos;columns&apos;, batch)</span>. Otherwise the procedure is called on its own.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Sync source view <span className="text-emerald-400">(interchangeable)</span></Label>
                  <Input
                    value={syncSourceView}
                    onChange={(e) => setSyncSourceView(e.target.value)}
                    placeholder="DATAWAREHOUSE.DISTRIBUTION.VW_ONAIR_ULTRA_COMBINED_SS_adhoc"
                    className="font-mono text-sm"
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Sync target table</Label>
                  <Input
                    value={syncTargetTable}
                    onChange={(e) => setSyncTargetTable(e.target.value)}
                    placeholder="Upload.TempUpload"
                    className="font-mono text-sm"
                  />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Batch size</Label>
                  <Input
                    type="number"
                    min={1}
                    value={syncBatch}
                    onChange={(e) => setSyncBatch(e.target.value)}
                    placeholder="10000"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs text-muted-foreground">Sync columns (comma-separated)</Label>
                  <Textarea
                    value={syncColumns}
                    onChange={(e) => setSyncColumns(e.target.value)}
                    placeholder="CustomerCode,CampaignId,IdNumber,CellNumber,…"
                    rows={3}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            </div>
            </>)}

            <Separator />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch checked={isActive} onCheckedChange={setIsActive} id="config-active" />
                <Label htmlFor="config-active" className="text-sm text-foreground">
                  Automation active
                </Label>
              </div>
              <Button onClick={handleSave} disabled={saving || configLoading}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save automation
              </Button>
            </div>
            </>)}

            <Separator />

            {/* Run the whole distribution end-to-end. */}
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">Run full distribution</div>
                  <div className="text-xs text-muted-foreground">
                    {leadSource === "file"
                      ? "Upload the file first, then run: Load into HLL → Update HLL → Sync. Runs in order and stops at the first failure."
                      : "Initial source → Load into history → Update HLL → Sync. Runs in order and stops at the first failure."}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {lastRunAt && (
                    <span className="text-xs text-muted-foreground" title={lastRunMessage ?? undefined}>
                      Last run{" "}
                      <span className={lastRunStatus === "Success" ? "text-emerald-400" : "text-rose-400"}>
                        {lastRunStatus ?? "—"}
                      </span>{" "}
                      · {lastRunAt}
                    </span>
                  )}
                  <Button
                    variant="secondary"
                    onClick={runFullDistribution}
                    disabled={running || saving || configLoading || !configExists}
                    title={!configExists ? "Save this automation first" : undefined}
                  >
                    {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                    {running ? "Running…" : "Run full distribution"}
                  </Button>
                </div>
              </div>

              {!configExists && (
                <p className="mt-2 text-xs text-amber-400">Save this automation before running.</p>
              )}

              <p className="mt-2 text-xs text-muted-foreground">
                The <span className="font-medium text-foreground">Sync</span> step is fire-and-forget — it&apos;s submitted to
                Snowflake and keeps running even if you close or leave this page.
              </p>

              {/* Background sync status (reopen and check). */}
              {configExists && syncBg && syncBg.status !== "none" && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Background sync:</span>
                  <span className={
                    syncBg.status === "done" ? "font-medium text-emerald-400"
                    : syncBg.status === "error" ? "font-medium text-rose-400"
                    : "font-medium text-sky-400"
                  }>
                    {syncBg.status === "running" ? "still running…" : syncBg.status}
                  </span>
                  {syncBg.at && <span className="text-muted-foreground">· started {syncBg.at}</span>}
                  {syncBg.finishedAt && <span className="text-muted-foreground">· finished {syncBg.finishedAt}</span>}
                  {syncBg.status === "error" && syncBg.error && <span className="text-rose-400">· {syncBg.error}</span>}
                  <Button type="button" variant="ghost" size="sm" onClick={() => checkSyncStatus(configId)}>Refresh</Button>
                </div>
              )}

              {/* Run each step individually (uses the last saved config). */}
              {configExists && plan.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Run individual steps</div>
                  {runDirty && (
                    <Banner tone="warning" className="mb-2 flex-wrap px-3 py-2">
                      <span>
                        You have unsaved changes. Running uses the{" "}
                        <span className="font-medium">saved</span> config, so these edits won&apos;t apply
                        until you save.
                      </span>
                      <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                        Save now
                      </Button>
                    </Banner>
                  )}
                  <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
                    {plan.map((s) => {
                      const st = stepState[s.key]
                      return (
                        <li key={s.key} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                          <span className="flex items-center gap-2">
                            {st ? <StepStatusIcon status={st.status} /> : <span className="h-4 w-4" />}
                            <span className="text-foreground">{s.label}</span>
                            {st?.status === "error" && st.message && <span className="whitespace-pre-wrap text-rose-400">— {st.message}</span>}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={running || st?.status === "running"}
                            onClick={() => runOneStep(s.key)}
                          >
                            {st?.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Run"}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">Runs against the last <span className="font-medium text-foreground">saved</span> config. Save after edits before running a step.</p>
                </div>
              )}

              {runSteps.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {runSteps.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <StepStatusIcon status={r.status} />
                      <span className="font-medium text-foreground">{r.step}:</span>
                      <span className="whitespace-pre-wrap text-muted-foreground">{r.status === "running" ? "running…" : r.message}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Final step — download the distributed data. */}
              {campaignId && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">Download data</div>
                    <div className="text-xs text-muted-foreground">
                      Today&apos;s distributed leads for campaign {campaignId} — CXM format (CSV, UTF-8, no BOM).
                    </div>
                  </div>
                  <Button variant="outline" asChild>
                    <a href={`/api/distribution/export?campaignId=${campaignId}`}>
                      <Download className="mr-2 h-4 w-4" /> Download data (CSV)
                    </a>
                  </Button>
                </div>
              )}

              {campaignId && (
                <div className="mt-3 rounded-md border border-border bg-background/40 p-3">
                  {/* No number: the list above is this config's steps, of which
                      there may be any number, so a fixed "5" named nothing. */}
                  <EmailExportStep campaignId={campaignId} />
                </div>
              )}

              {/* Run history — one row per completed run of this campaign. */}
              <div className="mt-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Run history</div>
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No runs recorded yet.</p>
                ) : (
                  <div className="max-h-56 overflow-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">When</th>
                          <th className="px-3 py-2 font-medium">Automation</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Steps</th>
                          <th className="px-3 py-2 font-medium">Detail</th>
                          <th className="px-3 py-2 font-medium">By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((h) => (
                          <tr key={h.ID} className="border-t border-border/50 align-top">
                            <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{h.CREATED_AT ?? "—"}</td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-foreground">{h.CONFIG_NAME ?? "—"}</td>
                            <td className="px-3 py-1.5">
                              <span className={h.STATUS === "Success" ? "font-medium text-emerald-400" : "font-medium text-rose-400"}>{h.STATUS ?? "—"}</span>
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground">{h.RAN ?? 0}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{h.SUMMARY ?? ""}</td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{h.CREATED_BY ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}
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
  const [activeNav, setActiveNav] = useState("manual")

  const renderContent = useCallback(() => {
    switch (activeNav) {
      case "manual":
        return <ManualContent />
      case "automation":
        return <AutomationContent />
      case "extend-expired":
        return <ExtendExpiredContent />
      case "daily-files":
        return <DailyFilesContent />
      case "temp-upload":
        return <TempUploadContent />
      case "recycle":
        return <RecycleContent />
      case "forecasting":
        return <ForecastingContent />
      case "settings":
        return <SettingsContent />
      default:
        return <ManualContent />
    }
  }, [activeNav])

  return (
    <DepartmentShell
      brand={{ icon: <Truck />, label: "Distribution" }}
      nav={[{ id: "options", label: "Options", items: navItems }]}
      activeId={activeNav}
      onNavigate={setActiveNav}
      onBack={onBack}
    >
      {renderContent()}
    </DepartmentShell>
  )
}
