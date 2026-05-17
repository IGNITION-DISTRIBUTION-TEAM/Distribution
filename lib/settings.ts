"use client"

// Client-only, browser-local UI settings. localStorage is per-browser, so
// these are user preferences — not org-wide policy.

const PASSWORD_SIGN_IN_KEY = "dist.passwordSignInEnabled"

export function isPasswordSignInEnabled(): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(PASSWORD_SIGN_IN_KEY) === "true"
}

export function setPasswordSignInEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(PASSWORD_SIGN_IN_KEY, enabled ? "true" : "false")
}
