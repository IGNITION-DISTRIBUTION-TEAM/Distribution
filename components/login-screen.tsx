"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"

export function LoginScreen() {
  const { loginWithAzure } = useAuth()
  const [isAzureLoading, setIsAzureLoading] = useState(false)
  const [error, setError] = useState("")

  // Surface auth errors from the Azure callback (?auth_error=...&reason=...)
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const authError = params.get("auth_error")
    const reason = params.get("reason")
    if (!authError) return

    let msg = "Authentication failed. Please try again."
    if (authError === "access_denied") {
      switch (reason) {
        case "unmapped":
          msg = "Your account is not mapped to an employee. Contact administrator."
          break
        case "no_employee":
          msg = "No matching employee record was found. Contact administrator."
          break
        case "inactive":
          msg = "Your employee record is not active. Contact administrator."
          break
        case "role_not_allowed":
          msg = "Your role is not authorised to access this app. Contact administrator."
          break
        default:
          msg = "Access denied. Contact administrator."
      }
    } else if (authError === "token_exchange_failed") {
      msg = "Sign-in could not be completed. Please try again."
    } else if (authError === "missing_verifier" || authError === "missing_code") {
      msg = "Sign-in session expired. Please try again."
    }
    setError(msg)

    // Clean the URL so refresh doesn't keep re-showing the error.
    const url = new URL(window.location.href)
    url.searchParams.delete("auth_error")
    url.searchParams.delete("reason")
    window.history.replaceState({}, "", url.toString())
  }, [])

  const handleAzureLogin = async () => {
    setIsAzureLoading(true)
    setError("")
    try {
      await loginWithAzure()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(`Azure AD login failed: ${errorMessage}`)
      setIsAzureLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative z-10 mx-4 w-full max-w-md">
        <div className="mb-10 flex items-center justify-center">
          <img
            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-JkZOHyAcaHfqSTTXl0xEZGZ5cVrRp7.png"
            alt="Company Logo"
            className="h-12 w-auto"
          />
        </div>

        <div className="rounded-xl border border-border bg-card p-8 shadow-2xl shadow-black/20">
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-semibold text-foreground">Welcome back</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in with your Ignition Group account to continue.
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button
            type="button"
            onClick={handleAzureLogin}
            disabled={isAzureLoading}
            variant="outline"
            className="h-11 w-full border-border bg-secondary text-foreground hover:bg-secondary/80"
          >
            {isAzureLoading ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
                <span>Connecting...</span>
              </>
            ) : (
              <>
                <svg className="mr-2 h-5 w-5" viewBox="0 0 23 23" fill="none">
                  <path fill="#f3f3f3" d="M0 0h23v23H0z" />
                  <path fill="#f35325" d="M1 1h10v10H1z" />
                  <path fill="#81bc06" d="M12 1h10v10H12z" />
                  <path fill="#05a6f0" d="M1 12h10v10H1z" />
                  <path fill="#ffba08" d="M12 12h10v10H12z" />
                </svg>
                <span>Sign in with Azure AD</span>
              </>
            )}
          </Button>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Access is restricted to authorised Ignition Group employees.
          </p>
        </div>
      </div>
    </div>
  )
}
