"use client"

import { use, useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { TicketForm } from "@/components/ticket-form"
import { Loader2 } from "lucide-react"
import type { TicketDepartment } from "@/lib/tickets-shared"

// Per-department ticket capture link: /tickets/log/<slug>. PUBLIC by design —
// the whole company uses these links without signing in. If the visitor does
// happen to have a session (e.g. the tickets team), their verified identity is
// used automatically; otherwise the form asks for name and email.
export default function TicketCapturePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params)
  const { user, isAuthenticated } = useAuth()
  const [department, setDepartment] = useState<TicketDepartment | null | undefined>(undefined)

  useEffect(() => {
    fetch("/api/tickets/departments")
      .then(async (res) => {
        const data = await res.json()
        const list: TicketDepartment[] = res.ok ? data.departments ?? [] : []
        setDepartment(list.find((d) => d.slug === slug) ?? null)
      })
      .catch(() => setDepartment(null))
  }, [slug])

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-3">
          <img
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-JkZOHyAcaHfqSTTXl0xEZGZ5cVrRp7.png"
            alt="Ignition Group"
            className="h-7 w-auto"
          />
          <span className="text-sm font-medium text-muted-foreground">Log a ticket</span>
        </div>
        {isAuthenticated && (
          <div className="text-right text-xs">
            <p className="font-medium text-foreground">{user?.name}</p>
            <p className="text-muted-foreground">{user?.email}</p>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        {department === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : department === null ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
            <h1 className="text-lg font-semibold text-foreground">
              This ticket link isn&apos;t active
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The department for this link doesn&apos;t exist or has been removed. Ask the
              tickets team for the correct link.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-foreground">{department.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Submit a request for the {department.name} department.
                {isAuthenticated
                  ? " Your name and email are attached automatically."
                  : " Fill in your name and email so the team can follow up."}
              </p>
            </div>
            <TicketForm lockedDepartment={department.name} collectIdentity={!isAuthenticated} />
          </>
        )}
      </main>
    </div>
  )
}
