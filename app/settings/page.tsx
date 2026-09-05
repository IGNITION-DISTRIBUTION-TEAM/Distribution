"use client"

import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { LoginScreen } from "@/components/login-screen"
import { AppLoading } from "@/components/app-loading"
import { AppSettings } from "@/components/app-settings"

export default function SettingsPage() {
  const { isAuthenticated, ready } = useAuth()
  const router = useRouter()

  if (!ready) return <AppLoading />
  if (!isAuthenticated) {
    return <LoginScreen />
  }

  return <AppSettings onBack={() => router.push("/")} />
}
