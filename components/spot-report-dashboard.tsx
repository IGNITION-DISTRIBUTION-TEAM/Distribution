"use client"

import { useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { ArrowLeft, ExternalLink, LogOut, RefreshCw } from "lucide-react"

// The Spot Report is the static Telco Retail dashboard rebuild, served from
// public/spot-report/ and embedded here in an iframe so all its pages, charts,
// and navigation work exactly as built. Access to the static files is gated by
// middleware; this department tile is gated by the "spot-report" grant.
const SITE = "/spot-report/index.html"

export function SpotReportDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-3">
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
          <span className="text-sm font-medium text-muted-foreground">Spot Report · Telco Retail</span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
            aria-label="Reload report"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reload
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.open(SITE, "_blank")}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open in new tab
          </Button>
          <div className="hidden text-right text-xs sm:block">
            <p className="font-medium text-foreground">{user?.name}</p>
            <p className="text-muted-foreground">{user?.email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </header>

      <iframe
        key={reloadKey}
        src={SITE}
        title="Spot Report — Telco Retail"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  )
}
