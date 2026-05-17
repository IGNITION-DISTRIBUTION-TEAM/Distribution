import { NextRequest, NextResponse } from "next/server"

/**
 * GET /api/auth/session
 * Returns current user session from cookies
 */
export async function GET(request: NextRequest) {
  try {
    const sessionCookie = request.cookies.get("azure_session")
    console.log("[v0] Session check - Cookie exists:", !!sessionCookie)

    if (!sessionCookie) {
      console.log("[v0] No session cookie found")
      return NextResponse.json({ user: null })
    }

    const session = JSON.parse(sessionCookie.value)
    console.log("[v0] Session parsed:", session.email)

    // Check if session has expired
    if (session.expiresAt && session.expiresAt < Date.now()) {
      console.log("[v0] Session expired")
      return NextResponse.json({ user: null })
    }

    console.log("[v0] Returning user:", session.email)
    return NextResponse.json({
      user: {
        email: session.email,
        name: session.name,
        role: session.role ?? null,
        isSuperAdmin: !!session.isSuperAdmin,
      },
    })
  } catch (error) {
    console.error("[Session Error]", error)
    return NextResponse.json({ user: null })
  }
}
