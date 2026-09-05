"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle2, FileSpreadsheet, Loader2, Upload, X } from "lucide-react"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"

type Status = { rows: number; deals: number; stages: number; categories: number; lastAt: string | null; lastBy: string | null }
type Result = {
  sheet: string
  sheetsAvailable: string[]
  stageColumn: string
  categoryColumn: string
  rows: number
  deals: number
  unmatchedStages: number
  byStage: { stage: string; count: number }[]
}

export function SpotReportPipelineUpload() {
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/spot-report/pipeline-upload")
      const d = await r.json()
      if (r.ok) setStatus(d)
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const pick = (f: File | null) => {
    setError(null)
    setResult(null)
    if (!f) return setFile(null)
    if (!/\.(xlsx|xls)$/i.test(f.name)) {
      setError("Only .xlsx/.xls files are accepted.")
      return setFile(null)
    }
    setFile(f)
  }

  const upload = async () => {
    if (!file) return
    setUploading(true)
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const r = await fetch("/api/spot-report/pipeline-upload", { method: "POST", body: fd })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`)
      setResult(d as Result)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ""
      loadStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5 p-6">
      <div>
        <PageHeading>Pipeline upload</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload the BDM pipeline workbook (<span className="font-mono text-xs">Pipeline.xlsx</span>). It&apos;s parsed
          into Snowflake and drives the Pipeline &amp; Provisional Commissions page. The parser finds the stage column by
          matching the known pipeline stages and detects the category column; re-uploading replaces the stored pipeline.
        </p>
      </div>

      {status && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Stored deals</p>
            <p className="mt-0.5 text-2xl font-semibold text-foreground">{status.deals.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">{status.stages} stages · {status.categories} categories</p>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Stage×category rows</p>
            <p className="mt-0.5 text-2xl font-semibold text-foreground">{status.rows.toLocaleString()}</p>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last upload</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{status.lastAt ?? "—"}</p>
            {status.lastBy && <p className="text-xs text-muted-foreground">{status.lastBy}</p>}
          </div>
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0] ?? null) }}
        className={[
          "rounded-xl border-2 border-dashed p-10 text-center transition",
          dragging ? "border-primary bg-primary/5" : "border-border bg-card",
        ].join(" ")}
      >
        <Upload className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-3 text-sm text-foreground">
          Drag the workbook here, or{" "}
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => inputRef.current?.click()}>
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">.xlsx · up to 25MB · reads the &quot;retail and debit orde&quot; sheet</p>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </div>

      {file && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => pick(null)} disabled={uploading} aria-label="Remove">
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div>
        <Button onClick={upload} disabled={!file || uploading}>
          {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…</> : <><Upload className="mr-2 h-4 w-4" /> Upload &amp; store</>}
        </Button>
      </div>

      {error && (
        <Banner tone="error">
          <span className="break-words">{error}</span>
        </Banner>
      )}

      {result && (
        <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Stored <b>{result.deals.toLocaleString()}</b> deals across {result.rows.toLocaleString()} stage×category rows.
            </span>
          </div>
          <div className="pl-6 text-xs text-emerald-200/90">
            <p>Sheet: <span className="font-mono">{result.sheet}</span> · stage column: <span className="font-mono">{result.stageColumn}</span> · category column: <span className="font-mono">{result.categoryColumn}</span></p>
            {result.unmatchedStages > 0 && (
              <p className="mt-1 text-amber-300">{result.unmatchedStages} row(s) had a stage value that didn&apos;t match a known stage and were skipped.</p>
            )}
            <p className="mt-1">By stage: {result.byStage.map((s) => `${s.stage} (${s.count})`).join(" · ")}</p>
          </div>
          <p className="pl-6 text-xs text-emerald-200/70">
            Check the detected columns and stage breakdown above look right. If a column was mis-detected, tell me the
            correct header names and I&apos;ll pin them.
          </p>
        </div>
      )}
    </div>
  )
}
