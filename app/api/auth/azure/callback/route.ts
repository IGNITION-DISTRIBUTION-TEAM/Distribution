import { NextRequest, NextResponse } from "next/server"
import { exchangeCodeForToken, extractUserInfoFromToken } from "@/lib/azure-ad"
import { checkAccess, getUserDepartments } from "@/lib/auth-gate"
import { DEPARTMENT_IDS } from "@/lib/departments"

/**
 * Azure AD OAuth  handler
 * Exchanges authorization code for tokens and creates session
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get("code")
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- read but never validated: the OAuth state round-trip is not checked here (flagged in the audit)
    const state = searchParams.get("state")
    const error = searchParams.get("error")
    const errorDescription = searchParams.get("error_description")

    console.log("[v0] Azure callback received")
    console.log("[v0] Code:", code ? "present" : "missing")

    // Handle auth errors
    if (error) {
      console.error("[Azure AD Error]", error, errorDescription)
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=${encodeURIComponent(error)}`
      )
    }

    if (!code) {
      console.log("[v0] No code in callback")
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=missing_code`
      )
    }

    // Get code verifier from cookie
    const codeVerifier = request.cookies.get("azure_code_verifier")?.value
    console.log("[v0] Code verifier in cookie:", !!codeVerifier)
    
    if (!codeVerifier) {
      console.error("[Azure AD] Code verifier not found in cookie")
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=missing_verifier`
      )
    }

    // Clear the code verifier cookie
    const response = new NextResponse()
    response.cookies.delete("azure_code_verifier")

    // Exchange code for tokens — redirect_uri must match the one used at /authorize.
    // Failures here are Azure-side (expired client secret, redirect URI mismatch)
    // — surface the detail so the login screen can say what actually broke.
    const redirectUri = `${request.nextUrl.origin}/api/auth/azure/callback`
    console.log("[v0] Exchanging code for tokens, redirectUri:", redirectUri)
    let tokens
    try {
      tokens = await exchangeCodeForToken(code, codeVerifier, redirectUri)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error("[Azure AD Error] token exchange:", detail)
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=token_exchange_failed&detail=${encodeURIComponent(detail.slice(0, 180))}`
      )
    }
    console.log("[v0] Tokens received")

    // Extract user info from ID token
    const userInfo = extractUserInfoFromToken(tokens.idToken)
    console.log("[v0] User info extracted:", userInfo.email)

    // Role/active gate — bounce to login if denied. A THROW here is not a
    // denial: the gate itself (Snowflake) was unreachable — say so explicitly
    // instead of blaming the token exchange.
    let access
    try {
      access = await checkAccess(userInfo.email)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error("[Azure AD Error] access gate check failed:", detail)
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=gate_unavailable&detail=${encodeURIComponent(detail.slice(0, 180))}`
      )
    }
    if (!access.allowed) {
      console.log("[v0] Access denied:", access.reason)
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=access_denied&reason=${encodeURIComponent(access.reason)}`
      )
    }

    // Departments this user may see. Super admins see all. For everyone else we
    // read explicit grants — but if the grants table is unavailable we fail open
    // (show all) rather than lock the user out before it's provisioned.
    let departments: string[]
    if (access.isSuperAdmin) {
      departments = [...DEPARTMENT_IDS]
    } else {
      try {
        departments = await getUserDepartments(userInfo.email)
      } catch (deptErr) {
        console.error("[v0] Department grant lookup failed, failing open:", deptErr)
        departments = [...DEPARTMENT_IDS]
      }
    }

    // Create redirect response. If a page stashed a return path before login
    // (e.g. a department ticket-capture link), go back there instead of the
    // picker. Same-origin relative paths only — never a full URL.
    let target = `${request.nextUrl.origin}`
    const returnPath = request.cookies.get("post_login_redirect")?.value
    if (returnPath) {
      try {
        const decoded = decodeURIComponent(returnPath)
        if (/^\/[a-zA-Z0-9\-_/]*$/.test(decoded)) target = `${request.nextUrl.origin}${decoded}`
      } catch {
        // Malformed cookie — fall back to the picker.
      }
    }
    const redirectResponse = NextResponse.redirect(target)
    redirectResponse.cookies.delete("post_login_redirect")

    // Set secure session cookie with minimal user info.
    // Tokens are intentionally NOT stored — they push the cookie past the 4KB
    // browser limit and nothing in the app reads them back.
    console.log("[v0] Setting session cookie")
    // 10 hours: long enough for a full workday so dashboards left open don't
    // start failing with "Not authenticated" mid-shift.
    const SESSION_SECONDS = 10 * 3600
    redirectResponse.cookies.set("azure_session", JSON.stringify({
      email: userInfo.email,
      name: userInfo.name,
      role: access.role,
      isSuperAdmin: access.isSuperAdmin,
      employeeEmail: access.employeeEmail,
      departments,
      expiresAt: Date.now() + SESSION_SECONDS * 1000,
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_SECONDS,
      path: "/",
    })

    console.log("[v0] Redirecting to home")
    return redirectResponse
  } catch (error) {
    console.error("[Azure AD Error]", error)
    const detail = error instanceof Error ? error.message : String(error)
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?auth_error=callback_failed&detail=${encodeURIComponent(detail.slice(0, 180))}`
    )
  }
}
