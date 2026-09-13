"use client"

/**
 * Mapping active SilverSurfer campaigns to Yaxxa dialler campaigns.
 *
 * ONE SILVERSURFER CAMPAIGN, MANY YAXXA ONES — so the layout is a list of
 * SilverSurfer campaigns, each owning its Yaxxa campaigns as chips. A
 * side-by-side two-column picker would suggest a pairing, which this is not.
 *
 * The one behaviour worth knowing before you use it: a Yaxxa campaign can only
 * belong to ONE SilverSurfer campaign, so attaching one that is already
 * attached MOVES it. The picker separates the free ones from the taken ones and
 * the toast says where it moved from — re-parenting a live dialler campaign
 * should be a visible choice, not a surprise found later.
 */

import { useCallback, useEffect, useState } from "react"
import { Link2, Plus, Search, X } from "lucide-react"
import { toast } from "sonner"
import { Banner } from "@/components/kit/banner"
import { DEFAULT_PAGE_SIZE, Pager } from "@/components/kit/pager"
import { SectionHeading } from "@/components/kit/heading"
import { SkeletonPanel } from "@/components/kit/skeleton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { pageInfo } from "@/lib/pagination"

type Attached = { yaxxaId: string; yaxxaName: string | null }
type SsCampaign = { id: string; title: string; yaxxa: Attached[] }
type YaxxaCampaign = {
  id: string
  name: string
  /** Positionally matched to extraColumns — status, type, dialler, description. */
  extras: string[]
  ownedBy: { ssId: string; ssTitle: string | null } | null
}
type Resolved = { table: string; id: string | null; label: string | null }

/**
 * The Yaxxa picker asks for this many and no more.
 *
 * Not paged, deliberately — see the truncation notice below. Paging inside a
 * dropdown loses your place; typing three letters of the campaign name does
 * not.
 */
const YAXXA_PICKER_LIMIT = 50

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(
      res.ok
        ? "The server returned something that is not JSON."
        : `HTTP ${res.status}: ${text.slice(0, 200)}`
    )
  }
}

export function CampaignMapper() {
  const [campaigns, setCampaigns] = useState<SsCampaign[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unmapped, setUnmapped] = useState(0)
  const [staleCount, setStaleCount] = useState(0)
  const [doubleBookedCount, setDoubleBookedCount] = useState(0)
  const [resolved, setResolved] = useState<{ silversurfer: Resolved; yaxxa: Resolved } | null>(null)

  // The picker is open for at most one campaign at a time.
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [yaxxaSearch, setYaxxaSearch] = useState("")
  const [yaxxaRows, setYaxxaRows] = useState<YaxxaCampaign[]>([])
  const [yaxxaExtraColumns, setYaxxaExtraColumns] = useState<string[]>([])
  const [yaxxaTotal, setYaxxaTotal] = useState(0)
  const [yaxxaLoading, setYaxxaLoading] = useState(false)
  const [showTaken, setShowTaken] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (q: string, off: number, size: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ search: q, limit: String(size), offset: String(off) })
      const res = await fetch(`/api/dialler/campaign-map?${params}`, { cache: "no-store" })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      setCampaigns((data.campaigns as SsCampaign[]) ?? [])
      setTotal(Number(data.total ?? 0))
      setUnmapped(Number(data.unmapped ?? 0))
      setStaleCount(Number(data.staleCount ?? 0))
      setDoubleBookedCount(Number(data.doubleBookedCount ?? 0))
      setResolved((data.resolved as { silversurfer: Resolved; yaxxa: Resolved }) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCampaigns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(search, offset, pageSize), 250)
    return () => clearTimeout(t)
  }, [search, offset, pageSize, load])

  const loadYaxxa = useCallback(async (q: string) => {
    setYaxxaLoading(true)
    try {
      const params = new URLSearchParams({ search: q, limit: String(YAXXA_PICKER_LIMIT) })
      const res = await fetch(`/api/dialler/campaign-map/yaxxa?${params}`, { cache: "no-store" })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      setYaxxaRows((data.campaigns as YaxxaCampaign[]) ?? [])
      setYaxxaExtraColumns((data.extraColumns as string[]) ?? [])
      setYaxxaTotal(Number(data.total ?? 0))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setYaxxaRows([])
    } finally {
      setYaxxaLoading(false)
    }
  }, [])

  useEffect(() => {
    if (pickerFor === null) return
    const t = setTimeout(() => void loadYaxxa(yaxxaSearch), 250)
    return () => clearTimeout(t)
  }, [pickerFor, yaxxaSearch, loadYaxxa])

  const pager = pageInfo(total, pageSize, offset)

  const attach = async (ss: SsCampaign, y: YaxxaCampaign) => {
    if (y.ownedBy && y.ownedBy.ssId !== ss.id) {
      const owner = y.ownedBy.ssTitle || y.ownedBy.ssId
      if (
        !window.confirm(
          `"${y.name}" is currently mapped to:\n\n${owner}\n\n` +
            `Attaching it here MOVES it — a Yaxxa campaign can only belong to one ` +
            `SilverSurfer campaign. Continue?`
        )
      )
        return
    }
    setBusy(y.id)
    try {
      const res = await fetch("/api/dialler/campaign-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssId: ss.id,
          ssTitle: ss.title,
          yaxxaId: y.id,
          yaxxaName: y.name,
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      const moved = data.movedFrom as { ssTitle: string | null; ssId: string } | null
      toast.success(
        moved
          ? `Moved "${y.name}" from ${moved.ssTitle || moved.ssId}`
          : `Attached "${y.name}"`
      )
      await Promise.all([load(search, offset, pageSize), loadYaxxa(yaxxaSearch)])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const detach = async (ss: SsCampaign, a: Attached) => {
    setBusy(a.yaxxaId)
    try {
      const res = await fetch("/api/dialler/campaign-map", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssId: ss.id, yaxxaId: a.yaxxaId }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success("Detached")
      await load(search, offset, pageSize)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const visibleYaxxa = showTaken ? yaxxaRows : yaxxaRows.filter((y) => !y.ownedBy)

  return (
    <div className="flex flex-col gap-4">
      {error && <Banner tone="error"><span>{error}</span></Banner>}

      {doubleBookedCount > 0 && (
        <Banner tone="error">
          <span>
            <strong>
              {doubleBookedCount} Yaxxa campaign{doubleBookedCount === 1 ? " is" : "s are"} mapped
              to more than one SilverSurfer campaign.
            </strong>{" "}
            That should not be possible — the mapping is keyed on the Yaxxa campaign — but
            Snowflake does not enforce primary keys, so it is checked rather than assumed. Detach
            the wrong one; until then which mapping wins is undefined.
          </span>
        </Banner>
      )}

      {staleCount > 0 && (
        <Banner tone="warning">
          <span>
            <strong>{staleCount} mapping{staleCount === 1 ? "" : "s"} point at a campaign that is gone or no longer active.</strong>{" "}
            They match nothing and will keep matching nothing. Run{" "}
            <span className="font-mono text-xs">scripts/dialler/00-discover-columns.sql</span>{" "}
            section 4 to list them.
          </span>
        </Banner>
      )}

      {resolved && (
        <Card>
          <SectionHeading>Where this reads from</SectionHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Neither table has been read by this app before, so the id and name columns are
            resolved at load rather than assumed. If either looks wrong, the list below will
            too — the candidates are in{" "}
            <span className="font-mono text-xs">lib/dialler-campaign-map.ts</span>.
          </p>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            {[resolved.silversurfer, resolved.yaxxa].map((r) => (
              <div key={r.table} className="rounded-md border border-border p-2">
                <div className="break-all font-mono text-foreground">{r.table}</div>
                <div className="mt-1 text-muted-foreground">
                  id <span className="font-mono text-foreground">{r.id ?? "—"}</span>
                  {" · "}name <span className="font-mono text-foreground">{r.label ?? "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>Active SilverSurfer campaigns</SectionHeading>
          <span className="text-sm text-muted-foreground">
            {unmapped > 0 ? `${unmapped} with no Yaxxa campaign attached` : "All mapped"}
          </span>
        </div>

        <p className="mt-1 text-sm text-muted-foreground">
          One SilverSurfer campaign can feed several Yaxxa campaigns. A Yaxxa campaign belongs to
          only one SilverSurfer campaign, so attaching one that is already mapped moves it.
        </p>

        <div className="relative mt-4 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
            }}
            placeholder="Search campaign name or id…"
            className="pl-9"
          />
        </div>

        <div className="mt-3">
          <Pager
            info={pager}
            total={total}
            pageSize={pageSize}
            noun="active campaigns"
            showSize
            onOffset={setOffset}
            onPageSize={(size) => {
              // Back to page 1: page 3 of 50-a-page does not exist at 200.
              setPageSize(size)
              setOffset(0)
            }}
          />
        </div>

        {loading ? (
          <SkeletonPanel className="mt-4" />
        ) : campaigns.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {search ? "No campaign matches that search." : "No active campaigns found."}
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {campaigns.map((ss) => (
              <div key={ss.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-foreground">{ss.title}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{ss.id}</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPickerFor(pickerFor === ss.id ? null : ss.id)
                      setYaxxaSearch("")
                      setShowTaken(false)
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Attach Yaxxa campaign
                  </Button>
                </div>

                {ss.yaxxa.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Nothing attached — this campaign has no dialler campaign mapped to it.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ss.yaxxa.map((a) => (
                      <span
                        key={a.yaxxaId}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                      >
                        <Link2 className="h-3 w-3 text-muted-foreground" />
                        <span className="text-foreground">{a.yaxxaName || a.yaxxaId}</span>
                        <span className="font-mono text-muted-foreground">{a.yaxxaId}</span>
                        <button
                          type="button"
                          aria-label={`Detach ${a.yaxxaName || a.yaxxaId}`}
                          disabled={busy !== null}
                          className="text-muted-foreground hover:text-rose-300 disabled:opacity-40"
                          onClick={() => void detach(ss, a)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {pickerFor === ss.id && (
                  <div className="mt-3 rounded-md border border-border p-2">
                    <Input
                      autoFocus
                      value={yaxxaSearch}
                      onChange={(e) => setYaxxaSearch(e.target.value)}
                      placeholder="Search Yaxxa campaigns…"
                      className="h-8 text-xs"
                    />
                    {yaxxaTotal > yaxxaRows.length && (
                      <p className="mt-1.5 text-xs text-amber-200">
                        Showing the first {yaxxaRows.length} of {yaxxaTotal} — type a few letters
                        of the campaign name to narrow it. A campaign missing from this list is
                        not necessarily missing from the dialler.
                      </p>
                    )}
                    <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={showTaken}
                        onChange={(e) => setShowTaken(e.target.checked)}
                      />
                      Include campaigns already mapped elsewhere (attaching one moves it)
                    </label>

                    <div className="mt-2 max-h-64 overflow-auto">
                      {yaxxaLoading ? (
                        <SkeletonPanel />
                      ) : visibleYaxxa.length === 0 ? (
                        <p className="px-1 py-3 text-xs text-muted-foreground">
                          {showTaken
                            ? "No Yaxxa campaign matches."
                            : "No unmapped Yaxxa campaign matches — tick the box above to move one."}
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                          {visibleYaxxa.map((y) => (
                            <li
                              key={y.id}
                              className="flex items-center justify-between gap-2 px-1 py-1.5"
                            >
                              <span className="min-w-0">
                                <span className="text-xs text-foreground">{y.name || y.id}</span>
                                {/* The id is load bearing, not decoration: three
                                    campaigns really are called "VC CVM Upgrades". */}
                                <span className="ml-2 font-mono text-xs text-muted-foreground">
                                  {y.id}
                                </span>
                                {y.ownedBy && (
                                  <span className="ml-2 text-xs text-amber-200">
                                    mapped to {y.ownedBy.ssTitle || y.ownedBy.ssId}
                                  </span>
                                )}
                                {yaxxaExtraColumns.length > 0 && (
                                  <span className="mt-0.5 block text-xs text-muted-foreground">
                                    {yaxxaExtraColumns.map((col, i) => {
                                      const v = y.extras[i]
                                      if (!v) return null
                                      // CAMP_DESC is the readable name when
                                      // CAMP_NAME is cryptic ("VCCVMUpgrades"),
                                      // and noise when it just repeats it.
                                      if (col === "CAMP_DESC") {
                                        return v.trim().toUpperCase() ===
                                          y.name.trim().toUpperCase() ? null : (
                                          <span key={col} className="mr-2 italic">
                                            {v}
                                          </span>
                                        )
                                      }
                                      return (
                                        <span key={col} className="mr-2">
                                          {col.replace(/^CAMP_/, "").toLowerCase()}{" "}
                                          <span className="text-foreground">{v}</span>
                                        </span>
                                      )
                                    })}
                                  </span>
                                )}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busy !== null || y.ownedBy?.ssId === ss.id}
                                onClick={() => void attach(ss, y)}
                              >
                                {y.ownedBy?.ssId === ss.id
                                  ? "Attached"
                                  : y.ownedBy
                                    ? "Move here"
                                    : "Attach"}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {pager.pages > 1 && (
          <div className="mt-4">
            <Pager
              info={pager}
              total={total}
              pageSize={pageSize}
              noun="active campaigns"
              onOffset={setOffset}
              onPageSize={setPageSize}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
