"use client"

/**
 * The data layer both calendar views share.
 *
 * Month and Upcoming answer different questions about the same rows, and
 * before this hook existed each would have carried its own copy of the fetch,
 * the three mutation calls, the "who was emailed" banner logic and the
 * recipient-count arithmetic behind the delete confirm. Four copies of the
 * banner rules is how a feature ends up reporting "notified 6 recipients" on
 * one screen and nothing at all on the other.
 *
 * What it does NOT do is cache across views. The shell unmounts a section when
 * you navigate away, deliberately, so each view refetches its own tasks on
 * visit. This removes the duplicated code, not the second query.
 */
import { useCallback, useEffect, useState } from "react"
import { formatDateLabel } from "@/lib/calendar-dates"
import { sastTodayIso } from "@/lib/calendar-dates"
import type { CalendarTask, MutationResult, TeamRecipient } from "@/components/calendar/types"

export type OutcomeNote = { tone: "success" | "info" | "warning"; text: string }

/**
 * How a mutation's outcome is reported — the point of the whole feature.
 *
 * Every branch here exists because silence is the failure mode: a task saves,
 * no mail goes, and nothing on screen distinguishes "nobody is on the list"
 * from "the mail server refused" from "it worked".
 */
export function outcomeBanner(result: MutationResult, verb: string): OutcomeNote {
  if (result.unchanged) return { tone: "info", text: "Nothing changed, so no email was sent." }

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

export type CalendarData = {
  tasks: CalendarTask[]
  team: TeamRecipient[]
  today: string
  loading: boolean
  error: string | null
  note: OutcomeNote | null
  busyId: number | null
  activeTeamCount: number
  setNote: (note: OutcomeNote | null) => void
  setError: (error: string | null) => void
  reload: () => Promise<void>
  /** Tick a task off, or reopen it. On a series this rolls it forward. */
  setStatus: (task: CalendarTask, status: "open" | "done") => Promise<void>
  remove: (task: CalendarTask) => Promise<void>
  /** Move a task to another date — the drag path and nothing else. */
  moveTo: (task: CalendarTask, dueDate: string) => Promise<void>
  /** How many people a mutation on this task would email. */
  deleteReach: (task: CalendarTask | null) => number
  /** What the "Notifies" column says. */
  notifyLabel: (task: CalendarTask) => string
}

export function useCalendarTasks({
  from,
  to,
  team: teamProp,
  onMailEnabled,
}: {
  /** A window, for the month grid. Omit both for the open-plus-30-days list. */
  from?: string
  to?: string
  /** The shell already holds the recipient list; a ranged fetch does not return it. */
  team?: TeamRecipient[]
  onMailEnabled?: (enabled: boolean) => void
} = {}): CalendarData {
  const [tasks, setTasks] = useState<CalendarTask[]>([])
  const [ownTeam, setOwnTeam] = useState<TeamRecipient[]>([])
  const [today, setToday] = useState(() => sastTodayIso())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<OutcomeNote | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  // The shell's list wins when it has one; the unranged fetch supplies its own.
  const team = teamProp ?? ownTeam

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = from && to ? `?from=${from}&to=${to}` : ""
      const res = await fetch(`/api/calendar/tasks${query}`, { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setTasks(d.tasks ?? [])
      if (Array.isArray(d.team)) setOwnTeam(d.team)
      if (typeof d.today === "string" && d.today) setToday(d.today)
      if (typeof d.mailEnabled === "boolean") onMailEnabled?.(d.mailEnabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [from, to, onMailEnabled])

  useEffect(() => {
    void reload()
  }, [reload])

  /** One shape for all three mutations, so they cannot report differently. */
  const mutate = useCallback(
    async (task: CalendarTask, init: RequestInit, verb: string) => {
      setBusyId(task.id)
      setNote(null)
      setError(null)
      try {
        const res = await fetch(`/api/calendar/tasks/${task.id}`, init)
        const d = await res.json()
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
        setNote(outcomeBanner(d as MutationResult, verb))
        await reload()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [reload]
  )

  const setStatus = useCallback(
    (task: CalendarTask, status: "open" | "done") =>
      mutate(
        task,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
        status === "done" ? "marked done" : "reopened"
      ),
    [mutate]
  )

  const moveTo = useCallback(
    (task: CalendarTask, dueDate: string) =>
      mutate(
        task,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueDate }),
        },
        `moved to ${formatDateLabel(dueDate)}`
      ),
    [mutate]
  )

  const remove = useCallback(
    (task: CalendarTask) => mutate(task, { method: "DELETE" }, "deleted"),
    [mutate]
  )

  const activeTeamCount = team.filter((r) => r.active).length

  /**
   * How many people a mutation on this task would email.
   *
   * `both` has to dedupe rather than add: an address on the team list AND in
   * the task's extras is one person, and the confirm dialog saying "email 7
   * people" when it will email 6 is the kind of small lie that costs trust in
   * the rest of the numbers.
   */
  const deleteReach = useCallback(
    (task: CalendarTask | null) => {
      if (!task) return 0
      if (task.recipientsMode === "custom") return task.recipients.length
      if (task.recipientsMode === "both") {
        return new Set([
          ...team.filter((r) => r.active).map((r) => r.email),
          ...task.recipients.map((e) => e.toLowerCase()),
        ]).size
      }
      return activeTeamCount
    },
    [team, activeTeamCount]
  )

  const notifyLabel = useCallback(
    (task: CalendarTask) => {
      if (task.recipientsMode === "custom") return `${task.recipients.length} custom`
      if (task.recipientsMode === "both") return `Team + ${task.recipients.length}`
      return `Team (${activeTeamCount})`
    },
    [activeTeamCount]
  )

  return {
    tasks, team, today, loading, error, note, busyId, activeTeamCount,
    setNote, setError, reload, setStatus, remove, moveTo, deleteReach, notifyLabel,
  }
}
