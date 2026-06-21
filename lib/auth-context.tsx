"use client"

import React, { createContext, useContext, useState, useCallback, useEffect } from "react"

type User = {
  email: string
  name: string
  role: string
  isSuperAdmin: boolean
  departments: string[]
}

type AuthContextType = {
  user: User | null
  isAuthenticated: boolean
  loginWithAzure: () => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  // Initialize auth state from cookie on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch("/api/auth/session")
        if (response.ok) {
          const data = await response.json()
          if (data.user) {
            console.log("[v0] Session found, setting user:", data.user.email)
            setUser({
              email: data.user.email,
              name: data.user.name,
              role: data.user.role ?? "",
              isSuperAdmin: !!data.user.isSuperAdmin,
              departments: Array.isArray(data.user.departments) ? data.user.departments : [],
            })
          }
        }
      } catch (error) {
        console.error("Failed to check session:", error)
      } finally {
        setIsInitialized(true)
      }
    }

    checkSession()
  }, [])

  const loginWithAzure = useCallback(async () => {
    try {
      console.log("[v0] loginWithAzure called")
      const { getAzureAuthUrl } = await import("@/lib/azure-ad")
      console.log("[v0] Azure AD module imported")
      const authUrl = await getAzureAuthUrl()
      console.log("[v0] Auth URL generated:", authUrl)
      window.location.href = authUrl
    } catch (error) {
      console.log("[v0] loginWithAzure error:", error)
      throw error
    }
  }, [])

  const logout = useCallback(async () => {
    setUser(null)
    // Clear our local session cookie first, then redirect to Azure AD's
    // single sign-out so the Microsoft session is ended too (otherwise the
    // next login silently re-authenticates via SSO).
    try {
      await fetch("/api/auth/logout", { method: "POST" })
    } catch (error) {
      console.error("Failed to clear session:", error)
    }
    try {
      const { getAzureLogoutUrl } = await import("@/lib/azure-ad")
      window.location.href = getAzureLogoutUrl()
    } catch (error) {
      console.error("Failed to build Azure logout URL:", error)
      // Fall back to a local redirect so the user still leaves the app.
      window.location.href = "/"
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        loginWithAzure,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
