"use client"

import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { ArrowLeft, LogOut, Target } from "lucide-react"

export function SpotDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
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
          <span className="text-sm font-medium text-muted-foreground">Spot Department</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs">
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

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <Target className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-xl font-semibold text-foreground">Spot department</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            This area is empty. Tell me which screens, tables, or actions you want in here and
            I&apos;ll build it out — same pattern as Distribution.
          </p>
        </div>
      </main>
    </div>
  )
}
