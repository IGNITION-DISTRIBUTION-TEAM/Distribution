"use client"

/**
 * The product mapping screen.
 *
 * What it maintains decides how revenue is attributed in executive reporting:
 * the billing full-history view resolves brand and channel as
 * `coalesce(pg.brand_override, cc.brand)`, so a value typed here overrides the
 * campaign-based classification for that product.
 *
 * Three things in here exist because of that blast radius rather than for
 * polish, and none should be removed to simplify the screen:
 *
 *  - IMPORT IS PREVIEW-THEN-CONFIRM, always. One file can rewrite the whole
 *    catalogue's attribution, and the person uploading it is holding a
 *    spreadsheet, not reading a diff.
 *  - DUPLICATES ARE AN ERROR BANNER, not a footnote. Two rows for one product
 *    name double that product's billing rows in the full-history table, because
 *    the fact table LEFT JOINs to this one. It inflates revenue silently.
 *  - DRIFT IS AN ERROR BANNER. The app writes straight into the BI table, so a
 *    file-driven reload of that table would wipe these edits with no error. The
 *    audit log lives in the app's own schema and is compared against the live
 *    table on every load; a mismatch means something else overwrote us.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Plus, Search, Trash2, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { Banner } from "@/components/kit/banner"
import { SectionHeading } from "@/components/kit/heading"
import { SkeletonRows } from "@/components/kit/skeleton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type Mapping = {
  productName: string
  productGroup: string | null
  vasButtonFlag: string | null
  channelOverride: string | null
  brandOverride: string | null
}

type Verdict = {
  productName: string
  action: "create" | "update" | "unchanged" | "rejected"
  reason?: string
  before?: Mapping | null
  after?: Mapping
}

type ImportCounts = { create: number; update: number; unchanged: number; rejected: number }

const EMPTY: Mapping = {
  productName: "",
  productGroup: null,
  vasButtonFlag: null,
  channelOverride: null,
  brandOverride: null,
}

/** A response body that may not be JSON — an HTML error page, typically. */
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

const PAGE = 100

export function ProductMappingTable() {
  const [rows, setRows] = useState<Mapping[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<{ PRODUCT_KEY: string; ROWS_FOUND: number }[]>([])
  const [driftCount, setDriftCount] = useState(0)

  const [editing, setEditing] = useState<Mapping | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)

  const [preview, setPreview] = useState<{ verdicts: Verdict[]; counts: ImportCounts } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (q: string, off: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ search: q, limit: String(PAGE), offset: String(off) })
      const res = await fetch(`/api/paiment/product-mappings?${params}`, { cache: "no-store" })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      setRows((data.rows as Mapping[]) ?? [])
      setTotal(Number(data.total ?? 0))
      setDuplicates((data.duplicates as { PRODUCT_KEY: string; ROWS_FOUND: number }[]) ?? [])
      setDriftCount(Number(data.driftCount ?? 0))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced so typing in the search box does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(search, offset), 250)
    return () => clearTimeout(t)
  }, [search, offset, load])

  const save = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const res = await fetch("/api/paiment/product-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success(data.created ? "Mapping added" : "Mapping updated")
      setEditing(null)
      await load(search, offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: Mapping) => {
    // A browser confirm rather than a dialog component: the destructive action
    // here is rare, and the product name has to be read carefully before it
    // goes — which is exactly what this forces.
    if (!window.confirm(`Remove the mapping for:\n\n${row.productName}\n\nThis product will go back to campaign-based channel and brand.`)) return
    try {
      const res = await fetch("/api/paiment/product-mappings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productName: row.productName, confirm: "DELETE" }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success("Mapping removed")
      await load(search, offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Parse the workbook in the browser and ask the server what would change.
   *
   * Reuses the same xlsx handling as the campaign upload, including
   * lib/upload-cell-text — Excel renders a 12-digit product code as 1.5E+08 and
   * that string is what a naive parse would send.
   */
  const pickFile = async (file: File) => {
    setImporting(true)
    setPreview(null)
    try {
      const XLSX = await import("xlsx")
      const { cellText } = await import("@/lib/upload-cell-text")
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true })
      const sheetName = wb.SheetNames[0]
      if (!sheetName) throw new Error("That file has no sheets")
      const sheet = wb.Sheets[sheetName]
      const fmt = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false })
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true })
      if (fmt.length === 0) throw new Error("That sheet has no rows")

      // Header names are matched case- and space-insensitively, because the
      // business workbook and the BI table disagree about them already
      // (PRODUCTNAME vs PRODUCT, channel_override vs CHANNEL_OVERRIDE).
      const key = (k: string) => k.replace(/[\s_]+/g, "").toLowerCase()
      const pick = (row: Record<string, unknown>, rawRow: Record<string, unknown>, names: string[]) => {
        for (const k of Object.keys(row)) {
          if (names.includes(key(k))) return cellText(row[k], rawRow[k]).text
        }
        return ""
      }

      const parsed = fmt.map((r, i) => ({
        productName: pick(r, raw[i] ?? {}, ["productname", "product"]),
        productGroup: pick(r, raw[i] ?? {}, ["productgroup"]) || null,
        vasButtonFlag: pick(r, raw[i] ?? {}, ["vasbuttonflag", "vasflag"]) || null,
        channelOverride: pick(r, raw[i] ?? {}, ["channeloverride", "channel"]) || null,
        brandOverride: pick(r, raw[i] ?? {}, ["brandoverride", "brand"]) || null,
      })).filter((r) => r.productName.trim() !== "")

      if (parsed.length === 0) {
        throw new Error(
          "No product names found. The sheet needs a PRODUCTNAME (or PRODUCT) column."
        )
      }

      const res = await fetch("/api/paiment/product-mappings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed, dryRun: true }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      setPreview({
        verdicts: (data.verdicts as Verdict[]) ?? [],
        counts: data.counts as ImportCounts,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const applyImport = async () => {
    if (!preview) return
    setImporting(true)
    try {
      const rowsToSend = preview.verdicts
        .filter((v) => v.action === "create" || v.action === "update")
        .map((v) => v.after as Mapping)
      const res = await fetch("/api/paiment/product-mappings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsToSend, dryRun: false }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? `Failed (${res.status})`))
      toast.success(`${data.applied} mapping(s) written`)
      setPreview(null)
      await load(search, offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  const field = (label: string, value: string | null, onChange: (v: string) => void, mono = false) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? "font-mono text-xs" : undefined}
      />
    </label>
  )

  return (
    <div className="flex flex-col gap-4">
      {error && <Banner tone="error"><span>{error}</span></Banner>}

      {duplicates.length > 0 && (
        <Banner tone="error">
          <span>
            <strong>{duplicates.length} product name{duplicates.length === 1 ? " appears" : "s appear"} more than once.</strong>{" "}
            The billing history joins to this mapping, so a duplicated name multiplies that
            product&apos;s billing rows and overstates its revenue. Remove the extra rows:{" "}
            <span className="font-mono text-xs">
              {duplicates.slice(0, 3).map((d) => d.PRODUCT_KEY).join(", ")}
              {duplicates.length > 3 ? ` and ${duplicates.length - 3} more` : ""}
            </span>
          </span>
        </Banner>
      )}

      {driftCount > 0 && (
        <Banner tone="error">
          <span>
            <strong>{driftCount} mapping{driftCount === 1 ? "" : "s"} no longer match what was saved here.</strong>{" "}
            Something outside this app changed the table — most likely a reload from a file.
            The audit log holds what was intended, so the changes can be re-applied; run{" "}
            <span className="font-mono text-xs">scripts/paiment/00-resolve-and-diagnose.sql</span>{" "}
            section 5 to see them.
          </span>
        </Banner>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>Product mapping</SectionHeading>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void pickFile(f)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              Import spreadsheet
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditing({ ...EMPTY })
                setIsNew(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add product
            </Button>
          </div>
        </div>

        <p className="mt-1 text-sm text-muted-foreground">
          Channel and brand normally come from the campaign. A value in the override columns wins
          for that product, whatever campaign the deal was sold under. Leave an override blank to
          go back to the campaign classification.
        </p>

        <div className="relative mt-4 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
            }}
            placeholder="Search product, group, channel or brand…"
            className="pl-9"
          />
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[24rem]">Product</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>VAS</TableHead>
                <TableHead>Channel override</TableHead>
                <TableHead>Brand override</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <SkeletonRows cols={6} rows={6} />
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    {search ? "No product matches that search." : "No product mappings yet."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.productName}>
                    <TableCell className="font-mono text-xs">{row.productName}</TableCell>
                    <TableCell className="text-xs">{row.productGroup ?? "—"}</TableCell>
                    <TableCell className="text-xs">{row.vasButtonFlag ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {row.channelOverride ?? <span className="text-muted-foreground">campaign</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.brandOverride ?? <span className="text-muted-foreground">campaign</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing({ ...row })
                          setIsNew(false)
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove mapping for ${row.productName}`}
                        onClick={() => void remove(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {total > PAGE && (
          <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {editing && (
        <Card>
          <div className="flex items-center justify-between">
            <SectionHeading>{isNew ? "Add a product mapping" : "Edit mapping"}</SectionHeading>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              {field(
                "Product name (must match the billing data exactly)",
                editing.productName,
                (v) => setEditing({ ...editing, productName: v }),
                true
              )}
            </div>
            {field("Product group", editing.productGroup, (v) =>
              setEditing({ ...editing, productGroup: v })
            )}
            {field("VAS button flag", editing.vasButtonFlag, (v) =>
              setEditing({ ...editing, vasButtonFlag: v })
            )}
            {field("Channel override", editing.channelOverride, (v) =>
              setEditing({ ...editing, channelOverride: v })
            )}
            {field("Brand override", editing.brandOverride, (v) =>
              setEditing({ ...editing, brandOverride: v })
            )}
          </div>

          {!isNew && (
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Renaming the product creates a second mapping rather than renaming this one, because
              the name is what the billing data joins on. Remove the old row afterwards.
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <Button type="button" onClick={() => void save()} disabled={saving || !editing.productName.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {preview && (
        <Card>
          <SectionHeading>Import preview</SectionHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing has been written yet. {preview.counts.create} to add, {preview.counts.update} to
            change, {preview.counts.unchanged} already correct, {preview.counts.rejected} rejected.
          </p>

          {preview.counts.rejected > 0 && (
            <Banner tone="warning" className="mt-3">
              <span>
                {preview.counts.rejected} row{preview.counts.rejected === 1 ? "" : "s"} cannot be
                imported and will be skipped. They are listed below with the reason.
              </span>
            </Banner>
          )}

          <div className="mt-4 max-h-96 overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead className="min-w-[24rem]">Product</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Brand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.verdicts
                  .filter((v) => v.action !== "unchanged")
                  .map((v) => (
                    <TableRow key={`${v.action}-${v.productName}`}>
                      <TableCell className="text-xs">
                        {v.action === "rejected" ? (
                          <span className="text-rose-300">rejected</span>
                        ) : (
                          v.action
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {v.productName || <span className="text-muted-foreground">(blank)</span>}
                        {v.reason && (
                          <span className="mt-0.5 block text-rose-300/80">{v.reason}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.action === "update" && v.before?.channelOverride !== v.after?.channelOverride ? (
                          <>
                            <span className="text-muted-foreground line-through">
                              {v.before?.channelOverride ?? "campaign"}
                            </span>{" "}
                            {v.after?.channelOverride ?? "campaign"}
                          </>
                        ) : (
                          (v.after?.channelOverride ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.action === "update" && v.before?.brandOverride !== v.after?.brandOverride ? (
                          <>
                            <span className="text-muted-foreground line-through">
                              {v.before?.brandOverride ?? "campaign"}
                            </span>{" "}
                            {v.after?.brandOverride ?? "campaign"}
                          </>
                        ) : (
                          (v.after?.brandOverride ?? "—")
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              type="button"
              onClick={() => void applyImport()}
              disabled={importing || preview.counts.create + preview.counts.update === 0}
            >
              {importing
                ? "Writing…"
                : `Apply ${preview.counts.create + preview.counts.update} change(s)`}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
