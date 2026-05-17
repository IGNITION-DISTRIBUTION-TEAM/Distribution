"use client"

import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { LogOut, PhoneCall, Truck } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type DepartmentId = "distribution" | "dialler"

type Department = {
  id: DepartmentId
  label: string
  description: string
  icon: LucideIcon
  enabled: boolean
}

const DEPARTMENTS: Department[] = [
  {
    id: "distribution",
    label: "Distribution",
    description: "Leads, dialler views, daily files, and SS uploads.",
    icon: Truck,
    enabled: true,
  },
  {
    id: "dialler",
    label: "Dialler",
    description: "Dialler operations and reporting.",
    icon: PhoneCall,
    enabled: true,
  },
]

export function DepartmentPicker({ onSelect }: { onSelect: (id: DepartmentId) => void }) {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-3">
          <img
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-JkZOHyAcaHfqSTTXl0xEZGZ5cVrRp7.png"
            alt="Ignition Group"
            className="h-7 w-auto"
          />
          <span className="text-sm font-medium text-muted-foreground">Department portal</span>
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

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-semibold text-foreground">Choose a department</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick which area you want to work in. More departments will be added here.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DEPARTMENTS.map((dept) => {
            const Icon = dept.icon
            const interactive = dept.enabled
            return (
              <button
                key={dept.id}
                type="button"
                disabled={!interactive}
                onClick={interactive ? () => onSelect(dept.id) : undefined}
                className={[
                  "group relative flex flex-col items-start gap-3 rounded-xl border bg-card p-6 text-left transition",
                  interactive
                    ? "border-border hover:border-primary/60 hover:bg-card/80 cursor-pointer"
                    : "border-dashed border-border opacity-60 cursor-not-allowed",
                ].join(" ")}
              >
                <div
                  className={[
                    "rounded-lg p-2",
                    interactive
                      ? "bg-primary/10 text-primary group-hover:bg-primary/20"
                      : "bg-muted text-muted-foreground",
                  ].join(" ")}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">{dept.label}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{dept.description}</p>
                </div>
                {!interactive && (
                  <span className="absolute right-3 top-3 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Coming soon
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </main>
    </div>
  )
}
