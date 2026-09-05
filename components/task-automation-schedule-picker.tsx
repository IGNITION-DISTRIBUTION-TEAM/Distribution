"use client"

import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DOW_DISPLAY_ORDER,
  DOW_LABELS,
  SCHEDULE_PRESETS,
  buildCron,
  cronToSpec,
  describeCron,
  formatWallClock,
  nextRuns,
  parseCron,
  zonedNow,
  type ScheduleSpec,
  type WallClock,
} from "@/lib/cron-schedule"
import { Banner } from "@/components/kit/banner"

/**
 * Pick a schedule for a Snowflake task.
 *
 * THE PARENT OWNS ONE PIECE OF STATE — the cron string — and this component
 * only ever hands back a VALID one. That matters beyond tidiness: the dashboard
 * feeds the cron straight into `buildSyncScript` on every render, so a
 * half-typed expression would throw, blank the whole statement preview and
 * disable the Test load and Create buttons on every keystroke. The custom field
 * therefore keeps its own draft and commits only when it parses.
 *
 * Everything the builder displays is DERIVED from the current cron, so the two
 * tabs cannot drift apart. The one exception is `kind`, and it is deliberate —
 * see the comment on it below.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DOM_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]
const pad = (n: number) => String(n).padStart(2, "0")

export function SchedulePicker({
  value,
  onChange,
  timezone,
  disabled,
}: {
  value: string
  onChange: (cron: string) => void
  timezone: string
  disabled?: boolean
}) {
  const parsed = useMemo(() => parseCron(value), [value])
  const spec = useMemo(() => (parsed.ok ? cronToSpec(parsed.cron) : null), [parsed])

  const [mode, setMode] = useState<"builder" | "raw">(() => (spec ? "builder" : "raw"))
  const [rawDraft, setRawDraft] = useState(value)
  const [rawError, setRawError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  /**
   * The frequency dropdown is USER state, not derived — the one exception to
   * the rule above, and the trickiest thing in this component.
   *
   * `{daily, 07:00}` and `{weekly, 07:00, all seven days}` both canonicalise to
   * `0 7 * * *`, and `cronToSpec` has to return one answer (it prefers the
   * simpler, daily). If the dropdown read from that, someone who picked
   * "Weekly" and then ticked all seven days would watch it snap back to
   * "Daily" under their cursor. So the KIND is owned by the user and only the
   * FIELD VALUES are derived.
   */
  const [kind, setKind] = useState<ScheduleSpec["kind"]>(spec?.kind ?? "daily")

  /**
   * "Now" for the preview, set in an effect rather than during render.
   *
   * Calling `new Date()` while rendering makes the render impure and, because
   * this page is server-rendered before it hydrates, produces a server/client
   * mismatch. The interval keeps a tab left open overnight from showing a
   * "next run" that has already been and gone.
   */
  const [now, setNow] = useState<WallClock | null>(null)
  useEffect(() => {
    const tick = () => setNow(zonedNow(new Date(), timezone))
    tick()
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [timezone])

  const preview = useMemo(() => {
    if (!parsed.ok || !now) return null
    return nextRuns(parsed.cron, now, 5)
  }, [parsed, now])

  /** Build from the current spec, filling anything the kind does not carry. */
  const emit = (next: ScheduleSpec) => {
    try {
      onChange(buildCron(next))
      setSwitchError(null)
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : String(e))
    }
  }

  // Current field values, read out of whatever the cron happens to be. Defaults
  // cover the case where the cron is a shape this kind does not describe (the
  // user has just switched kind, and the values have not been rebuilt yet).
  const minute = parsed.ok ? parsed.cron.minute : 0
  const hour = spec && spec.kind !== "hourly" ? spec.hour : parsed.ok ? parsed.cron.hour.values[0] ?? 7 : 7
  const dows = spec && (spec.kind === "weekly" || spec.kind === "hourly") ? spec.dows : []
  const dayOfMonth = spec && spec.kind === "monthly" ? spec.dayOfMonth : 1
  const fromHour = spec && spec.kind === "hourly" ? spec.fromHour : 6
  const toHour = spec && spec.kind === "hourly" ? spec.toHour : 18
  const everyHours = spec && spec.kind === "hourly" ? spec.everyHours : 1

  const setKindAndEmit = (next: ScheduleSpec["kind"]) => {
    setKind(next)
    if (next === "daily") emit({ kind: "daily", minute, hour })
    else if (next === "weekly") emit({ kind: "weekly", minute, hour, dows: dows.length ? dows : [1, 2, 3, 4, 5] })
    else if (next === "monthly") emit({ kind: "monthly", minute, hour, dayOfMonth })
    else emit({ kind: "hourly", minute, fromHour, toHour, everyHours, dows })
  }

  /** `<input type="time">` gives HH:MM; the minute is free under the hourly floor. */
  const onTime = (text: string, apply: (h: number, mi: number) => void) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
    if (!m) return
    apply(Number(m[1]), Number(m[2]))
  }

  const switchMode = (next: string) => {
    if (next === "raw") {
      setRawDraft(value)
      setRawError(null)
      setMode("raw")
      return
    }
    // raw -> builder. Refuse to switch rather than silently discarding a
    // hand-written expression or silently keeping stale builder state that no
    // longer matches it. Both of those are the classic bug here.
    const r = parseCron(rawDraft)
    if (!r.ok) {
      setSwitchError(`That expression is not valid, so the builder cannot show it: ${r.error}`)
      return
    }
    const asSpec = cronToSpec(r.cron)
    if (!asSpec) {
      setSwitchError(
        `"${r.canonical}" is valid but the builder has no control for it. Keep using Custom cron, ` +
          `or pick a preset to start over.`
      )
      return
    }
    onChange(r.canonical)
    setKind(asSpec.kind)
    setSwitchError(null)
    setMode("builder")
  }

  const onRawChange = (text: string) => {
    setRawDraft(text)
    const r = parseCron(text)
    if (r.ok) {
      setRawError(null)
      onChange(r.canonical)
    } else {
      setRawError(r.error)
    }
  }

  const weekdayToggle = (selected: number[], apply: (next: number[]) => void) => (
    <ToggleGroup
      type="multiple"
      value={selected.map(String)}
      onValueChange={(v) => {
        const next = v.map(Number).sort((a, b) => a - b)
        if (next.length === 0) return // never emit an empty week
        apply(next)
      }}
      className="justify-start"
      disabled={disabled}
    >
      {DOW_DISPLAY_ORDER.map((d) => (
        <ToggleGroupItem key={d} value={String(d)} size="sm" className="px-3 text-xs">
          {DOW_LABELS[d]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )

  return (
    <div className="rounded-lg border border-border p-4">
      <Tabs value={mode} onValueChange={switchMode}>
        <TabsList>
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="raw">Custom cron</TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="mt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <label className="mb-1 block text-xs text-muted-foreground">How often</label>
              <Select value={kind} onValueChange={(v) => setKindAndEmit(v as ScheduleSpec["kind"])} disabled={disabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Through the day</SelectItem>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">Certain weekdays</SelectItem>
                  <SelectItem value="monthly">Once a month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {kind !== "hourly" && (
              <div className="w-32">
                <label className="mb-1 block text-xs text-muted-foreground">At</label>
                <Input
                  type="time"
                  step={60}
                  value={`${pad(hour)}:${pad(minute)}`}
                  disabled={disabled}
                  onChange={(e) =>
                    onTime(e.target.value, (h, mi) => {
                      if (kind === "daily") emit({ kind: "daily", minute: mi, hour: h })
                      else if (kind === "weekly") emit({ kind: "weekly", minute: mi, hour: h, dows: dows.length ? dows : [1, 2, 3, 4, 5] })
                      else emit({ kind: "monthly", minute: mi, hour: h, dayOfMonth })
                    })
                  }
                  className="text-sm"
                />
              </div>
            )}

            {kind === "monthly" && (
              <div className="w-32">
                <label className="mb-1 block text-xs text-muted-foreground">Day of month</label>
                <Select
                  value={String(dayOfMonth)}
                  onValueChange={(v) => emit({ kind: "monthly", minute, hour, dayOfMonth: Number(v) })}
                  disabled={disabled}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {DOM_DAYS.map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {kind === "hourly" && (
              <>
                <div className="w-28">
                  <label className="mb-1 block text-xs text-muted-foreground">From</label>
                  <Select
                    value={String(fromHour)}
                    onValueChange={(v) => emit({ kind: "hourly", minute, fromHour: Number(v), toHour: Math.max(Number(v), toHour), everyHours, dows })}
                    disabled={disabled}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {HOURS.map((h) => <SelectItem key={h} value={String(h)}>{pad(h)}:00</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-28">
                  <label className="mb-1 block text-xs text-muted-foreground">To</label>
                  <Select
                    value={String(toHour)}
                    onValueChange={(v) => emit({ kind: "hourly", minute, fromHour: Math.min(fromHour, Number(v)), toHour: Number(v), everyHours, dows })}
                    disabled={disabled}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {HOURS.map((h) => <SelectItem key={h} value={String(h)}>{pad(h)}:00</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32">
                  <label className="mb-1 block text-xs text-muted-foreground">Every</label>
                  <Select
                    value={String(everyHours)}
                    onValueChange={(v) => emit({ kind: "hourly", minute, fromHour, toHour, everyHours: Number(v), dows })}
                    disabled={disabled}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOUR_STEPS.map((n) => <SelectItem key={n} value={String(n)}>{n === 1 ? "hour" : `${n} hours`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-28">
                  <label className="mb-1 block text-xs text-muted-foreground">At minute</label>
                  <Select
                    value={String(minute)}
                    onValueChange={(v) => emit({ kind: "hourly", minute: Number(v), fromHour, toHour, everyHours, dows })}
                    disabled={disabled}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                        <SelectItem key={m} value={String(m)}>:{pad(m)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>

          {(kind === "weekly" || kind === "hourly") && (
            <div className="mt-3">
              <label className="mb-1.5 block text-xs text-muted-foreground">
                {kind === "hourly" ? "On these days (leave all on for every day)" : "On these days"}
              </label>
              {weekdayToggle(
                dows.length ? dows : kind === "hourly" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
                (next) =>
                  kind === "weekly"
                    ? emit({ kind: "weekly", minute, hour, dows: next })
                    : emit({ kind: "hourly", minute, fromHour, toHour, everyHours, dows: next })
              )}
            </div>
          )}

          <p className="mt-3 text-xs text-muted-foreground">
            The finest schedule here is once an hour. Every run resumes the warehouse and opens an
            SSH session to the source, so a five-minute poll for a file that lands once a day costs
            288 of each.
          </p>
        </TabsContent>

        <TabsContent value="raw" className="mt-4">
          <label className="mb-1 block text-xs text-muted-foreground">Cron expression</label>
          <Input
            value={rawDraft}
            onChange={(e) => onRawChange(e.target.value)}
            placeholder="0 7 * * *"
            className="max-w-sm font-mono text-sm"
            disabled={disabled}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Five fields: minute, hour, day-of-month, month, day-of-week. No seconds. Day-of-week is
            0-6 with 0 = Sunday. The minute must be a single number.
          </p>
          {rawError && <p className="mt-2 text-xs text-rose-300">{rawError}</p>}

          <div className="mt-3 flex flex-wrap gap-2">
            {SCHEDULE_PRESETS.map((p) => (
              <Button
                key={p.cron}
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => { setRawDraft(p.cron); setRawError(null); onChange(p.cron) }}
                className="text-xs"
              >
                {p.label}
              </Button>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {switchError && (
        <Banner tone="warning" className="mt-3 p-2">
          {switchError}
        </Banner>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="font-mono text-sm text-foreground">
          {value} <span className="text-muted-foreground">{timezone}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {parsed.ok ? describeCron(parsed.cron) : parsed.error}
        </p>

        <p className="mt-3 text-[10px] uppercase tracking-wide text-muted-foreground">Next runs</p>
        {!now ? (
          <p className="mt-1 text-xs text-muted-foreground">—</p>
        ) : preview && preview.runs.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {preview.runs.map((r, i) => (
              <li key={i} className="font-mono text-xs text-foreground">{formatWallClock(r)}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-amber-300">
            This schedule has no run in the next twenty years. Check the day-of-month and month
            fields.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Worked out by this app, not by Snowflake. Confirm against{" "}
          <code className="text-foreground">SHOW TASKS</code> once the sync is created.
        </p>
      </div>
    </div>
  )
}
