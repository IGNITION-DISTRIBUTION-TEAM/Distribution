"use client"

import { use } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { AppLoading } from "@/components/app-loading"
import { DistributionDashboard } from "@/components/distribution-dashboard"
import { DiallerDashboard } from "@/components/dialler-dashboard"
import { SpotDashboard } from "@/components/spot-dashboard"
import { TicketsDashboard } from "@/components/tickets-dashboard"
import { EngaigeDashboard } from "@/components/engaige-dashboard"
import { SpotReportDashboard } from "@/components/spot-report-dashboard"
import { ReportingDashboard } from "@/components/reporting-dashboard"
import { TaskAutomationDashboard } from "@/components/task-automation-dashboard"
import { Button } from "@/components/ui/button"
import { isDepartmentId } from "@/lib/departments"

// Every department gets its own URL: /departments/<id>. Access is still
// enforced server-side per API call; this page additionally hides dashboards
// the user has no grant for.
export default function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user, isAuthenticated, ready } = useAuth()
  const router = useRouter()

  // Session still being checked: neither the login card nor a Forbidden page
  // is the truth yet.
  if (!ready) return <AppLoading />
  if (!isAuthenticated) {
    return <LoginScreen />
  }

  const goBack = () => router.push("/")

  const allowed =
    user?.isSuperAdmin || (isDepartmentId(id) && (user?.departments ?? []).includes(id))

  if (!isDepartmentId(id) || !allowed) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <h1 className="text-xl font-semibold text-foreground">
          {isDepartmentId(id) ? "You don't have access to this department" : "Unknown department"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isDepartmentId(id)
            ? "Ask an administrator to grant you access."
            : `No department is registered at /departments/${id}.`}
        </p>
        <Button variant="outline" onClick={goBack}>
          Back to departments
        </Button>
      </div>
    )
  }

  switch (id) {
    case "distribution":
      return <DistributionDashboard onBack={goBack} />
    case "dialler":
      return <DiallerDashboard onBack={goBack} />
    case "spot":
      return <SpotDashboard onBack={goBack} />
    case "tickets":
      return <TicketsDashboard onBack={goBack} />
    case "engaige":
      return <EngaigeDashboard onBack={goBack} />
    case "spot-report":
      return <SpotReportDashboard onBack={goBack} />
    case "reporting":
      return <ReportingDashboard onBack={goBack} />
    case "task-automation":
      return <TaskAutomationDashboard onBack={goBack} />
    default:
      // Registered but has no dashboard yet (e.g. EDC "coming soon").
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
          <h1 className="text-xl font-semibold text-foreground">Coming soon</h1>
          <p className="text-sm text-muted-foreground">
            This department doesn&apos;t have a dashboard yet.
          </p>
          <Button variant="outline" onClick={goBack}>
            Back to departments
          </Button>
        </div>
      )
  }
}
