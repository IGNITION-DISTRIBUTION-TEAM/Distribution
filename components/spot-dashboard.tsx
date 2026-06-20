"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  ArrowLeft,
  LogOut,
  Target,
  Upload,
  FileSpreadsheet,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  History,
} from "lucide-react"

const ARPU_TABLE = "SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES"

type NavItem = { id: string; label: string; icon: React.ReactNode }

const navItems: NavItem[] = [
  { id: "arpu-file", label: "ARPU File", icon: <FileSpreadsheet className="h-4 w-4" /> },
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
        <h2 className="text-2xl font-semibold text-foreground">ARPU File</h2>
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
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-medium">Upload complete</span>
          </div>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>Table: <code className="text-xs">{result.table ?? ARPU_TABLE}</code></li>
            {typeof result.rowsParsed === "number" && <li>Rows parsed: {result.rowsParsed}</li>}
            {typeof result.rowsMerged === "number" && <li>Rows merged: {result.rowsMerged}</li>}
            {result.columns && result.columns.length > 0 && (
              <li>Columns: {result.columns.join(", ")}</li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-2">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Last 10 files loaded</h3>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">File</th>
                <th className="px-3 py-2 font-medium">Rows merged</th>
                <th className="px-3 py-2 font-medium">Inserted</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium">Uploaded by</th>
                <th className="px-3 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {historyLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              ) : history.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No files loaded yet.
                  </td>
                </tr>
              ) : (
                history.map((h, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-foreground">{h.fileName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.rowsMerged}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.inserted}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.updated}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.uploadedBy}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.uploadedAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export function SpotDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()
  const [activeNav, setActiveNav] = useState("arpu-file")

  const renderContent = () => {
    switch (activeNav) {
      case "arpu-file":
        return <ArpuFileContent />
      default:
        return <ArpuFileContent />
    }
  }

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <Target className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">Spot</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Processes</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      onClick={() => setActiveNav(item.id)}
                      isActive={activeNav === item.id}
                      tooltip={item.label}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3">
            <div className="px-2 text-sm">
              <p className="font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="w-full justify-start text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Departments
              </Button>
            )}
            <span className="text-sm font-medium text-muted-foreground">Spot Department</span>
          </div>
        </header>

        <main className="flex-1 overflow-auto min-w-0">
          <div className="min-w-0 p-6">{renderContent()}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
