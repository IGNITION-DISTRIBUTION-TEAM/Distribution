import { NextRequest, NextResponse } from "next/server"
import { exchangeCodeForToken, extractUserInfoFromToken } from "@/lib/azure-ad"
import { checkAccess } from "@/lib/auth-gate"

/**
 * Azure AD OAuth  handler
 * Exchanges authorization code for tokens and creates session
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get("code")
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

    // Exchange code for tokens — redirect_uri must match the one used at /authorize
    const redirectUri = `${request.nextUrl.origin}/api/auth/azure/callback`
    console.log("[v0] Exchanging code for tokens, redirectUri:", redirectUri)
    const tokens = await exchangeCodeForToken(code, codeVerifier, redirectUri)
    console.log("[v0] Tokens received")

    // Extract user info from ID token
    const userInfo = extractUserInfoFromToken(tokens.idToken)
    console.log("[v0] User info extracted:", userInfo.email)

    // Role/active gate — bounce to login if denied.
    const access = await checkAccess(userInfo.email)
    if (!access.allowed) {
      console.log("[v0] Access denied:", access.reason)
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?auth_error=access_denied&reason=${encodeURIComponent(access.reason)}`
      )
    }

    // Create redirect response
    const redirectResponse = NextResponse.redirect(`${request.nextUrl.origin}`)

    // Set secure session cookie with minimal user info.
    // Tokens are intentionally NOT stored — they push the cookie past the 4KB
    // browser limit and nothing in the app reads them back.
    console.log("[v0] Setting session cookie")
    redirectResponse.cookies.set("azure_session", JSON.stringify({
      email: userInfo.email,
      name: userInfo.name,
      role: access.role,
      isSuperAdmin: access.isSuperAdmin,
      employeeEmail: access.employeeEmail,
      expiresAt: Date.now() + 3600000, // 1 hour
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 3600, // 1 hour
      path: "/",
    })

    console.log("[v0] Redirecting to home")
    return redirectResponse
  } catch (error) {
    console.error("[Azure AD Error]", error)
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?auth_error=token_exchange_failed`
    )
  }
}
