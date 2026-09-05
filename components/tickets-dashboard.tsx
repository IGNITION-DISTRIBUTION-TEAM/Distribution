"use client"

import { useState, useCallback, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { DepartmentShell } from "@/components/department-shell"
import { Banner } from "@/components/kit/banner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ArrowDown, ArrowUp, BarChart3, Building2, CheckCircle2, Link as LinkIcon, ListTodo, Loader2, Paperclip, Plus, RefreshCw, Settings2, Ticket as TicketIcon, Trash2 } from "lucide-react"
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts"
import { TicketForm } from "@/components/ticket-form"
import {
  TICKET_STATUSES,
  FIELD_KEY_RE,
  validateFormConfig,
  type TicketDepartment,
  type TicketField,
  type TicketFieldType,
  type TicketFormConfig,
  type TicketRow,
} from "@/lib/tickets-shared"
import { PageHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
const textareaCls =
  "min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"

function statusBadgeCls(status: string): string {
  switch (status) {
    case "Received":
      return "border-sky-500/30 bg-sky-500/10 text-sky-300"
    case "In Progress":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200"
    case "On Hold":
      return "border-slate-500/30 bg-slate-500/10 text-slate-300"
    case "Completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    case "Rejected":
      return "border-rose-500/30 bg-rose-500/10 text-rose-300"
    default:
      return "border-border bg-muted text-muted-foreground"
  }
}


/* ------------------------------- Log a ticket ------------------------------ */

function LogTicketContent() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <PageHeading>Log a ticket</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Submit a request to the tickets team. Your name and email are attached automatically.
        </p>
      </div>
      <TicketForm />
    </div>
  )
}

/* ------------------------------- Departments ------------------------------- */

function DepartmentsContent() {
  const [departments, setDepartments] = useState<TicketDepartment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/tickets/departments")
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`)
      setDepartments(data.departments ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const add = async () => {
    if (!newName.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/tickets/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Add failed (${res.status})`)
      setNewName("")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (slug: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/tickets/departments?slug=${encodeURIComponent(slug)}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const captureUrl = (slug: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/tickets/log/${slug}`

  const copy = async (slug: string) => {
    try {
      await navigator.clipboard.writeText(captureUrl(slug))
      setCopiedSlug(slug)
      setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 2000)
    } catch {
      setError("Could not copy — select the link text and copy it manually.")
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <PageHeading>Departments</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Business departments that log tickets. Each gets its own capture link — share it with
          that team; anyone signed in can use it (no department grant needed). Removing a
          department disables its link; existing tickets are kept.
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex items-center gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="Department name, e.g. Ignition CX"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button onClick={add} disabled={busy || !newName.trim()}>
          <Plus className="mr-2 h-4 w-4" /> Add
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Capture link</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : departments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                  No departments yet. Add one above — its capture link appears here.
                </TableCell>
              </TableRow>
            ) : (
              departments.map((d) => (
                <TableRow key={d.slug}>
                  <TableCell className="font-medium text-foreground">{d.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {captureUrl(d.slug)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => copy(d.slug)}>
                      {copiedSlug === d.slug ? (
                        <>
                          <CheckCircle2 className="mr-1 h-4 w-4 text-emerald-300" /> Copied
                        </>
                      ) : (
                        <>
                          <LinkIcon className="mr-1 h-4 w-4" /> Copy link
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(d.slug)}
                      disabled={busy}
                      className="text-rose-300 hover:text-rose-200"
                    >
                      <Trash2 className="mr-1 h-4 w-4" /> Remove
                    </Button>
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

/* -------------------------------- All tickets ------------------------------ */

function TicketDetailDialog({
  ticket,
  formConfig,
  onClose,
  onSaved,
}: {
  ticket: TicketRow
  formConfig: TicketFormConfig | null
  onClose: () => void
  onSaved: () => void
}) {
  const [status, setStatus] = useState(ticket.status)
  const [assignedTo, setAssignedTo] = useState(ticket.assignedTo ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const labelFor = (key: string): string =>
    formConfig?.fields.find((f) => f.key === key)?.label ?? key

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/tickets/${ticket.ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, assignedTo }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{ticket.ticketRef}</DialogTitle>
          <DialogDescription>
            Logged by {ticket.createdByName || ticket.createdByEmail || "unknown"} on{" "}
            {ticket.createdAt ?? "—"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {Object.entries(ticket.fields).map(([key, value]) => (
            <div key={key}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {labelFor(key)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{value}</p>
            </div>
          ))}
          {ticket.attachments.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Attachments
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {ticket.attachments.map((a) => (
                  <li key={a.pathname}>
                    <a
                      href={`/api/tickets/attachments?path=${encodeURIComponent(a.pathname)}`}
                      className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                      {a.name}
                      <span className="text-xs text-muted-foreground">
                        ({(a.size / 1024).toFixed(0)} KB)
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              SLA due
            </p>
            <p className="mt-0.5 text-foreground">
              {ticket.slaDueAt ?? "—"}{" "}
              {ticket.overdue && (
                <Badge variant="outline" className="ml-1 border-rose-500/40 bg-rose-500/10 text-rose-300">
                  Overdue
                </Badge>
              )}
            </p>
          </div>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">Status</label>
              <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">Assigned to</label>
              <input
                className={inputCls}
                value={assignedTo}
                placeholder="email or name"
                onChange={(e) => setAssignedTo(e.target.value)}
              />
            </div>
          </div>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TicketsListContent() {
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState("open")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<TicketRow | null>(null)
  const [formConfig, setFormConfig] = useState<TicketFormConfig | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/tickets?status=${encodeURIComponent(statusFilter)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`)
      setTickets(data.tickets ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    fetch("/api/tickets/form-config")
      .then(async (res) => {
        const data = await res.json()
        if (res.ok) setFormConfig(data.config)
      })
      .catch(() => {
        // Labels fall back to raw keys.
      })
  }, [])

  const q = search.trim().toLowerCase()
  const visible = q
    ? tickets.filter((t) =>
        [t.ticketRef, t.createdByName, t.createdByEmail, t.requestType, t.assignedTo]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : tickets

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>All tickets</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Newest 200 tickets. Click a row to view details, change status, or assign it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="open">Open (Received / In Progress / On Hold)</option>
          <option value="all">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          placeholder="Search ref, requestor, assignee…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Requestor</TableHead>
              <TableHead>Request type</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead>SLA due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assigned to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No tickets found.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((t) => (
                <TableRow key={t.ticketId} onClick={() => setSelected(t)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <TableCell className="font-mono text-xs text-foreground">{t.ticketRef}</TableCell>
                  <TableCell className="text-muted-foreground">{t.createdAt ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.createdByName || t.createdByEmail || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.requestType ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{t.urgency ?? "—"}</TableCell>
                  <TableCell>
                    <span className={t.overdue ? "font-medium text-rose-300" : "text-muted-foreground"}>
                      {t.slaDueAt ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusBadgeCls(t.status)}>
                      {t.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.assignedTo ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {selected && (
        <TicketDetailDialog
          ticket={selected}
          formConfig={formConfig}
          onClose={() => setSelected(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}

/* --------------------------------- Reporting ------------------------------- */

type ReportData = {
  totals: { total: number; open: number; overdueOpen: number; completed: number }
  byStatus: { label: string; count: number }[]
  byUrgency: { label: string; count: number }[]
  byType: { label: string; count: number }[]
  byDepartment: { label: string; count: number }[]
  byWeek: { label: string; count: number }[]
  series: { day: string; dept: string; count: number }[]
}

// Categorical series palette (dark steps), validated against the app's card
// surface (#15181e): lightness band, chroma floor, CVD separation, contrast.
// Fixed slot order — never cycled or reassigned when series come and go.
const SERIES_COLORS = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#008300",
  "#9085e9",
  "#e66767",
  "#d55181",
  "#d95926",
]
const MAX_SERIES = SERIES_COLORS.length

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function shortDay(iso: string): string {
  const [, m, d] = iso.split("-")
  const mi = Number(m) - 1
  return `${Number(d)} ${MONTHS_SHORT[mi] ?? m}`
}

function TicketsTimeChart({ series }: { series: ReportData["series"] }) {
  // Departments ordered by 30-day volume; beyond the palette, fold into "Other".
  const totals = new Map<string, number>()
  for (const r of series) totals.set(r.dept, (totals.get(r.dept) ?? 0) + r.count)
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1])
  const kept = ranked.slice(0, ranked.length > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES).map(([d]) => d)
  const hasOther = ranked.length > kept.length
  const seriesNames = hasOther ? [...kept, "Other"] : kept

  // Zero-filled day rows for the last 30 days so lines are continuous.
  const byDay = new Map<string, Record<string, number>>()
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const pad = (n: number) => String(n).padStart(2, "0")
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    byDay.set(iso, Object.fromEntries(seriesNames.map((s) => [s, 0])))
  }
  for (const r of series) {
    const row = byDay.get(r.day)
    if (!row) continue
    const key = kept.includes(r.dept) ? r.dept : "Other"
    if (key in row) row[key] += r.count
  }
  const data = Array.from(byDay.entries()).map(([day, counts]) => ({ day, ...counts }))
  const total = ranked.reduce((s, [, n]) => s + n, 0)

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Tickets over time</h3>
        <p className="text-xs text-muted-foreground">Daily tickets by department, last 30 days</p>
      </div>
      {total === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          No tickets logged in the last 30 days.
        </p>
      ) : (
        <div className="px-2 pb-2 pt-4">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -16 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
              <XAxis
                dataKey="day"
                tickFormatter={shortDay}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                axisLine={{ stroke: "hsl(var(--border))" }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <RechartsTooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const rows = [...payload].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
                  return (
                    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
                      <p className="mb-1 font-medium text-foreground">{shortDay(String(label))}</p>
                      {rows.map((p) => (
                        <div key={String(p.dataKey)} className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-[2px]"
                            style={{ background: String(p.color) }}
                          />
                          <span className="text-muted-foreground">{String(p.dataKey)}</span>
                          <span className="ml-auto pl-3 font-mono text-foreground">
                            {Number(p.value ?? 0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                }}
              />
              <Legend
                content={() => (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2">
                    {seriesNames.map((name, i) => (
                      <span key={name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="inline-block h-2 w-2 rounded-[2px]"
                          style={{ background: SERIES_COLORS[i] }}
                        />
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              />
              {seriesNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={SERIES_COLORS[i]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function CountTable({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <Table>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell className="px-4 py-4 text-center text-muted-foreground">No data yet.</TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="px-4 text-foreground">{r.label}</TableCell>
                <TableCell className="px-4 text-right font-mono text-muted-foreground">
                  {r.count.toLocaleString()}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function ReportingContent() {
  const [data, setData] = useState<ReportData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetch("/api/tickets/report")
      .then(async (res) => {
        const d = await res.json()
        if (!res.ok) throw new Error(d.error || `Load failed (${res.status})`)
        setData(d)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <Banner tone="error">{error}</Banner>
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
      </div>
    )
  }

  const stats = [
    { label: "Total tickets", value: data.totals.total },
    { label: "Open", value: data.totals.open },
    { label: "Open & past SLA", value: data.totals.overdueOpen },
    { label: "Completed", value: data.totals.completed },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <PageHeading>Reporting</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">Ticket volumes, statuses and SLA.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {s.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      <TicketsTimeChart series={data.series ?? []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <CountTable title="By status" rows={data.byStatus} />
        <CountTable title="By urgency" rows={data.byUrgency} />
        <CountTable title="By request type" rows={data.byType} />
        <CountTable title="By department" rows={data.byDepartment} />
        <CountTable title="Created per week (last 8 weeks, week starting)" rows={data.byWeek} />
      </div>
    </div>
  )
}

/* ------------------------------ Customize form ----------------------------- */

function CustomizeFormContent() {
  const [config, setConfig] = useState<TicketFormConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/tickets/form-config")
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Could not load config")
        setConfig(data.config)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const update = (fn: (c: TicketFormConfig) => TicketFormConfig) => {
    setSaved(false)
    setConfig((prev) => (prev ? fn(structuredClone(prev)) : prev))
  }

  const setField = (i: number, patch: Partial<TicketField>) =>
    update((c) => {
      c.fields[i] = { ...c.fields[i], ...patch }
      return c
    })

  const move = (i: number, dir: -1 | 1) =>
    update((c) => {
      const j = i + dir
      if (j < 0 || j >= c.fields.length) return c
      const tmp = c.fields[i]
      c.fields[i] = c.fields[j]
      c.fields[j] = tmp
      return c
    })

  const removeField = (i: number) =>
    update((c) => {
      c.fields.splice(i, 1)
      return c
    })

  const addField = () =>
    update((c) => {
      let n = c.fields.length + 1
      while (c.fields.some((f) => f.key === `field${n}`)) n++
      c.fields.push({
        key: `field${n}`,
        label: "New field",
        type: "text",
        required: false,
        active: true,
      })
      return c
    })

  const save = async () => {
    if (!config) return
    const problem = validateFormConfig(config)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/tickets/form-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!config && !error) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading config…
      </div>
    )
  }

  const urgencyField = config?.fields.find((f) => f.key === "urgency")

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <PageHeading>Customize form</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Change the fields shown on the &quot;Log a ticket&quot; page. Changes apply to new
          tickets immediately; existing tickets keep the answers they were logged with.
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {saved && (
        <Banner tone="success">Form saved.</Banner>
      )}

      {config && (
        <>
          <div className="flex flex-col gap-3">
            {config.fields.map((field, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Label</label>
                    <input
                      className={inputCls}
                      value={field.label}
                      onChange={(e) => setField(i, { label: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Key (stored name)</label>
                    <input
                      className={`${inputCls} font-mono ${
                        FIELD_KEY_RE.test(field.key) ? "" : "border-rose-500/60"
                      }`}
                      value={field.key}
                      onChange={(e) => setField(i, { key: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">Type</label>
                    <select
                      className={inputCls}
                      value={field.type}
                      onChange={(e) => {
                        const type = e.target.value as TicketFieldType
                        setField(i, {
                          type,
                          options:
                            type === "select" ? field.options ?? ["Option 1"] : undefined,
                        })
                      }}
                    >
                      <option value="text">Text</option>
                      <option value="textarea">Long text</option>
                      <option value="select">Dropdown</option>
                      <option value="date">Date</option>
                      <option value="yesno">Yes / No</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-3 pb-1">
                    <label className="flex items-center gap-1.5 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) => setField(i, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <label className="flex items-center gap-1.5 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={field.active}
                        onChange={(e) => setField(i, { active: e.target.checked })}
                      />
                      Active
                    </label>
                  </div>
                </div>

                {field.type === "select" && (
                  <div className="mt-3 flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">
                      Options (one per line)
                    </label>
                    <textarea
                      className={textareaCls}
                      value={(field.options ?? []).join("\n")}
                      onChange={(e) =>
                        setField(i, {
                          options: e.target.value
                            .split("\n")
                            .map((o) => o.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                )}

                <div className="mt-3 flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => move(i, 1)}
                    disabled={i === config.fields.length - 1}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeField(i)}
                    className="text-rose-300 hover:text-rose-200"
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div>
            <Button variant="outline" onClick={addField}>
              <Plus className="mr-2 h-4 w-4" /> Add field
            </Button>
          </div>

          {urgencyField?.options && urgencyField.options.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">SLA hours by urgency</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                When a ticket is logged, its SLA due time = created time + these hours for the
                selected urgency. Leave blank for no SLA.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {urgencyField.options.map((opt) => (
                  <div key={opt} className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">{opt}</label>
                    <input
                      type="number"
                      min={1}
                      className={inputCls}
                      value={config.slaHoursByUrgency[opt] ?? ""}
                      onChange={(e) =>
                        update((c) => {
                          const v = Number(e.target.value)
                          if (e.target.value === "" || !Number.isFinite(v) || v <= 0) {
                            delete c.slaHoursByUrgency[opt]
                          } else {
                            c.slaHoursByUrgency[opt] = v
                          }
                          return c
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save form
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/* --------------------------------- Dashboard ------------------------------- */

export function TicketsDashboard({ onBack }: { onBack?: () => void }) {
  const { user } = useAuth()
  const [activeNav, setActiveNav] = useState("log")

  const navItems = [
    { id: "log", label: "Log a ticket", icon: <Plus className="h-4 w-4" /> },
    { id: "tickets", label: "All tickets", icon: <ListTodo className="h-4 w-4" /> },
    { id: "reporting", label: "Reporting", icon: <BarChart3 className="h-4 w-4" /> },
    { id: "departments", label: "Departments", icon: <Building2 className="h-4 w-4" />, adminOnly: true },
    { id: "customize", label: "Customize form", icon: <Settings2 className="h-4 w-4" />, adminOnly: true },
  ]

  const renderContent = () => {
    switch (activeNav) {
      case "tickets":
        return <TicketsListContent />
      case "reporting":
        return <ReportingContent />
      case "departments":
        return user?.isSuperAdmin ? <DepartmentsContent /> : <LogTicketContent />
      case "customize":
        return user?.isSuperAdmin ? <CustomizeFormContent /> : <LogTicketContent />
      default:
        return <LogTicketContent />
    }
  }

  return (
    <DepartmentShell
      brand={{ icon: <TicketIcon />, label: "Tickets" }}
      nav={[{ id: "tickets", label: "Tickets", items: navItems }]}
      activeId={activeNav}
      onNavigate={setActiveNav}
      onBack={onBack}
    >
      {renderContent()}
    </DepartmentShell>
  )
}
