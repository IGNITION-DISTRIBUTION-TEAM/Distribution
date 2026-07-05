"use client"

import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { AppSettings } from "@/components/app-settings"

export default function SettingsPage() {
  const { isAuthenticated } = useAuth()
  const router = useRouter()

  if (!isAuthenticated) {
    return <LoginScreen />
  }

  return <AppSettings onBack={() => router.push("/")} />
}
