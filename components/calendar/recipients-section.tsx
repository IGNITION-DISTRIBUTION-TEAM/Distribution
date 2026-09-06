"use client"

/**
 * The standing team mailing list.
 *
 * DELIBERATE DEPARTURE, repeated here so it is visible from the UI side too:
 * every other email list in this portal is super-admin-only. This one is
 * editable by anyone with Calendar access, because it is content rather than
 * authorization — it sits on the same footing as the task rows everyone here
 * can already delete. The consequence is real: anyone in this department can
 * make the app send mail to any address they type. The department grant is the
 * access control, and every send is recorded under Notifications.
 */
import { useCallback, useEffect, useState } from "react"
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Card } from "@/components/ui/card"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { SkeletonRows } from "@/components/kit/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
import type { TeamRecipient } from "@/components/calendar/types"

const HOUSE_DOMAIN = "@ignitiongroup.co.za"

export function RecipientsSection() {
  const [rows, setRows] = useState<TeamRecipient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [removing, setRemoving] = useState<TeamRecipient | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/calendar/recipients", { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setRows(d.recipients ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    setAdding(true)
    setError(null)
    try {
      const res = await fetch("/api/calendar/recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, displayName }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setEmail("")
      setDisplayName("")
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  const toggle = async (row: TeamRecipient, active: boolean) => {
    setBusyId(row.id)
    setError(null)
    try {
      const res = await fetch("/api/calendar/recipients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, active }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async () => {
    if (!removing) return
    const row = removing
    setRemoving(null)
    setBusyId(row.id)
    setError(null)
    try {
      const res = await fetch(`/api/calendar/recipients?id=${row.id}`, { method: "DELETE" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const activeCount = rows.filter((r) => r.active).length
  const outsider = email.trim() !== "" && !email.trim().toLowerCase().endsWith(HOUSE_DOMAIN)

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        description="Who gets emailed when a task is created, changed, deleted, or falls due. A task can add extra addresses of its own, or replace this list entirely."
        actions={
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        }
      >
        Recipients
      </PageHeading>

      {error && <Banner tone="error">{error}</Banner>}

      <Card padding="dense">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Email address</label>
            <Input
              value={email}
              placeholder="name@ignitiongroup.co.za"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && email.trim()) {
                  e.preventDefault()
                  void add()
                }
              }}
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Name (optional)</label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <Button onClick={() => void add()} disabled={adding || !email.trim()}>
            {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Add
          </Button>
        </div>
        {/* A warning, never a block — nothing in this app keeps a domain
            allowlist, and an outside collaborator can be a real teammate. */}
        {outsider && (
          <Banner tone="warning" className="mt-3">
            That address is outside {HOUSE_DOMAIN}. It will be added, but mail to outside
            addresses can be blocked by the mail server before it arrives.
          </Banner>
        )}
      </Card>

      <Card padding="dense">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead>Notified</TableHead>
              <TableHead className="text-right">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <SkeletonRows cols={5} rows={3} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-muted-foreground">
                  Nobody is on the list, so tasks will save without emailing anyone.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.email}</TableCell>
                  <TableCell className="text-muted-foreground">{row.displayName ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.createdBy ?? "—"}</TableCell>
                  <TableCell>
                    <Switch
                      checked={row.active}
                      disabled={busyId === row.id}
                      aria-label={`Notify ${row.email}`}
                      onCheckedChange={(v) => void toggle(row, v)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${row.email}`}
                      disabled={busyId === row.id}
                      onClick={() => setRemoving(row)}
                    >
                      {busyId === row.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {rows.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {activeCount} of {rows.length} will be emailed. Switching someone off keeps the row —
            and who added it — without sending to them.
          </p>
        )}
      </Card>

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will stop receiving calendar mail. To stop mail without losing the record of who
              added them, switch Notified off instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
