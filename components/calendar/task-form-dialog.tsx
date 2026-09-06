"use client"

/**
 * Create or edit one calendar task. One Dialog serves both — the difference is
 * whether a `task` was handed in.
 *
 * Native <input type="date"> and type="time" rather than the react-day-picker
 * calendar or datetime-local. Both are the repo's convention, both are
 * keyboard-typable, and splitting date from time is what lets "all day" exist
 * as an actual state rather than a magic 00:00.
 */
import { useEffect, useState } from "react"
import { Loader2, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Banner } from "@/components/kit/banner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  CalendarTask,
  MutationResult,
  RecipientsMode,
  RecurKind,
} from "@/components/calendar/types"
import {
  NO_RECURRENCE,
  describeRecurrence,
  normalizeRecurrence,
  upcomingOccurrences,
} from "@/lib/calendar-recurrence"
import { formatDateShort } from "@/lib/calendar-dates"

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/
const HOUSE_DOMAIN = "@ignitiongroup.co.za"

type Form = {
  title: string
  description: string
  dueDate: string
  dueTime: string
  allDay: boolean
  assignee: string
  recipientsMode: RecipientsMode
  recipients: string[]
  remindEnabled: boolean
  remindDaysBefore: string
  recurKind: RecurKind
  recurInterval: string
  recurWeekdays: number[]
  recurDayOfMonth: string
  recurUntil: string
}

/** Monday first — a weekday picker that starts on Sunday reads wrong here. */
const WEEKDAY_PICKER: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
]

function formFor(task: CalendarTask | null, today: string): Form {
  if (!task) {
    return {
      title: "",
      description: "",
      dueDate: today,
      dueTime: "",
      allDay: true,
      assignee: "",
      recipientsMode: "team",
      recipients: [],
      remindEnabled: true,
      remindDaysBefore: "0",
      recurKind: "none",
      recurInterval: "1",
      recurWeekdays: [],
      recurDayOfMonth: "",
      recurUntil: "",
    }
  }
  return {
    title: task.title,
    description: task.description ?? "",
    dueDate: task.dueDate,
    dueTime: task.dueTime ?? "",
    allDay: task.dueTime === null,
    assignee: task.assignee ?? "",
    recipientsMode: task.recipientsMode,
    recipients: [...task.recipients],
    remindEnabled: task.remindEnabled,
    remindDaysBefore: String(task.remindDaysBefore),
    recurKind: task.recurrence.kind,
    recurInterval: String(task.recurrence.interval),
    recurWeekdays: [...task.recurrence.weekdays],
    recurDayOfMonth: task.recurrence.dayOfMonth === null ? "" : String(task.recurrence.dayOfMonth),
    recurUntil: task.recurrence.until ?? "",
  }
}

/** The form's five recurrence fields as the rule the API and the preview want. */
function ruleOf(form: Form) {
  if (form.recurKind === "none") return NO_RECURRENCE
  return normalizeRecurrence(
    {
      kind: form.recurKind,
      interval: Number(form.recurInterval) || 1,
      weekdays: form.recurWeekdays,
      dayOfMonth: form.recurDayOfMonth === "" ? undefined : Number(form.recurDayOfMonth),
      until: form.recurUntil || null,
    },
    form.dueDate
  )
}

export function TaskFormDialog({
  open,
  task,
  today,
  teamCount,
  onClose,
  onSaved,
}: {
  open: boolean
  /** null creates; a task edits it. */
  task: CalendarTask | null
  today: string
  /** How many people the standing list would notify, for the live count below. */
  teamCount: number
  onClose: () => void
  onSaved: (result: MutationResult, mode: "created" | "updated") => void
}) {
  const [form, setForm] = useState<Form>(() => formFor(task, today))
  const [extra, setExtra] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Reset whenever the dialog is opened for a different task, so a half-typed
  // draft cannot leak from one task into the next one edited.
  useEffect(() => {
    if (open) {
      setForm(formFor(task, today))
      setExtra("")
      setError(null)
    }
  }, [open, task, today])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  const addExtra = () => {
    const email = extra.trim().toLowerCase()
    if (!email) return
    if (!EMAIL_RE.test(email)) {
      setError(`${email} does not look like an email address.`)
      return
    }
    if (form.recipients.includes(email)) {
      setExtra("")
      return
    }
    setError(null)
    set("recipients", [...form.recipients, email])
    setExtra("")
  }

  const removeExtra = (email: string) =>
    set("recipients", form.recipients.filter((e) => e !== email))

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const payload = {
        title: form.title,
        description: form.description,
        dueDate: form.dueDate,
        dueTime: form.allDay ? null : form.dueTime,
        assignee: form.assignee,
        recipientsMode: form.recipientsMode,
        recipients: form.recipients,
        remindEnabled: form.remindEnabled,
        remindDaysBefore: Number(form.remindDaysBefore) || 0,
        recurrence: ruleOf(form),
      }
      const res = await fetch(task ? `/api/calendar/tasks/${task.id}` : "/api/calendar/tasks", {
        method: task ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      onSaved(d as MutationResult, task ? "updated" : "created")
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // What the recipient count will be, near enough — the team list can overlap
  // the extras, so this is an upper bound and the result banner is the truth.
  const willNotify =
    form.recipientsMode === "custom"
      ? form.recipients.length
      : form.recipientsMode === "both"
        ? teamCount + form.recipients.length
        : teamCount
  const outsiders = form.recipients.filter((e) => !e.endsWith(HOUSE_DOMAIN))
  const preview =
    form.recurKind === "none" || !/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)
      ? []
      : upcomingOccurrences(ruleOf(form), form.dueDate, 3)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Everyone with Calendar access can see and edit this. Saving emails the people below.
          </DialogDescription>
        </DialogHeader>

        {error && <Banner tone="error">{error}</Banner>}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Title</label>
            <Input
              value={form.title}
              maxLength={200}
              placeholder="What needs to happen"
              onChange={(e) => set("title", e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Details</label>
            <Textarea
              value={form.description}
              rows={3}
              placeholder="Anything the team needs to know"
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Date</label>
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Time</label>
              <Input
                type="time"
                value={form.dueTime}
                disabled={form.allDay}
                onChange={(e) => set("dueTime", e.target.value)}
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={form.allDay}
                  onCheckedChange={(v) => {
                    const allDay = v === true
                    setForm((f) => ({ ...f, allDay, dueTime: allDay ? "" : f.dueTime }))
                  }}
                />
                All day
              </label>
            </div>
          </div>

          {/* ---- repeats ---- */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">Repeats</label>
                <Select
                  value={form.recurKind}
                  onValueChange={(v) => set("recurKind", v as RecurKind)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Does not repeat</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.recurKind !== "none" && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">every</span>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    className="w-20"
                    value={form.recurInterval}
                    onChange={(e) => set("recurInterval", e.target.value)}
                  />
                  <span className="text-sm text-muted-foreground">
                    {form.recurKind === "daily" ? "day(s)" : form.recurKind === "weekly" ? "week(s)" : "month(s)"}
                  </span>
                </div>
              )}
            </div>

            {form.recurKind === "weekly" && (
              <div className="mt-3">
                <label className="mb-1 block text-xs text-muted-foreground">On</label>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_PICKER.map((d) => {
                    const on = form.recurWeekdays.includes(d.value)
                    return (
                      <Button
                        key={d.value}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        onClick={() =>
                          set(
                            "recurWeekdays",
                            on
                              ? form.recurWeekdays.filter((w) => w !== d.value)
                              : [...form.recurWeekdays, d.value]
                          )
                        }
                      >
                        {d.label}
                      </Button>
                    )
                  })}
                </div>
                {form.recurWeekdays.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nothing picked, so it repeats on whatever weekday the date above falls on.
                  </p>
                )}
              </div>
            )}

            {form.recurKind === "monthly" && (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Day of the month</label>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    className="w-24"
                    placeholder={form.dueDate.slice(8, 10)}
                    value={form.recurDayOfMonth}
                    onChange={(e) => set("recurDayOfMonth", e.target.value)}
                  />
                </div>
                <p className="pb-2 text-xs text-muted-foreground">
                  Blank uses the date above. A day past the end of a short month falls on its last
                  day, then goes back.
                </p>
              </div>
            )}

            {form.recurKind !== "none" && (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Stop repeating after (optional)
                  </label>
                  <Input
                    type="date"
                    className="w-44"
                    value={form.recurUntil}
                    onChange={(e) => set("recurUntil", e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* The preview is the point of this box: a rule is easy to describe
                and easy to get wrong, and the next few real dates settle it. */}
            {form.recurKind !== "none" && (
              <div className="mt-3 text-xs text-muted-foreground">
                <div className="text-foreground">{describeRecurrence(ruleOf(form))}</div>
                {preview.length > 0 ? (
                  <div className="mt-0.5">
                    After {formatDateShort(form.dueDate)}: {preview.map(formatDateShort).join(" · ")}
                  </div>
                ) : (
                  <div className="mt-0.5">No further dates — check the stop date.</div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Assigned to</label>
            <Input
              value={form.assignee}
              placeholder="Optional — a name or an email"
              onChange={(e) => set("assignee", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Notify</label>
              <Select
                value={form.recipientsMode}
                onValueChange={(v) => set("recipientsMode", v as RecipientsMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">The team list</SelectItem>
                  <SelectItem value="custom">Only the addresses below</SelectItem>
                  <SelectItem value="both">The team list plus the addresses below</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {willNotify === 0
                  ? "Nobody will be emailed."
                  : `About ${willNotify} recipient${willNotify === 1 ? "" : "s"}.`}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Extra addresses</label>
              <div className="flex gap-2">
                <Input
                  value={extra}
                  placeholder="name@example.com"
                  onChange={(e) => setExtra(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addExtra()
                    }
                  }}
                />
                <Button type="button" variant="outline" size="icon" onClick={addExtra}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {form.recipients.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.recipients.map((email) => (
                    <Badge key={email} variant="secondary" className="gap-1 font-normal">
                      {email}
                      <button
                        type="button"
                        aria-label={`Remove ${email}`}
                        onClick={() => removeExtra(email)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* A warning, not a block: nothing in this app maintains a domain
              allowlist, and an external teammate can be legitimate. Whether the
              mail actually leaves is up to Exchange, not to this form. */}
          {outsiders.length > 0 && (
            <Banner tone="warning">
              {outsiders.join(", ")} {outsiders.length === 1 ? "is" : "are"} outside{" "}
              {HOUSE_DOMAIN}. Mail to outside addresses may be blocked by the mail server.
            </Banner>
          )}

          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                checked={form.remindEnabled}
                onCheckedChange={(v) => set("remindEnabled", v)}
              />
              Send a reminder
            </label>
            {form.remindEnabled && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-20"
                  value={form.remindDaysBefore}
                  onChange={(e) => set("remindDaysBefore", e.target.value)}
                />
                <span className="text-sm text-muted-foreground">
                  day(s) before, from 07:00
                </span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !form.title.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {task ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
