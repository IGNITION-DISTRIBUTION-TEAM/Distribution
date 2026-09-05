"use client"

/**
 * A Spot "Processes" upload page that REPLACES its target table.
 *
 * One component for every entry in lib/spot-uploads.ts. It mirrors the ARPU
 * File page's layout deliberately — same dropzone, same history panel — so the
 * three pages read as one feature rather than two conventions.
 *
 * Two differences, both because this load is destructive where ARPU's merge is
 * not: the button goes through a confirmation naming the table and what it
 * currently holds, and the history panel reports "Rows replaced" instead of
 * Inserted/Updated, which mean nothing when every row is deleted first.
 */
import { useState, useCallback, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
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
import {
  Upload,
  FileSpreadsheet,
  Loader2,
  X,
  History,
} from "lucide-react"
import { fqTable, type SpotUploadProcess } from "@/lib/spot-uploads"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type UploadResult = {
  table?: string
  columns?: string[]
  rowsParsed?: number
  rowsLoaded?: number
  rowsReplaced?: number
}

type UploadHistoryRow = {
  fileName: string
  rowsParsed: number
  rowsLoaded: number
  rowsReplaced: number
  uploadedBy: string
  uploadedAt: string
}

export function FileUploadProcess({ process }: { process: SpotUploadProcess }) {
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [history, setHistory] = useState<UploadHistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [rowsInTarget, setRowsInTarget] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const accept = ".xlsx,.xls,.csv"
  const table = fqTable(process)
  const endpoint = `/api/spot/upload/${process.id}`

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch(endpoint, { method: "GET" })
      const data = await res.json()
      if (res.ok) {
        if (Array.isArray(data.uploads)) setHistory(data.uploads)
        setRowsInTarget(typeof data.rowsInTarget === "number" ? data.rowsInTarget : null)
      }
    } catch {
      // Non-fatal: the panel just stays empty.
    } finally {
      setHistoryLoading(false)
    }
  }, [endpoint])

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
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) {
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
    setConfirming(false)
    setUploading(true)
    setError(null)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(endpoint, { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message || `Upload failed (${res.status})`)
      setResult({
        table: data.table,
        columns: data.columns,
        rowsParsed: data.rowsParsed,
        rowsLoaded: data.rowsLoaded,
        rowsReplaced: data.rowsReplaced,
      })
      setFile(null)
      if (inputRef.current) inputRef.current.value = ""
      loadHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }, [file, endpoint, loadHistory])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeading>{process.label}</PageHeading>
        <p className="mt-1 text-sm text-muted-foreground">
          {process.description} Upload an Excel (.xlsx/.xls) or CSV file.{" "}
          <span className="text-foreground">
            Every row in <code className="rounded bg-muted px-1 py-0.5 text-xs">{table}</code> is
            deleted and replaced by the file&apos;s rows.
          </span>{" "}
          Columns are taken from the file&apos;s header row and must match the table.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {rowsInTarget === null
            ? "Current row count unavailable."
            : `The table currently holds ${rowsInTarget} row${rowsInTarget === 1 ? "" : "s"}.`}
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
        <p className="mt-1 text-xs text-muted-foreground">.xlsx, .xls or .csv · up to 4MB</p>
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
          <div className="flex min-w-0 items-center gap-3">
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
        <Button onClick={() => setConfirming(true)} disabled={!file || uploading}>
          {uploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Replace and load
            </>
          )}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace every row in {process.table}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  <code className="text-xs">{table}</code>{" "}
                  {rowsInTarget === null
                    ? "will be emptied"
                    : `currently holds ${rowsInTarget} row${rowsInTarget === 1 ? "" : "s"}, which will be deleted`}
                  , then reloaded from <span className="text-foreground">{file?.name}</span>.
                </p>
                <p>
                  Columns the file does not contain are left NULL. This cannot be undone from the
                  app.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUpload}>Replace and load</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {error && (
        <Banner tone="error">
          <span className="break-words">{error}</span>
        </Banner>
      )}

      {result && (
        <Banner tone="success">
          <p className="font-medium">Load complete</p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>
              Table: <code className="text-xs">{result.table ?? table}</code>
            </li>
            {typeof result.rowsParsed === "number" && <li>Rows parsed: {result.rowsParsed}</li>}
            {typeof result.rowsLoaded === "number" && (
              <li>Rows now in the table: {result.rowsLoaded}</li>
            )}
            {typeof result.rowsReplaced === "number" && (
              <li>Rows replaced: {result.rowsReplaced}</li>
            )}
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
                <TableHead>Rows loaded</TableHead>
                <TableHead>Rows replaced</TableHead>
                <TableHead>Uploaded by</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No files loaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                history.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-foreground">{h.fileName}</TableCell>
                    <TableCell className="text-muted-foreground">{h.rowsLoaded}</TableCell>
                    <TableCell className="text-muted-foreground">{h.rowsReplaced}</TableCell>
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
