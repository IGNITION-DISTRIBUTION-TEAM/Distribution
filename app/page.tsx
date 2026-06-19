"use client"

import { useState } from "react"
import { AuthProvider, useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { DistributionDashboard } from "@/components/distribution-dashboard"
import { DiallerDashboard } from "@/components/dialler-dashboard"
import { SpotDashboard } from "@/components/spot-dashboard"
import { DepartmentPicker, type DepartmentId } from "@/components/department-picker"
import { AppSettings } from "@/components/app-settings"

type View = { kind: "picker" } | { kind: "dept"; id: DepartmentId } | { kind: "app-settings" }

function AppContent() {
  const { isAuthenticated } = useAuth()
  const [view, setView] = useState<View>({ kind: "picker" })

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  if (view.kind === "app-settings") {
    return <AppSettings onBack={() => setView({ kind: "picker" })} />
  }

  if (view.kind === "dept" && view.id === "distribution") {
    return <DistributionDashboard onBack={() => setView({ kind: "picker" })} />
  }

  if (view.kind === "dept" && view.id === "dialler") {
    return <DiallerDashboard onBack={() => setView({ kind: "picker" })} />
  }

  if (view.kind === "dept" && view.id === "spot") {
    return <SpotDashboard onBack={() => setView({ kind: "picker" })} />
  }

  return (
    <DepartmentPicker
      onSelect={(id) => setView({ kind: "dept", id })}
      onOpenSettings={() => setView({ kind: "app-settings" })}
    />
  )
}

export default function Page() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
