"use client"

/**
 * Task Automation — the department shell.
 *
 * Same sidebar as Spot, Tickets and Engaige: the shadcn sidebar primitive, a
 * local `activeNav`, and a switch that picks the section. Each section lives in
 * its own file under components/task-automation/ rather than in this one, which
 * is how engaige-dashboard.tsx reached 2,800 lines.
 *
 * ONE DELIBERATE DIFFERENCE from those dashboards. They let a section unmount
 * when you navigate away, which is right for a list that should refetch. It is
 * wrong for a seven-step wizard: clicking "Current jobs" half-way through would
 * throw away the picked file, the column mapping and the test load. So Create
 * job stays mounted and is hidden with the `hidden` attribute; the three list
 * sections mount and unmount normally, and so refetch on each visit.
 */
import { useCallback, useRef, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ArrowLeft, CalendarClock, FilePlus, ListChecks, LogOut, Server, Workflow } from "lucide-react"
import { CreateJobSection } from "@/components/task-automation/create-job-section"
import { CurrentJobsSection } from "@/components/task-automation/current-jobs-section"
import { TasksSection } from "@/components/task-automation/tasks-section"
import { EndpointsSection } from "@/components/task-automation/endpoints-section"
import type { SyncConfig } from "@/lib/sftp-sync-codegen"

/**
 * The commit this bundle was built from. Inlined at build time by Next, so it
 * costs nothing at runtime and cannot drift from the JavaScript it is printed
 * beside. Deliberately not read through lib/snowflake.ts, which reads
 * process.env at call time and would drag JWT signing into the client bundle.
 */
const BUILD_SHA = (process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev").slice(0, 7)

type NavItem = { id: string; label: string; icon: React.ReactNode }

const navItems: NavItem[] = [
  { id: "create", label: "Create job", icon: <FilePlus className="h-4 w-4" /> },
  { id: "jobs", label: "Current jobs", icon: <ListChecks className="h-4 w-4" /> },
  { id: "tasks", label: "Tasks", icon: <CalendarClock className="h-4 w-4" /> },
  { id: "endpoints", label: "SFTP endpoints", icon: <Server className="h-4 w-4" /> },
]

export function TaskAutomationDashboard({ onBack }: { onBack?: () => void }) {
  const { user, logout } = useAuth()
  const [activeNav, setActiveNav] = useState("create")

  /**
   * A config handed over from Current jobs, for the wizard to load.
   *
   * A ref plus a counter rather than plain state: the wizard reads it once when
   * the counter changes, so re-rendering the shell for any other reason does
   * not re-apply a config over edits already made to it.
   */
  const pending = useRef<SyncConfig | null>(null)
  const [loadToken, setLoadToken] = useState(0)

  const openInWizard = useCallback((config: SyncConfig) => {
    pending.current = config
    setLoadToken((n) => n + 1)
    setActiveNav("create")
  }, [])

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <Workflow className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">Task Automation</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>SFTP to Snowflake</SidebarGroupLabel>
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
              {/* Which build is this? An open tab keeps its cached JavaScript
                  across a deploy while API routes update immediately, so the
                  page can show new data through old UI. This makes "am I
                  looking at the new code?" answerable at a glance. */}
              <p className="mt-1 font-mono text-[10px] text-muted-foreground" title="Deployed build">
                build {BUILD_SHA}
              </p>
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
            <span className="text-sm font-medium text-muted-foreground">Task Automation</span>
          </div>
        </header>

        <main className="flex-1 overflow-auto min-w-0">
          <div className="min-w-0 p-6">
            {/* Mounted always, hidden when another section is showing — see the
                note at the top of this file. */}
            <div hidden={activeNav !== "create"}>
              <CreateJobSection loadConfig={pending} loadToken={loadToken} />
            </div>
            {activeNav === "jobs" && <CurrentJobsSection onOpen={openInWizard} />}
            {activeNav === "tasks" && <TasksSection />}
            {activeNav === "endpoints" && <EndpointsSection />}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
