"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { AlertCircle, CheckCircle2, Loader2, Paperclip, Plus, X } from "lucide-react"
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_EXTENSIONS,
  type TicketDepartment,
  type TicketFormConfig,
} from "@/lib/tickets-shared"

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
const textareaCls =
  "min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"

// The ticket capture form, driven by the saved form config. When a managed
// department list exists, the "department" field becomes a dropdown of those
// departments — or a fixed value when `lockedDepartment` is set (used by the
// per-department capture links at /tickets/log/<slug>).
// `collectIdentity` adds "Your name" / "Your email" inputs for anonymous
// (not-signed-in) visitors — the capture links are public.
export function TicketForm({
  lockedDepartment,
  collectIdentity,
}: {
  lockedDepartment?: string
  collectIdentity?: boolean
}) {
  const [config, setConfig] = useState<TicketFormConfig | null>(null)
  const [departments, setDepartments] = useState<TicketDepartment[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [requestorName, setRequestorName] = useState("")
  const [requestorEmail, setRequestorEmail] = useState("")
  const [honeypot, setHoneypot] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [createdRef, setCreatedRef] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch("/api/tickets/form-config").then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Could not load the ticket form")
        return data.config as TicketFormConfig
      }),
      fetch("/api/tickets/departments")
        .then(async (res) => {
          const data = await res.json()
          return res.ok ? ((data.departments ?? []) as TicketDepartment[]) : []
        })
        .catch(() => [] as TicketDepartment[]),
    ])
      .then(([cfg, depts]) => {
        setConfig(cfg)
        setDepartments(depts)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  // Date needed is derived from the chosen urgency (same hours that drive the
  // SLA due time), so users don't type it by hand.
  const autoDateFor = (urgency: string): string | null => {
    const hours = config?.slaHoursByUrgency?.[urgency]
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return null
    const d = new Date(Date.now() + hours * 3_600_000)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  const dateIsAuto =
    !!config &&
    Object.keys(config.slaHoursByUrgency ?? {}).length > 0 &&
    config.fields.some((f) => f.key === "urgency" && f.active) &&
    config.fields.some((f) => f.key === "dateNeeded" && f.active)

  const setAnswer = (key: string, value: string) =>
    setAnswers((prev) => {
      const next = { ...prev, [key]: value }
      if (key === "urgency" && dateIsAuto) {
        const auto = autoDateFor(value)
        if (auto) next.dateNeeded = auto
        else delete next.dateNeeded
      }
      return next
    })

  const submit = useCallback(async () => {
    if (!config) return
    if (collectIdentity && (!requestorName.trim() || !requestorEmail.trim())) {
      setSubmitError("Please fill in your name and email so we can follow up.")
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setCreatedRef(null)
    try {
      const payload = { ...answers }
      if (lockedDepartment) payload.department = lockedDepartment
      const bodyJson = {
        answers: payload,
        ...(collectIdentity
          ? { requestor: { name: requestorName.trim(), email: requestorEmail.trim() } }
          : {}),
        website: honeypot,
      }
      // Plain JSON without files; multipart when attachments are included.
      let res: Response
      if (files.length > 0) {
        const fd = new FormData()
        fd.append("payload", JSON.stringify(bodyJson))
        for (const f of files) fd.append("files", f)
        res = await fetch("/api/tickets", { method: "POST", body: fd })
      } else {
        res = await fetch("/api/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyJson),
        })
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`)
      setCreatedRef(data.ticketRef)
      setAnswers({})
      setFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ""
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [answers, config, lockedDepartment, collectIdentity, requestorName, requestorEmail, honeypot, files])

  const addFiles = (picked: FileList | null) => {
    if (!picked) return
    setSubmitError(null)
    const next = [...files]
    for (const f of Array.from(picked)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setSubmitError(`Max ${MAX_ATTACHMENTS} attachments`)
        break
      }
      const ext = f.name.split(".").pop()?.toLowerCase() ?? ""
      if (!ATTACHMENT_EXTENSIONS.includes(ext)) {
        setSubmitError(`"${f.name}" has an unsupported type`)
        continue
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setSubmitError(
          `"${f.name}" is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB per file)`
        )
        continue
      }
      next.push(f)
    }
    setFiles(next)
  }

  if (loadError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-words">{loadError}</span>
      </div>
    )
  }
  if (!config) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading form…
      </div>
    )
  }

  const fields = config.fields.filter((f) => f.active)

  return (
    <div className="flex flex-col gap-4">
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
        {collectIdentity && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">
                Your name<span className="ml-1 text-rose-400">*</span>
              </label>
              <input
                className={inputCls}
                value={requestorName}
                autoComplete="name"
                onChange={(e) => setRequestorName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">
                Your email<span className="ml-1 text-rose-400">*</span>
              </label>
              <input
                type="email"
                className={inputCls}
                value={requestorEmail}
                autoComplete="email"
                onChange={(e) => setRequestorEmail(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Honeypot — hidden from humans; bots that fill it are silently dropped. */}
        <input
          type="text"
          name="website"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        {fields.map((field) => {
          const isDept = field.key === "department"
          const isAutoDate = field.key === "dateNeeded" && dateIsAuto
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">
                {field.label}
                {field.required && <span className="ml-1 text-rose-400">*</span>}
                {isAutoDate && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (calculated from urgency)
                  </span>
                )}
              </label>
              {isAutoDate ? (
                <input
                  type="date"
                  className={inputCls}
                  value={answers[field.key] ?? ""}
                  disabled
                  placeholder="Select an urgency first"
                />
              ) : isDept && lockedDepartment ? (
                <input className={inputCls} value={lockedDepartment} disabled />
              ) : isDept && departments.length > 0 ? (
                <select
                  className={inputCls}
                  value={answers[field.key] ?? ""}
                  onChange={(e) => setAnswer(field.key, e.target.value)}
                >
                  <option value="">Select…</option>
                  {departments.map((d) => (
                    <option key={d.slug} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
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
          )
        })}

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">
            Attachments
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              optional · up to {MAX_ATTACHMENTS} files, {Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB
              each
            </span>
          </label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept={ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",")}
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={files.length >= MAX_ATTACHMENTS}
            >
              <Paperclip className="mr-2 h-4 w-4" /> Add file
            </Button>
          </div>
          {files.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-foreground">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(f.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {submitError && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{submitError}</span>
          </div>
        )}

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
