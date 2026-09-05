"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Target,
  Upload,
  FileSpreadsheet,
  Loader2,
  X,
  History,
} from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { FileUploadProcess } from "@/components/spot/file-upload-process"
import { SPOT_UPLOADS, getSpotUpload } from "@/lib/spot-uploads"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SkeletonRows } from "@/components/kit/skeleton"

const ARPU_TABLE = "SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES"

type NavItem = { id: string; label: string; icon: React.ReactNode }

/**
 * ARPU File is listed explicitly because it has its own route and merge
 * semantics; the replace-mode processes come from the registry, so adding one
 * there puts it in this menu without touching this file.
 */
const navItems: NavItem[] = [
  { id: "arpu-file", label: "ARPU File", icon: <FileSpreadsheet className="h-4 w-4" /> },
  ...SPOT_UPLOADS.map((p) => ({
    id: p.id,
    label: p.label,
    icon: <FileSpreadsheet className="h-4 w-4" />,
  })),
]

type UploadResult = {
  rowsMerged?: number
  rowsParsed?: number
  columns?: string[]
  table?: string
}

type UploadHistoryRow = {
  fileName: string
  rowsParsed: number
  rowsMerged: number
  inserted: number
  updated: number
  uploadedBy: string
  uploadedAt: string
}

function ArpuFileContent() {
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [history, setHistory] = useState<UploadHistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = ".xlsx,.xls,.csv"

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch("/api/spot/arpu-upload", { method: "GET" })
      const data = await res.json()
      if (res.ok && Array.isArray(data.uploads)) setHistory(data.uploads)
    } catch {
      // Non-fatal: the panel just stays empty.
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const pickFile = useCallback((f: File | null) => {
    setError(null)
    setResult(null)
    if (!f) {
      setFile(null)
      return
    }
    const ok = /\.(xlsx|xls|csv)$/i.test(f.name)
    if (!ok) {
      setError("Only .xlsx, .xls, or .csv files are accepted.")
      setFile(null)
      return
    }
    setFile(f)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      pickFile(e.dataTransfer.files?.[0] ?? null)
    },
    [pickFile]
  )

  const handleUpload = useCallback(async () => {
    if (!file) return
    setUploading(true)
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/spot/arpu-upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message || `Upload failed (${res.status})`)
      setResult({
        rowsMerged: data.rowsMerged,
        rowsParsed: data.rowsParsed,
        columns: data.columns,
        table: data.table,
      })
      setFile(null)
      if (inputRef.current) inputRef.current.value = ""
      loadHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }, [file, loadHistory])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>ARPU File</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload an Excel (.xlsx/.xls) or CSV file. Its rows are loaded into{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{ARPU_TABLE}</code>. Columns are
          taken from the file&apos;s header row.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={[
          "rounded-xl border-2 border-dashed p-10 text-center transition",
          dragging ? "border-primary bg-primary/5" : "border-border bg-card",
        ].join(" ")}
      >
        <Upload className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-3 text-sm text-foreground">
          Drag a file here, or{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => inputRef.current?.click()}
          >
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">.xlsx, .xls or .csv · up to 50MB</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {file && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pickFile(null)}
            disabled={uploading}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div>
        <Button onClick={handleUpload} disabled={!file || uploading}>
          {uploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Upload to Snowflake
            </>
          )}
        </Button>
      </div>

      {error && (
        <Banner tone="error">
          <span className="break-words">{error}</span>
        </Banner>
      )}

      {result && (
        <Banner tone="success">
          <p className="font-medium">Upload complete</p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>Table: <code className="text-xs">{result.table ?? ARPU_TABLE}</code></li>
            {typeof result.rowsParsed === "number" && <li>Rows parsed: {result.rowsParsed}</li>}
            {typeof result.rowsMerged === "number" && <li>Rows merged: {result.rowsMerged}</li>}
            {result.columns && result.columns.length > 0 && (
              <li>Columns: {result.columns.join(", ")}</li>
            )}
          </ul>
        </Banner>
      )}

      <div className="mt-2">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Last 10 files loaded</h3>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Rows merged</TableHead>
                <TableHead>Inserted</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Uploaded by</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyLoading ? (
                <SkeletonRows cols={6} rows={5} />
              ) : history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No files loaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                history.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-foreground">{h.fileName}</TableCell>
                    <TableCell className="text-muted-foreground">{h.rowsMerged}</TableCell>
                    <TableCell className="text-muted-foreground">{h.inserted}</TableCell>
                    <TableCell className="text-muted-foreground">{h.updated}</TableCell>
                    <TableCell className="text-muted-foreground">{h.uploadedBy}</TableCell>
                    <TableCell className="text-muted-foreground">{h.uploadedAt}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

export function SpotDashboard({ onBack }: { onBack?: () => void }) {
  const [activeNav, setActiveNav] = useState("arpu-file")

  const renderContent = () => {
    if (activeNav === "arpu-file") return <ArpuFileContent />
    const process = getSpotUpload(activeNav)
    if (process) return <FileUploadProcess key={process.id} process={process} />
    // An unknown id used to fall through to ARPU, which silently showed the
    // wrong process. Say so instead.
    return (
      <p className="text-sm text-muted-foreground">
        Unknown process &quot;{activeNav}&quot;. Pick one from the menu.
      </p>
    )
  }

  return (
    <DepartmentShell
      brand={{ icon: <Target />, label: "Spot" }}
      nav={[{ id: "processes", label: "Processes", items: navItems }]}
      activeId={activeNav}
      onNavigate={setActiveNav}
      onBack={onBack}
    >
      {renderContent()}
    </DepartmentShell>
  )
}
