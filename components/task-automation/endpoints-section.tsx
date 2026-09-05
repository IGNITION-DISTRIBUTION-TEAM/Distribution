"use client"

/**
 * SFTP endpoints — list, edit, disable, and draft a new one.
 *
 * WHAT THE APP CAN SEE. Everything here comes from a SECURE VIEW that exposes
 * name, label, roots, caps, enabled and notes. The host, the SFTP user and the
 * pinned host key are not in it, and the app has no privilege on the table
 * underneath — so they cannot appear on this screen even by accident.
 *
 * WHAT THE APP CAN CHANGE. Label, allowed root, the three caps, enabled and
 * notes, through SP_SFTP_ENDPOINT_UPDATE. Snowflake has no column-level UPDATE
 * privilege, so that procedure IS the boundary rather than a convenience.
 *
 * WHAT IT CANNOT DO. Create or delete a row. A row pairs a host with the key
 * trusted for it; if the app could write both, a bug or a crafted request could
 * point the downloader at any server and have it authenticate there with the
 * real private key. So "New endpoint" validates the whole form and hands back
 * SQL for someone with Snowflake access to run, and "delete" is disable.
 */
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { Check, Copy, Loader2, Pencil, Plus, Power, RefreshCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  EMPTY_ENDPOINT,
  HOST_KEY_TYPES,
  buildEndpointInsert,
  validateEndpoint,
  type EndpointDraft,
} from "@/lib/sftp-endpoint-sql"
import { Card } from "@/components/ui/card"
import { PageHeading, SectionHeading } from "@/components/kit/heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Endpoint = {
  name: string
  label: string
  allowedRoot: string
  rootFloor: string
  enabled: boolean
  maxEntries: number
  maxPeekLines: number
  maxPeekBytes: number
  notes: string
  updatedAt: string | null
  updatedBy: string | null
}

type EditForm = {
  label: string
  allowedRoot: string
  maxEntries: string
  maxPeekLines: string
  maxPeekBytes: string
  notes: string
  enabled: boolean
}

export function EndpointsSection() {
  const [rows, setRows] = useState<Endpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [editing, setEditing] = useState<Endpoint | null>(null)
  const [form, setForm] = useState<EditForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [toggle, setToggle] = useState<Endpoint | null>(null)

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/task-automation/endpoints", { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setRows(d.endpoints ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openEdit = (e: Endpoint) => {
    setCreating(false)
    setEditing(e)
    setForm({
      label: e.label,
      allowedRoot: e.allowedRoot,
      maxEntries: String(e.maxEntries),
      maxPeekLines: String(e.maxPeekLines),
      maxPeekBytes: String(e.maxPeekBytes),
      notes: e.notes,
      enabled: e.enabled,
    })
  }

  const save = async (override?: Partial<EditForm>, target?: Endpoint) => {
    const e = target ?? editing
    const f = { ...(form ?? ({} as EditForm)), ...(override ?? {}) }
    if (!e) return
    setSaving(true)
    setNote(null)
    try {
      const res = await fetch("/api/task-automation/endpoints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: e.name,
          label: f.label ?? e.label,
          allowedRoot: f.allowedRoot ?? e.allowedRoot,
          maxEntries: Number(f.maxEntries ?? e.maxEntries),
          maxPeekLines: Number(f.maxPeekLines ?? e.maxPeekLines),
          maxPeekBytes: Number(f.maxPeekBytes ?? e.maxPeekBytes),
          enabled: f.enabled ?? e.enabled,
          notes: f.notes ?? e.notes,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setNote(`${e.name} updated.`)
      setEditing(null)
      setForm(null)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
      void load()
    }
  }

  const draftErrors = validateEndpoint(draft)
  let draftSql = ""
  try {
    draftSql = draftErrors.length === 0 ? buildEndpointInsert(draft) : ""
  } catch {
    draftSql = ""
  }
  const set = (k: keyof EndpointDraft, v: string | number) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <PageHeading>SFTP endpoints</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            The servers this app may browse. Host, SFTP user and the pinned host key are held in
            Snowflake and are not shown here — the app has no privilege to read them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null)
              setCreating((c) => !c)
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New endpoint
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {note && (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
          {note}
        </div>
      )}

      {/* ---- edit card, above the table ---- */}
      {editing && form && (
        <Card padding="dense">
          <div className="mb-4 flex items-center justify-between">
            <SectionHeading>Edit {editing.name}</SectionHeading>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(null); setForm(null) }}>
              <X className="mr-2 h-4 w-4" /> Cancel
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Label</label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Allowed root</label>
              <Input
                value={form.allowedRoot}
                onChange={(e) => setForm({ ...form, allowedRoot: e.target.value })}
                className="font-mono text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Must sit inside <span className="font-mono text-foreground">{editing.rootFloor}</span>.
                The procedure enforces that floor whatever is saved here.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max entries per listing</label>
              <Input
                type="number"
                value={form.maxEntries}
                onChange={(e) => setForm({ ...form, maxEntries: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max peek lines</label>
              <Input
                type="number"
                value={form.maxPeekLines}
                onChange={(e) => setForm({ ...form, maxPeekLines: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max peek bytes</label>
              <Input
                type="number"
                value={form.maxPeekBytes}
                onChange={(e) => setForm({ ...form, maxPeekBytes: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Notes</label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground">
            Host, port, SFTP user, host key and the root floor are set in Snowflake and are not
            editable here. That is deliberate: a row pairs a host with the key trusted for it, and
            the private key would be offered to whatever host the row names.
          </div>
          <div className="mt-4">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </div>
        </Card>
      )}

      {/* ---- new endpoint: form here, SQL to run there ---- */}
      {creating && (
        <Card padding="dense">
          <div className="mb-1 flex items-center justify-between">
            <SectionHeading>New endpoint</SectionHeading>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              <X className="mr-2 h-4 w-4" /> Close
            </Button>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            The app validates this but cannot write it. Adding an endpoint decides where the SFTP
            private key gets sent, so it stays a deliberate act by someone who already holds that
            key. Fill this in, then run the statement below in Snowflake.
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Name (identifier)</label>
              <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="SPOT2" className="font-mono text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Label</label>
              <Input value={draft.label} onChange={(e) => set("label", e.target.value)} placeholder="Spot secure transfer" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Host</label>
              <Input value={draft.host} onChange={(e) => set("host", e.target.value)} placeholder="securetransfer.example.com" className="font-mono text-sm" />
            </div>
            <div className="flex gap-3">
              <div className="w-24">
                <label className="mb-1 block text-xs text-muted-foreground">Port</label>
                <Input type="number" value={draft.port} onChange={(e) => set("port", Number(e.target.value))} />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">SFTP user</label>
                <Input value={draft.sftpUser} onChange={(e) => set("sftpUser", e.target.value)} className="font-mono text-sm" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Root floor (hard boundary)</label>
              <Input value={draft.rootFloor} onChange={(e) => set("rootFloor", e.target.value)} placeholder="/spot_money" className="font-mono text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Allowed root (browse start)</label>
              <Input value={draft.allowedRoot} onChange={(e) => set("allowedRoot", e.target.value)} placeholder="/spot_money" className="font-mono text-sm" />
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-[12rem_1fr]">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Host key type</label>
              <Select value={draft.hostKeyType} onValueChange={(v) => set("hostKeyType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {HOST_KEY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Server&apos;s PUBLIC host key
              </label>
              <Input
                value={draft.hostKeyB64}
                onChange={(e) => set("hostKeyB64", e.target.value)}
                placeholder="AAAAB3NzaC1yc2E..."
                className="font-mono text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The <strong>third field</strong> of{" "}
                <code className="text-foreground">ssh-keyscan -t {draft.hostKeyType.replace(/^ssh-/, "")} {draft.host || "<host>"}</code>.
                This is the server&apos;s public key, pinned so an impostor is detected — never
                your private key.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max entries</label>
              <Input type="number" value={draft.maxEntries} onChange={(e) => set("maxEntries", Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max peek lines</label>
              <Input type="number" value={draft.maxPeekLines} onChange={(e) => set("maxPeekLines", Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Max peek bytes</label>
              <Input type="number" value={draft.maxPeekBytes} onChange={(e) => set("maxPeekBytes", Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Notes</label>
              <Input value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </div>

          {draftErrors.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-2">
              {draftErrors.map((e, i) => (
                <li key={i} className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Run this in Snowflake
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(draftSql)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                {draftSql}
              </pre>
            </div>
          )}
        </Card>
      )}

      {/* ---- the list ---- */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Browse root</TableHead>
              <TableHead>Caps</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last change</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No endpoints registered. Use New endpoint to draft one.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((e) => (
                <TableRow key={e.name}>
                  <TableCell>
                    <p className="font-medium text-foreground">{e.name}</p>
                    <p className="text-xs text-muted-foreground">{e.label}</p>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.allowedRoot}
                    <p className="text-[10px]">floor {e.rootFloor}</p>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.maxEntries} entries · {e.maxPeekLines} lines ·{" "}
                    {Math.round(e.maxPeekBytes / 1024)} KB
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={e.enabled ? "text-emerald-300" : "text-rose-300"}>
                      {e.enabled ? "enabled" : "disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.updatedBy ?? "—"}
                    <p className="text-[10px]">{e.updatedAt ?? ""}</p>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(e)} aria-label="Edit" title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn("h-8 w-8", e.enabled ? "text-rose-400 hover:text-rose-300" : "text-emerald-400")}
                        onClick={() => setToggle(e)}
                        aria-label={e.enabled ? "Disable" : "Enable"}
                        title={e.enabled ? "Disable" : "Enable"}
                      >
                        <Power className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Removing an endpoint entirely is a Snowflake action, not an app one — the row holds the
        pinned host key and the record of what was configured. Disabling it here stops every
        browse, test and sync using it immediately, and is reversible.
      </p>

      <AlertDialog open={!!toggle} onOpenChange={(o) => !o && setToggle(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggle?.enabled ? `Disable ${toggle?.name}?` : `Enable ${toggle?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggle?.enabled
                ? "Every browse, test load and scheduled sync using this endpoint stops at once — including jobs running tonight. It is reversible: enable it again here."
                : "Browsing, test loads and scheduled syncs using this endpoint start working again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = toggle
                setToggle(null)
                if (t) void save({ ...(form ?? ({} as EditForm)), label: t.label, allowedRoot: t.allowedRoot, maxEntries: String(t.maxEntries), maxPeekLines: String(t.maxPeekLines), maxPeekBytes: String(t.maxPeekBytes), notes: t.notes, enabled: !t.enabled }, t)
              }}
              className={toggle?.enabled ? "bg-rose-600 text-white hover:bg-rose-700" : ""}
            >
              {toggle?.enabled ? "Disable" : "Enable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
