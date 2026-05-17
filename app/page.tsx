"use client"

import { useState } from "react"
import { AuthProvider, useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { DistributionDashboard } from "@/components/distribution-dashboard"
import { DiallerDashboard } from "@/components/dialler-dashboard"
import { DepartmentPicker, type DepartmentId } from "@/components/department-picker"

function AppContent() {
  const { isAuthenticated } = useAuth()
  const [activeDept, setActiveDept] = useState<DepartmentId | null>(null)

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  if (!activeDept) {
    return <DepartmentPicker onSelect={setActiveDept} />
  }

  if (activeDept === "distribution") {
    return <DistributionDashboard onBack={() => setActiveDept(null)} />
  }

  if (activeDept === "dialler") {
    return <DiallerDashboard onBack={() => setActiveDept(null)} />
  }

  return <DepartmentPicker onSelect={setActiveDept} />
}

export default function Page() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
