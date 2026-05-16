import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/auth/logout
 * Clears session cookies
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.json({
    success: true,
    message: "Logged out successfully",
  })

  // Clear session cookie
  response.cookies.set("azure_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
  })

  return response
}
