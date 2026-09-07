"use client"

/**
 * Batch upload check — which batches never fully reached SilverSurfer.
 *
 * Leads loaded into the HLL table are pushed on to SilverSurfer, and sometimes
 * some do not arrive. This shows each batch's HLL count against its
 * SilverSurfer count and re-pushes the missing ones through the same
 * SP_SYNC_TO_SQLSERVER_LARGE call Extend Expired Leads uses.
 *
 * MISSING MEANS "not in SilverSurfer under THIS batch name". A batch that never
 * arrived is missing whole; a batch that half-arrived is missing its gap. The
 * same person legitimately appears in many batches — the CRM works on
 * (person, batch) — so a lead already there from an earlier campaign still
 * needs sending under the new one. An earlier version matched on ID alone and
 * skipped exactly those, understating eight fully-missing batches by about
 * eighty per cent.
 *
 * EVERY CAMPAIGN AT ONCE, by default. Requiring a campaign first was the wrong
 * shape: you do not know which one is short until you have looked, so it meant
 * working through them one at a time. The campaign is a filter now, not a
 * gate, and several campaigns' batches can be re-sent in a single push.
 *
 * THE SCREEN'S JOB IS PARTLY TO STOP YOU. The comparison reads a REPLICA of
 * SilverSurfer, and a replica that is lagging reports every lead as missing. So
 * the freshness of both sides is shown before the table, pressing the button
 * runs a dry run first, and the confirm names the number it is about to send.
 * Without those, the natural failure mode of this feature is pushing a second
 * copy of a whole day's leads into a live CRM.
 *
 * Three counts, not one, because they answer different questions:
 *   In HLL          rows loaded for the batch
 *   In SilverSurfer distinct leads it holds under that batch name
 *   Short by        the difference — "this batch looks incomplete"
 *   Would send      rows whose ID is nowhere in SilverSurfer at all
 * The last two disagree when a lead is already in the CRM under an earlier
 * batch. Only "Would send" is what a push acts on.
 */
import { useCallback, useState } from "react"
import { Loader2, RefreshCw, Search, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Banner } from "@/components/kit/banner"
import { PageHeading, SectionHeading } from "@/components/kit/heading"
import { SkeletonRows } from "@/components/kit/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

type Row = {
  campaignId: string
  batchName: string
  hllCount: number
  ssCount: number
  shortfall: number
  missingByBatch: number
}

type PushStep = { name: string; ok: boolean; rowCount?: number; error?: string }

/** First and last day of the current month, the default window. */
function monthWindow(): { from: string; to: string } {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const y = now.getFullYear()
  const m = now.getMonth()
  const last = new Date(y, m + 1, 0).getDate()
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` }
}

/**
 * Read a response as JSON, but say something useful when it is not.
 *
 * A wrong path 404s to an HTML page, and `res.json()` then throws
 * "Unexpected token '<'" — which sends you looking at the payload instead of
 * at the status code. Same guard EmailExportStep uses.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Server returned ${res.status} (not JSON): ${text.slice(0, 120)}`)
  }
}

export function BatchUploadCheck({
  campaignId,
  campaignTitles,
}: {
  /** "" means every campaign, which is the default. */
  campaignId: string
  /** id -> title, for the campaign column. */
  campaignTitles?: Map<string, string>
}) {
  // Lazy initialisers rather than a memo: this only seeds the first render.
  const [from, setFrom] = useState(() => monthWindow().from)
  const [to, setTo] = useState(() => monthWindow().to)

  const [rows, setRows] = useState<Row[] | null>(null)
  const [freshness, setFreshness] = useState<{ hllLatest: string | null; ssLatest: string | null }>({
    hllLatest: null,
    ssLatest: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Keys are `${campaignId}|${batchName}` — a batch name is only unique within its campaign. */
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const [dryRun, setDryRun] = useState<{ missing: number } | null>(null)
  const [pushing, setPushing] = useState(false)
  const [steps, setSteps] = useState<PushStep[] | null>(null)
  const [note, setNote] = useState<{ tone: "success" | "warning" | "info"; text: string } | null>(null)

  const check = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSteps(null)
    setNote(null)
    try {
      const res = await fetch(
        `/api/distribution/batch-check?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          (campaignId ? `&campaignId=${encodeURIComponent(campaignId)}` : ""),
        { cache: "no-store" }
      )
      const d = await readJson(res)
      if (!res.ok) throw new Error(String(d.error ?? `HTTP ${res.status}`))
      const next = (d.batches as Row[]) ?? []
      setRows(next)
      setFreshness((d.freshness as typeof freshness) ?? { hllLatest: null, ssLatest: null })
      // Everything with something to send starts ticked. The job is "re-send
      // what is missing", so a subset is the exception and has to be chosen —
      // having to tick twelve boxes to do the obvious thing was backwards.
      setPicked(new Set(next.filter((r) => r.missingByBatch > 0).map((r) => `${r.campaignId}|${r.batchName}`)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRows(null)
    } finally {
      setLoading(false)
    }
  }, [campaignId, from, to])

  const keyOf = (r: Row) => `${r.campaignId}|${r.batchName}`
  /** Actionable: leads whose ID is nowhere in SilverSurfer. A re-send acts on these. */
  const short = (rows ?? []).filter((r) => r.missingByBatch > 0)
  /** Diagnostic: the counts do not add up. See the banner on that tab. */
  const shortByCount = (rows ?? []).filter((r) => r.shortfall > 0)
  const pickedRows = (rows ?? []).filter((r) => picked.has(keyOf(r)))
  const wouldSend = pickedRows.reduce((n, r) => n + r.missingByBatch, 0)
  const totalMissing = short.reduce((n, r) => n + r.missingByBatch, 0)
  const pickedCampaigns = new Set(pickedRows.map((r) => r.campaignId)).size

  const toggle = (r: Row) =>
    setPicked((p) => {
      const next = new Set(p)
      const k = keyOf(r)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  /** Tick every short batch — the whole point of showing them all together. */
  const pickAllShort = () => setPicked(new Set(short.map(keyOf)))
  const allPicked = short.length > 0 && picked.size === short.length
  /**
   * Radix's third state. Without it a partly-filled box shows as unchecked,
   * which reads as "nothing selected" when four of twelve are — and that is
   * exactly how you end up re-sending a third of what you meant to.
   */
  const headerState: boolean | "indeterminate" =
    allPicked ? true : picked.size > 0 ? "indeterminate" : false

  /** Count first, always — the confirm needs a number that came from Snowflake. */
  const preview = async () => {
    setPushing(true)
    setError(null)
    setSteps(null)
    setNote(null)
    try {
      const res = await fetch("/api/distribution/batch-check/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, picks: pickedRows.map((r) => ({ campaignId: Number(r.campaignId), batchName: r.batchName })) }),
      })
      const d = await readJson(res)
      if (!res.ok) throw new Error(String(d.error ?? `HTTP ${res.status}`))
      setDryRun({ missing: Number(d.missing ?? 0) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPushing(false)
    }
  }

  const doPush = async () => {
    setDryRun(null)
    setPushing(true)
    setError(null)
    try {
      const res = await fetch("/api/distribution/batch-check/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          picks: pickedRows.map((r) => ({ campaignId: Number(r.campaignId), batchName: r.batchName })),
          confirm: "PUSH",
        }),
      })
      const d = await readJson(res)
      if (!res.ok) throw new Error(String(d.error ?? `HTTP ${res.status}`))
      setSteps((d.steps as PushStep[]) ?? [])
      setNote(
        Number(d.pushed ?? 0) > 0
          ? { tone: "success", text: `Sent ${Number(d.pushed).toLocaleString()} lead(s) to Upload.TempUpload.` }
          : { tone: "info", text: "Nothing was sent — nothing was missing by the time it ran." }
      )
      await check()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeading description="Compares each batch's leads in the HLL table against what reached SilverSurfer, and re-sends the ones that never arrived.">
        Batch upload check
      </PageHeading>

      <Card padding="dense">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-2 block text-sm text-muted-foreground">Created on</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
              <span className="text-sm text-muted-foreground">to</span>
              <Input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-44" />
            </div>
          </div>
          <Button onClick={() => void check()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Check batches
          </Button>
          {rows !== null && (
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void check()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Defaults to this month, which is the window the reconciliation was written for.
        </p>
      </Card>

      {error && <Banner tone="error">{error}</Banner>}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}

      {/* The most important thing on the page. SilverSurfer here is a replica,
          so if its newest row is well behind the HLL's, "missing" means "not
          replicated yet" and pushing would send duplicates. */}
      {rows !== null && (
        <Banner tone="warning">
          SilverSurfer is read from a replicated copy, so it lags the live CRM. Newest row in
          HLL: <span className="font-mono">{freshness.hllLatest ?? "unknown"}</span>. Newest in
          SilverSurfer: <span className="font-mono">{freshness.ssLatest ?? "unknown"}</span>. If
          those are far apart, a batch may look short only because the copy has not caught up —
          wait rather than re-sending.
        </Banner>
      )}

      {rows !== null && (
        <Card padding="dense">
          <Tabs defaultValue="missing">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <TabsList>
                <TabsTrigger value="missing">Needs reloading ({short.length})</TabsTrigger>
                <TabsTrigger value="shortfall">All batches ({rows.length})</TabsTrigger>
              </TabsList>
              <Badge variant="secondary">{rows.length} batches</Badge>
              {short.length > 0 && (
                <>
                  <span className="ml-auto text-sm text-muted-foreground">
                    {picked.size} of {short.length} selected
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => (allPicked ? setPicked(new Set()) : pickAllShort())}
                  >
                    {allPicked ? "Clear selection" : `Select all ${short.length}`}
                  </Button>
                </>
              )}
            </div>

            {/* ---- the actionable one ---- */}
            <TabsContent value="missing">
              <p className="mb-3 text-sm text-muted-foreground">
                Leads SilverSurfer does not hold under this batch name. A batch that never
                arrived shows its whole count; one that half-arrived shows the gap.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={headerState}
                        aria-label={allPicked ? "Clear selection" : `Select all ${short.length} batches`}
                        onCheckedChange={() => (allPicked ? setPicked(new Set()) : pickAllShort())}
                      />
                    </TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">In HLL</TableHead>
                    <TableHead className="text-right">Would send</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 ? (
                    <SkeletonRows cols={5} rows={5} />
                  ) : short.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-sm text-muted-foreground">
                        Nothing to reload — every batch is complete in SilverSurfer.
                      </TableCell>
                    </TableRow>
                  ) : (
                    short.map((r) => (
                      <TableRow key={keyOf(r)}>
                        <TableCell>
                          <Checkbox
                            checked={picked.has(keyOf(r))}
                            aria-label={`Select ${r.batchName}`}
                            onCheckedChange={() => toggle(r)}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <span className="tabular-nums text-foreground">{r.campaignId}</span>
                          {campaignTitles?.get(r.campaignId) && (
                            <span className="ml-1 text-muted-foreground">
                              {campaignTitles.get(r.campaignId)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.batchName}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.hllCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-rose-300">
                          {r.missingByBatch.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={() => void preview()} disabled={picked.size === 0 || pushing}>
                  {pushing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Re-send missing leads
                </Button>
                <span className="text-sm text-muted-foreground">
                  {picked.size === 0 ? (
                    "Pick one or more batches, or tick the box in the header to take all of them."
                  ) : (
                    <>
                      {picked.size} of {short.length} batch(es) across {pickedCampaigns} campaign(s),
                      about {wouldSend.toLocaleString()} lead(s).
                      {/* Says the quiet part out loud. Selecting a subset is fine;
                          not NOTICING you selected a subset is the problem. */}
                      {picked.size < short.length && (
                        <span className="text-amber-200">
                          {" "}
                          {(totalMissing - wouldSend).toLocaleString()} missing lead(s) in the{" "}
                          {short.length - picked.size} unticked batch(es) will not be sent.
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
            </TabsContent>

            {/* ---- the diagnostic one ---- */}
            <TabsContent value="shortfall">
              <p className="mb-3 text-sm text-muted-foreground">
                Every batch in the window, whether it needs anything or not. Read-only — use the
                other tab to reload. A SilverSurfer count above the HLL count means the batch name
                has been used before.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">In HLL</TableHead>
                    <TableHead className="text-right">In SilverSurfer</TableHead>
                    <TableHead className="text-right">Needs reloading</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 ? (
                    <SkeletonRows cols={5} rows={5} />
                  ) : (
                    rows.map((r) => (
                      <TableRow key={keyOf(r)} className={cn(r.missingByBatch > 0 && "bg-rose-500/5")}>
                        <TableCell className="whitespace-nowrap text-xs">
                          <span className="tabular-nums text-foreground">{r.campaignId}</span>
                          {campaignTitles?.get(r.campaignId) && (
                            <span className="ml-1 text-muted-foreground">
                              {campaignTitles.get(r.campaignId)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.batchName}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.hllCount.toLocaleString()}</TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            r.ssCount === 0 ? "text-amber-200" : "text-muted-foreground"
                          )}
                        >
                          {r.ssCount.toLocaleString()}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            r.missingByBatch > 0 ? "font-medium text-rose-300" : "text-muted-foreground"
                          )}
                        >
                          {r.missingByBatch > 0 ? r.missingByBatch.toLocaleString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        </Card>
      )}

      {steps && (
        <Card padding="dense">
          <SectionHeading className="mb-3">What ran</SectionHeading>
          <div className="flex flex-col gap-1 text-sm">
            {steps.map((s) => (
              <div key={s.name} className="flex flex-wrap items-center gap-2">
                <span className={s.ok ? "text-emerald-300" : "text-rose-300"}>{s.ok ? "ok" : "failed"}</span>
                <span className="font-mono text-xs">{s.name}</span>
                {s.rowCount != null && <span className="text-muted-foreground">{s.rowCount.toLocaleString()} rows</span>}
                {s.error && <span className="break-words text-xs text-rose-300">{s.error}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* The count in here came back from Snowflake a moment ago, not from the
          table above — the table may be minutes stale, and this is the number
          being agreed to. */}
      <AlertDialog open={dryRun !== null} onOpenChange={(o) => !o && setDryRun(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-send {dryRun?.missing.toLocaleString()} lead(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This writes to <span className="font-mono">Upload.TempUpload</span> on the
              SilverSurfer side, from {picked.size} batch(es) across {pickedCampaigns} campaign(s).
              Leads keep the expiry they were
              loaded with — this re-sends them, it does not extend them.
              {dryRun?.missing === 0 && " Nothing is missing now, so nothing will be sent."}
              <br />
              <br />
              If the freshness line showed SilverSurfer well behind HLL, cancel: these leads may
              have arrived already and simply not been copied back yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doPush()} disabled={dryRun?.missing === 0}>
              Re-send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
