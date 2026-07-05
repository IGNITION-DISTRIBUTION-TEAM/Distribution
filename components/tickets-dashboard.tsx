"use client"

import { useState, useCallback, useEffect } from "react"
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  ListTodo,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  Ticket as TicketIcon,
  Trash2,
} from "lucide-react"
import {
  TICKET_STATUSES,
  FIELD_KEY_RE,
  validateFormConfig,
  type TicketField,
  type TicketFieldType,
  type TicketFormConfig,
  type TicketRow,
} from "@/lib/tickets-shared"

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

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{message}</span>
    </div>
  )
}

/* ------------------------------- Log a ticket ------------------------------ */

function LogTicketContent() {
  const [config, setConfig] = useState<TicketFormConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [createdRef, setCreatedRef] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/tickets/form-config")
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Could not load the ticket form")
        setConfig(data.config)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  const setAnswer = (key: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [key]: value }))

  const submit = useCallback(async () => {
    if (!config) return
    setSubmitting(true)
    setSubmitError(null)
    setCreatedRef(null)
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`)
      setCreatedRef(data.ticketRef)
      setAnswers({})
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [answers, config])

  if (loadError) return <ErrorBox message={loadError} />
  if (!config) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading form…
      </div>
    )
  }

  const fields = config.fields.filter((f) => f.active)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Log a ticket</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Submit a request to the tickets team. Your name and email are attached automatically.
        </p>
      </div>

      {createdRef && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-medium">
              Ticket <span className="font-mono">{createdRef}</span> logged
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6">
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {field.label}
              {field.required && <span className="ml-1 text-rose-400">*</span>}
            </label>
            {field.type === "textarea" ? (
              <textarea
                className={textareaCls}
                value={answers[field.key] ?? ""}
                onChange={(e) => setAnswer(field.key, e.target.value)}
              />
            ) : field.type === "select" ? (
              <select
                className={inputCls}
                value={answers[field.key] ?? ""}
                onChange={(e) => setAnswer(field.key, e.target.value)}
              >
                <option value="">Select…</option>
                {(field.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : field.type === "yesno" ? (
              <select
                className={inputCls}
                value={answers[field.key] ?? ""}
                onChange={(e) => setAnswer(field.key, e.target.value)}
              >
                <option value="">Select…</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            ) : (
              <input
                type={field.type === "date" ? "date" : "text"}
                className={inputCls}
                value={answers[field.key] ?? ""}
                onChange={(e) => setAnswer(field.key, e.target.value)}
              />
            )}
          </div>
        ))}

        {submitError && <ErrorBox message={submitError} />}

        <div>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" /> Submit ticket
              </>
            )}
          </Button>
        </div>
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

          {error && <ErrorBox message={error} />}

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
        <h2 className="text-2xl font-semibold text-foreground">All tickets</h2>
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

      {error && <ErrorBox message={error} />}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Ref</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Requestor</th>
              <th className="px-3 py-2 font-medium">Request type</th>
              <th className="px-3 py-2 font-medium">Urgency</th>
              <th className="px-3 py-2 font-medium">SLA due</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No tickets found.
                </td>
              </tr>
            ) : (
              visible.map((t) => (
                <tr
                  key={t.ticketId}
                  onClick={() => setSelected(t)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <td className="px-3 py-2 font-mono text-xs text-foreground">{t.ticketRef}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.createdAt ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {t.createdByName || t.createdByEmail || "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{t.requestType ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.urgency ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={t.overdue ? "font-medium text-rose-300" : "text-muted-foreground"}>
                      {t.slaDueAt ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={statusBadgeCls(t.status)}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{t.assignedTo ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
  byWeek: { label: string; count: number }[]
}

function CountTable({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-4 text-center text-muted-foreground">No data yet.</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.label} className="border-b border-border last:border-0">
                <td className="px-4 py-2 text-foreground">{r.label}</td>
                <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                  {r.count.toLocaleString()}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
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

  if (error) return <ErrorBox message={error} />
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
          <h2 className="text-2xl font-semibold text-foreground">Reporting</h2>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <CountTable title="By status" rows={data.byStatus} />
        <CountTable title="By urgency" rows={data.byUrgency} />
        <CountTable title="By request type" rows={data.byType} />
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
        <h2 className="text-2xl font-semibold text-foreground">Customize form</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Change the fields shown on the &quot;Log a ticket&quot; page. Changes apply to new
          tickets immediately; existing tickets keep the answers they were logged with.
        </p>
      </div>

      {error && <ErrorBox message={error} />}
      {saved && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300">
          <CheckCircle2 className="h-4 w-4" /> Form saved.
        </div>
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
  const { user, logout } = useAuth()
  const [activeNav, setActiveNav] = useState("log")

  const navItems = [
    { id: "log", label: "Log a ticket", icon: <Plus className="h-4 w-4" /> },
    { id: "tickets", label: "All tickets", icon: <ListTodo className="h-4 w-4" /> },
    { id: "reporting", label: "Reporting", icon: <BarChart3 className="h-4 w-4" /> },
    ...(user?.isSuperAdmin
      ? [{ id: "customize", label: "Customize form", icon: <Settings2 className="h-4 w-4" /> }]
      : []),
  ]

  const renderContent = () => {
    switch (activeNav) {
      case "tickets":
        return <TicketsListContent />
      case "reporting":
        return <ReportingContent />
      case "customize":
        return user?.isSuperAdmin ? <CustomizeFormContent /> : <LogTicketContent />
      default:
        return <LogTicketContent />
    }
  }

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <TicketIcon className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">Tickets</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Tickets</SidebarGroupLabel>
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
                <ArrowLeft className="mr-2 h-4 w-4" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" />
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
            <span className="text-sm font-medium text-muted-foreground">Tickets Department</span>
          </div>
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
        </header>

        <main className="flex-1 overflow-auto min-w-0">
          <div className="min-w-0 p-6">{renderContent()}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
