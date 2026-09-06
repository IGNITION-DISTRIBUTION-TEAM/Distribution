"use client"

/**
 * Every email this department has attempted.
 *
 * Calendar mail is best effort and never throws — right for the user's action,
 * but it means a failure leaves no trace anywhere the user can see. Without
 * this screen, "email is switched off" and "email works" are indistinguishable
 * from inside the app, and the first symptom is somebody saying they never got
 * anything. So each attempt writes a row, including the two that send nothing:
 * mail not configured, and nobody on the list.
 */
import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Banner } from "@/components/kit/banner"
import { PageHeading } from "@/components/kit/heading"
import { SkeletonRows } from "@/components/kit/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { NotificationLogRow } from "@/components/calendar/types"

const KIND_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  reminder: "Reminder",
}

/** Snowflake hands back a TIMESTAMP_NTZ as a string; show it, do not reparse it. */
function when(value: string | null): string {
  if (!value) return "—"
  return value.replace("T", " ").slice(0, 16)
}

export function NotificationsSection() {
  const [rows, setRows] = useState<NotificationLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/calendar/notifications?limit=50", { cache: "no-store" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setRows(d.log ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const failures = rows.filter((r) => !r.ok).length

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        description="The last 50 attempts, newest first. This is the answer to “did my teammates actually get it?”"
        actions={
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        }
      >
        Notifications
      </PageHeading>

      {error && <Banner tone="error">{error}</Banner>}
      {!loading && rows.length > 0 && failures > 0 && (
        <Banner tone="warning">
          {failures} of the last {rows.length} attempts did not send. The reason is in the Result
          column — &ldquo;mail not configured&rdquo; means email has not been switched on for this
          portal yet.
        </Banner>
      )}

      <Card padding="dense">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <SkeletonRows cols={5} rows={5} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-muted-foreground">
                  No email has been attempted yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {when(row.sentAt)}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{row.title ?? `#${row.taskId ?? "?"}`}</div>
                    {row.forDate && (
                      <div className="text-xs text-muted-foreground">due {row.forDate}</div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {KIND_LABEL[row.kind] ?? row.kind}
                    <div>by {row.actor ?? "—"}</div>
                  </TableCell>
                  <TableCell className="max-w-[22rem]">
                    <div className="truncate text-xs text-muted-foreground" title={row.recipients}>
                      {row.recipients || "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{row.recipientCount} address(es)</div>
                  </TableCell>
                  <TableCell>
                    {row.ok ? (
                      <Badge variant="secondary">Sent</Badge>
                    ) : (
                      <div>
                        <Badge variant="destructive">Not sent</Badge>
                        {row.message && (
                          <div className="mt-1 max-w-[18rem] break-words text-xs text-muted-foreground">
                            {row.message}
                          </div>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
