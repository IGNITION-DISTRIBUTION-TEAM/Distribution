"use client"

import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { AppLoading } from "@/components/app-loading"
import { DepartmentPicker } from "@/components/department-picker"

export default function Page() {
  const { isAuthenticated, ready } = useAuth()
  const router = useRouter()

  if (!ready) return <AppLoading />
  if (!isAuthenticated) {
    return <LoginScreen />
  }

  return (
    <DepartmentPicker
      onSelect={(id) => router.push(`/departments/${id}`)}
      onOpenSettings={() => router.push("/settings")}
    />
  )
}
