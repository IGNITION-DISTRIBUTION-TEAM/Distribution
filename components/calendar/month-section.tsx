"use client"

/**
 * The month grid — seven columns, six rows, tasks in the day cells.
 *
 * HAND-ROLLED, not components/ui/calendar.tsx. That file wraps
 * react-day-picker, but it hardcodes 36px flexbox cells built out of
 * `buttonVariants({ variant: "ghost" })`. Hosting several tasks in one day
 * would mean overriding cell, day, row, head_cell, head_row, table AND
 * components.Day — at which point day-picker contributes only month
 * arithmetic, which lib/calendar-dates.ts now does in about thirty lines. Two
 * range pickers depend on that file; it is left alone.
 *
 * ALWAYS SIX ROWS. `monthGridDays` returns 42 dates whether the month needs
 * five weeks or six, so the page does not change height as you page through
 * the year — the row that would appear and disappear is the one under the
 * cursor.
 *
 * RECURRING TASKS ARE EXPANDED HERE. A series is one row holding its next
 * occurrence, so the grid asks `occursOn` of every visible day rather than
 * reading dates off rows. Any cell that is not the stored due date is a
 * PROJECTION: it has no identity of its own, and editing or dragging it acts
 * on the whole series. The chips say so, and the drag confirms it.
 */
import { useCallback, useMemo, useState } from "react"
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Printer,
  RefreshCw,
  Repeat,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { Skeleton } from "@/components/kit/skeleton"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  addMonthsIso,
  formatDateLabel,
  formatMonthLabel,
  isSameMonth,
  monthGridDays,
  sastTodayIso,
  startOfMonthIso,
} from "@/lib/calendar-dates"
import { describeRecurrence, isRecurring, occursOn } from "@/lib/calendar-recurrence"
import { TaskFormDialog } from "@/components/calendar/task-form-dialog"
import { outcomeBanner, useCalendarTasks } from "@/components/calendar/use-calendar-tasks"
import type { CalendarTask, TeamRecipient } from "@/components/calendar/types"

/** Monday first, matching the grid and the recurrence weekday picker. */
const WEEKDAY_HEADS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Chips shown before a day collapses into "+N more". */
const CHIPS_PER_DAY = 3

/**
 * One thing to draw in one cell.
 *
 * `projected` is the whole reason this type exists rather than passing tasks
 * around: the same task appears on many days, and only one of them is the row
 * as stored.
 */
type Occurrence = { task: CalendarTask; date: string; projected: boolean }

export function MonthSection({
  team,
  onMailEnabled,
}: {
  /** Held by the shell — a ranged fetch does not return the recipient list. */
  team: TeamRecipient[]
  onMailEnabled?: (enabled: boolean) => void
}) {
  const [month, setMonth] = useState(() => startOfMonthIso(sastTodayIso()))

  const days = useMemo(() => monthGridDays(month), [month])
  const from = days[0]
  const to = days[41]

  const {
    tasks, today, loading, error, note, busyId,
    setNote, setError, reload, moveTo, deleteReach,
  } = useCalendarTasks({ from, to, team, onMailEnabled })

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarTask | null>(null)
  const [formDate, setFormDate] = useState(today)
  const [dragging, setDragging] = useState<Occurrence | null>(null)
  const [overDay, setOverDay] = useState<string | null>(null)
  /** A recurring drag waiting to be confirmed: it moves the whole series. */
  const [pendingMove, setPendingMove] = useState<{ occ: Occurrence; to: string } | null>(null)

  /**
   * Every occurrence that falls in the visible window, bucketed by date.
   *
   * A one-off contributes its own date. A series contributes every day the
   * rule lands on, anchored at its SERIES_START — which is why the grid can
   * draw Mondays the row has already rolled past.
   */
  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>()
    const push = (date: string, occ: Occurrence) => {
      const list = map.get(date)
      if (list) list.push(occ)
      else map.set(date, [occ])
    }

    for (const task of tasks) {
      if (isRecurring(task.recurrence) && task.status === "open") {
        for (const date of days) {
          if (occursOn(task.recurrence, task.seriesStart, date)) {
            push(date, { task, date, projected: date !== task.dueDate })
          }
        }
        // A series whose stored date sits inside the window but which the rule
        // does not produce (an edited rule mid-flight) still shows on its own
        // date rather than vanishing.
        if (
          task.dueDate >= from &&
          task.dueDate <= to &&
          !occursOn(task.recurrence, task.seriesStart, task.dueDate)
        ) {
          push(task.dueDate, { task, date: task.dueDate, projected: false })
        }
      } else if (task.dueDate >= from && task.dueDate <= to) {
        push(task.dueDate, { task, date: task.dueDate, projected: false })
      }
    }

    // All-day first, then by time — the same order the SQL returns.
    for (const list of map.values()) {
      list.sort((a, b) => {
        const at = a.task.dueTime ?? ""
        const bt = b.task.dueTime ?? ""
        if (at !== bt) return at < bt ? -1 : 1
        return a.task.id - b.task.id
      })
    }
    return map
  }, [tasks, days, from, to])

  const openCreate = (date: string) => {
    setEditing(null)
    setFormDate(date)
    setFormOpen(true)
  }

  const openEdit = (task: CalendarTask) => {
    setEditing(task)
    setFormDate(task.dueDate)
    setFormOpen(true)
  }

  /** A drop lands here. Recurring series ask first; one-offs just move. */
  const handleDrop = useCallback(
    (date: string) => {
      const occ = dragging
      setDragging(null)
      setOverDay(null)
      if (!occ || occ.date === date) return
      if (isRecurring(occ.task.recurrence)) {
        setPendingMove({ occ, to: date })
        return
      }
      void moveTo(occ.task, date)
    },
    [dragging, moveTo]
  )

  const exportHref = `/api/calendar/export?from=${from}&to=${to}`

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        description="The whole team's month. Click a day to add a task, drag one to move it."
        actions={
          <>
            <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setMonth(addMonthsIso(month, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={() => setMonth(startOfMonthIso(today))}>
              Today
            </Button>
            <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setMonth(addMonthsIso(month, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void reload()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button onClick={() => openCreate(today)}>
              <CalendarPlus className="mr-2 h-4 w-4" /> New task
            </Button>
          </>
        }
      >
        {formatMonthLabel(month)}
      </PageHeading>

      {/* Print and export sit apart from the navigation: they act on the month
          you are looking at, and putting them in the same cluster as prev/next
          made that cluster read as one group of five arrows. */}
      <div className="flex flex-wrap items-center gap-2" data-print-hide>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" /> Print this month
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={exportHref} download>
            <Download className="mr-2 h-4 w-4" /> Export to Outlook
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">
          The export is a snapshot — it will not update in Outlook after you download it.
        </span>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}

      <Card padding="dense">
        {/* Seven columns of known width, so nothing needs to scroll sideways on
            a normal screen. On a narrow one the grid keeps a floor and scrolls
            inside the card — the negative margin cancels the card's padding so
            the scroll region spans edge to edge, as ScoreDateHeatgrid does. */}
        <div className="-mx-5 overflow-x-auto px-5">
          <div className="min-w-[44rem]">
            <div className="grid grid-cols-7 gap-px">
              {WEEKDAY_HEADS.map((label) => (
                <div key={label} className="pb-1 text-center text-xs font-medium text-muted-foreground">
                  {label}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-px rounded-md bg-border">
              {days.map((date) => {
                const items = byDay.get(date) ?? []
                const shown = items.slice(0, CHIPS_PER_DAY)
                const hidden = items.length - shown.length
                const outside = !isSameMonth(date, month)
                const isToday = date === today

                return (
                  <div
                    key={date}
                    // Read by the print rules in app/globals.css: printing
                    // flattens every background to white, so "today" and the
                    // month's edges need something that survives that.
                    data-today={isToday ? "" : undefined}
                    data-outside={outside ? "" : undefined}
                    onDragOver={(e) => {
                      if (!dragging) return
                      // Without preventDefault the browser refuses the drop.
                      e.preventDefault()
                      setOverDay(date)
                    }}
                    onDragLeave={() => setOverDay((d) => (d === date ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(date)
                    }}
                    className={cn(
                      "flex min-h-[7rem] min-w-0 flex-col gap-1 bg-card p-1.5 transition-colors duration-150",
                      outside && "bg-muted/30",
                      overDay === date && "bg-accent",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => openCreate(date)}
                      aria-label={`Add a task on ${formatDateLabel(date)}`}
                      className="flex items-center gap-1.5 self-start rounded px-1 text-xs transition-colors duration-150 hover:bg-accent"
                    >
                      <span
                        className={cn(
                          "tabular-nums",
                          outside ? "text-muted-foreground/60" : "text-foreground",
                          isToday && "rounded-full bg-primary px-1.5 font-semibold text-primary-foreground",
                        )}
                      >
                        {Number(date.slice(8, 10))}
                      </span>
                    </button>

                    {loading && items.length === 0 ? (
                      <Skeleton className="h-4 w-full" />
                    ) : (
                      shown.map((occ) => (
                        <TaskChip
                          key={`${occ.task.id}-${occ.date}`}
                          occ={occ}
                          busy={busyId === occ.task.id}
                          onOpen={() => openEdit(occ.task)}
                          onDragStart={() => setDragging(occ)}
                          onDragEnd={() => {
                            setDragging(null)
                            setOverDay(null)
                          }}
                        />
                      ))
                    )}

                    {hidden > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="self-start rounded px-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent"
                          >
                            +{hidden} more
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-72">
                          <div className="mb-2 text-sm font-medium text-foreground">
                            {formatDateLabel(date)}
                          </div>
                          <div className="flex flex-col gap-1">
                            {items.map((occ) => (
                              <TaskChip
                                key={`${occ.task.id}-${occ.date}-all`}
                                occ={occ}
                                busy={busyId === occ.task.id}
                                onOpen={() => openEdit(occ.task)}
                              />
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Repeat className="h-3 w-3" /> repeats — editing or moving one changes the whole series
        </span>
        <span>{tasks.length} task(s) in view</span>
      </div>

      <TaskFormDialog
        open={formOpen}
        task={editing}
        today={formDate}
        teamCount={team.filter((r) => r.active).length}
        onClose={() => setFormOpen(false)}
        onSaved={(result, mode) => {
          setNote(outcomeBanner(result, mode))
          void reload()
        }}
      />

      {/* Moving a series is not the same as moving a task, so it is confirmed.
          There is no "just this occurrence" to offer: the series is one row. */}
      <AlertDialog open={pendingMove !== null} onOpenChange={(o) => !o && setPendingMove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move the whole series?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingMove?.occ.task.title}&rdquo; repeats
              {pendingMove ? ` — ${describeRecurrence(pendingMove.occ.task.recurrence).toLowerCase()}` : ""}.
              Moving it to {pendingMove ? formatDateLabel(pendingMove.to) : ""} re-anchors every
              future occurrence, not just this one, and emails{" "}
              {deleteReach(pendingMove?.occ.task ?? null)} recipient(s).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const move = pendingMove
                setPendingMove(null)
                if (move) void moveTo(move.occ.task, move.to)
              }}
            >
              Move the series
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The grid swallows its own load errors into the banner above; this is
          the escape hatch when a window simply has nothing in it. */}
      {!loading && tasks.length === 0 && !error && (
        <Banner tone="info">
          Nothing on the calendar this month. Click any day to add the first task.
        </Banner>
      )}
    </div>
  )
}

/**
 * One task in one cell.
 *
 * Draggable only when a drag handler is given — the copies inside the "+N
 * more" popover are not, because dropping onto a cell hidden behind an open
 * popover is not a gesture anyone can aim.
 */
function TaskChip({
  occ,
  busy,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  occ: Occurrence
  busy: boolean
  onOpen: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const { task, projected } = occ
  const repeats = isRecurring(task.recurrence)
  const closed = task.status !== "open"

  return (
    <button
      type="button"
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      title={
        repeats
          ? `${task.title} — ${describeRecurrence(task.recurrence)}. Editing this edits the whole series.`
          : task.title
      }
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-left text-xs transition-colors duration-150 hover:bg-accent",
        closed && "opacity-60",
      )}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : repeats ? (
        <Repeat className={cn("h-3 w-3 shrink-0", projected ? "text-muted-foreground" : "text-foreground")} />
      ) : null}
      {task.dueTime && <span className="shrink-0 tabular-nums text-muted-foreground">{task.dueTime}</span>}
      <span className={cn("truncate", closed && "line-through")}>{task.title}</span>
    </button>
  )
}
