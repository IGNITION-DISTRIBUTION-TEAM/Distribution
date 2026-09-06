"use client"

/**
 * The calendar itself: one card per date group, a table of tasks inside each.
 *
 * A grouped list rather than a month grid. A month grid answers "what does
 * October look like"; a team that has to act answers "what is due today" far
 * more often, and a grid makes that the hardest question on the page.
 *
 * Grouping is computed against sastTodayIso() — the date it is in
 * Johannesburg, not on the viewer's laptop — so a person working from a UTC
 * machine sees the same "Today" the reminder cron does. The API also returns
 * its own `today` and that one wins when present, which keeps the list honest
 * if a browser clock is simply wrong.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { CalendarPlus, Check, Loader2, Pencil, RefreshCw, Repeat, Trash2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Banner } from "@/components/kit/banner"
import { PageHeading, SectionHeading } from "@/components/kit/heading"
import { SkeletonRows } from "@/components/kit/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
import { cn } from "@/lib/utils"
import {
  GROUP_LABELS,
  GROUP_ORDER,
  formatDateLabel,
  groupFor,
  sastTodayIso,
  type CalendarGroup,
} from "@/lib/calendar-dates"
import { describeRecurrence, isRecurring } from "@/lib/calendar-recurrence"
import { TaskFormDialog } from "@/components/calendar/task-form-dialog"
import type { CalendarTask, MutationResult, TeamRecipient } from "@/components/calendar/types"

/** How a mutation's outcome is reported — the point of the whole feature. */
function outcomeBanner(
  result: MutationResult,
  verb: string
): { tone: "success" | "info" | "warning"; text: string } {
  if (result.unchanged) return { tone: "info", text: `Nothing changed, so no email was sent.` }

  // A recurring task that was ticked off has not gone anywhere — say where it
  // went, or the row reappearing on a later date looks like a bug.
  const what = result.rolledTo
    ? `done for this time — next on ${formatDateLabel(result.rolledTo)}`
    : result.seriesEnded
      ? "done. That was the series' last occurrence"
      : verb
  if (result.notified) {
    return {
      tone: "success",
      text: `Task ${what}. Notified ${result.recipientCount} recipient${result.recipientCount === 1 ? "" : "s"}.`,
    }
  }
  if (result.recipientCount === 0) {
    return {
      tone: "info",
      text: `Task ${what}. Nobody is on the notification list yet — add teammates under Recipients.`,
    }
  }
  return {
    tone: "warning",
    text: `Task ${what}, but the email could not be sent. Check the Notifications tab for the reason.`,
  }
}

export function UpcomingSection({
  /** Told after each load, so the shell can warn once for the whole department. */
  onMailEnabled,
}: {
  onMailEnabled?: (enabled: boolean) => void
}) {
  const [tasks, setTasks] = useState<CalendarTask[]>([])
  const [team, setTeam] = useState<TeamRecipient[]>([])
  const [today, setToday] = useState(() => sastTodayIso())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: "success" | "info" | "warning"; text: string } | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarTask | null>(null)
  const [deleting, setDeleting] = useState<CalendarTask | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [showDone, setShowDone] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/calendar/tasks", { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setTasks(d.tasks ?? [])
      setTeam(d.team ?? [])
      if (typeof d.today === "string" && d.today) setToday(d.today)
      onMailEnabled?.(d.mailEnabled !== false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [onMailEnabled])

  useEffect(() => {
    void load()
  }, [load])

  const activeTeamCount = team.filter((r) => r.active).length

  const { groups, done } = useMemo(() => {
    const groups = new Map<CalendarGroup, CalendarTask[]>()
    const done: CalendarTask[] = []
    for (const task of tasks) {
      if (task.status !== "open") {
        done.push(task)
        continue
      }
      const key = groupFor(task.dueDate, today)
      const list = groups.get(key)
      if (list) list.push(task)
      else groups.set(key, [task])
    }
    return { groups, done }
  }, [tasks, today])

  const afterMutation = (result: MutationResult, verb: string) => {
    setNote(outcomeBanner(result, verb))
    void load()
  }

  /** Tick a task off, or put it back. A status change is an edit, so it mails. */
  const setStatus = async (task: CalendarTask, status: "open" | "done") => {
    setBusyId(task.id)
    setNote(null)
    try {
      const res = await fetch(`/api/calendar/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      afterMutation(d as MutationResult, status === "done" ? "marked done" : "reopened")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const task = deleting
    setBusyId(task.id)
    setDeleting(null)
    setNote(null)
    try {
      const res = await fetch(`/api/calendar/tasks/${task.id}`, { method: "DELETE" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      afterMutation(d as MutationResult, "deleted")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  /** How many people a delete would email — said out loud before it happens. */
  const deleteReach = (task: CalendarTask | null) => {
    if (!task) return 0
    if (task.recipientsMode === "custom") return task.recipients.length
    if (task.recipientsMode === "both") {
      const emails = new Set([...team.filter((r) => r.active).map((r) => r.email), ...task.recipients])
      return emails.size
    }
    return activeTeamCount
  }

  const notifyLabel = (task: CalendarTask) => {
    if (task.recipientsMode === "custom") return `${task.recipients.length} custom`
    if (task.recipientsMode === "both") return `Team + ${task.recipients.length}`
    return `Team (${activeTeamCount})`
  }

  const renderRows = (list: CalendarTask[]) =>
    list.map((task) => (
      <TableRow key={task.id}>
        <TableCell>
          <div className={cn("font-medium", task.status !== "open" && "line-through opacity-60")}>
            {task.title}
          </div>
          {task.description && (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {task.description}
            </div>
          )}
          {task.assignee && (
            <div className="mt-0.5 text-xs text-muted-foreground">For {task.assignee}</div>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <div>{formatDateLabel(task.dueDate)}</div>
          {isRecurring(task.recurrence) && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Repeat className="h-3 w-3 shrink-0" />
              {describeRecurrence(task.recurrence)}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            {task.dueTime ?? "All day"}
            {task.remindEnabled
              ? task.remindDaysBefore > 0
                ? ` · reminder ${task.remindDaysBefore}d before`
                : " · reminder on the day"
              : " · no reminder"}
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {task.createdBy ?? "—"}
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {notifyLabel(task)}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                task.status !== "open"
                  ? "Reopen"
                  : isRecurring(task.recurrence)
                    ? "Done for this occurrence"
                    : "Mark done"
              }
              disabled={busyId === task.id}
              onClick={() => void setStatus(task, task.status === "open" ? "done" : "open")}
            >
              {busyId === task.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : task.status === "open" ? (
                <Check className="h-4 w-4" />
              ) : (
                <Undo2 className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit"
              onClick={() => {
                setEditing(task)
                setFormOpen(true)
              }}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete"
              onClick={() => setDeleting(task)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    ))

  const header = (
    <TableHeader>
      <TableRow>
        <TableHead>Task</TableHead>
        <TableHead>When</TableHead>
        <TableHead>Created by</TableHead>
        <TableHead>Notifies</TableHead>
        <TableHead className="text-right">Actions</TableHead>
      </TableRow>
    </TableHeader>
  )

  const openCount = tasks.filter((t) => t.status === "open").length

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        description="Everyone with Calendar access shares this list. Saving a task emails the people it notifies."
        actions={
          <>
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <CalendarPlus className="mr-2 h-4 w-4" /> New task
            </Button>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </>
        }
      >
        Upcoming
      </PageHeading>

      {error && <Banner tone="error">{error}</Banner>}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}

      {loading && tasks.length === 0 ? (
        <Card padding="dense">
          <Table>
            {header}
            <TableBody>
              <SkeletonRows cols={5} rows={4} />
            </TableBody>
          </Table>
        </Card>
      ) : openCount === 0 ? (
        <Banner tone="info">
          Nothing is on the calendar yet. Add the first task with the button above.
        </Banner>
      ) : (
        GROUP_ORDER.map((key) => {
          const list = groups.get(key)
          if (!list || list.length === 0) return null
          return (
            <Card key={key} padding="dense">
              <div className="mb-3 flex items-center gap-2">
                <SectionHeading>{GROUP_LABELS[key]}</SectionHeading>
                <Badge variant={key === "overdue" ? "destructive" : "secondary"}>
                  {list.length}
                </Badge>
              </div>
              <Table>
                {header}
                <TableBody>{renderRows(list)}</TableBody>
              </Table>
            </Card>
          )
        })
      )}

      {done.length > 0 && (
        <Card padding="dense">
          <button
            type="button"
            className="mb-1 flex w-full items-center gap-2 text-left"
            onClick={() => setShowDone((v) => !v)}
          >
            <SectionHeading>Done and cancelled</SectionHeading>
            <Badge variant="secondary">{done.length}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {showDone ? "Hide" : "Show"}
            </span>
          </button>
          {showDone && (
            <Table>
              {header}
              <TableBody>{renderRows(done)}</TableBody>
            </Table>
          )}
        </Card>
      )}

      <TaskFormDialog
        open={formOpen}
        task={editing}
        today={today}
        teamCount={activeTeamCount}
        onClose={() => setFormOpen(false)}
        onSaved={(result, mode) => afterMutation(result, mode)}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && isRecurring(deleting.recurrence)
                ? "This deletes the whole repeating series, not just this occurrence. "
                : ""}
              This will delete &ldquo;{deleting?.title}&rdquo; from the shared calendar
              {deleteReach(deleting) > 0
                ? ` and email ${deleteReach(deleting)} ${deleteReach(deleting) === 1 ? "person" : "people"}.`
                : ". Nobody is on its notification list, so no email will go out."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
