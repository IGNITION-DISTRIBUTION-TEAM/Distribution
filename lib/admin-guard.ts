import { NextRequest, NextResponse } from "next/server"
import { isSuperAdmin } from "@/lib/auth-gate"

// Read the session cookie and confirm the caller is a super admin. Returns
// the caller's AD email on success, or a NextResponse to short-circuit the
// request handler.
export async function requireSuperAdmin(
  request: NextRequest
): Promise<{ email: string } | NextResponse> {
  const cookie = request.cookies.get("azure_session")?.value
  if (!cookie) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  let session: { email?: string; isSuperAdmin?: boolean; expiresAt?: number }
  try {
    session = JSON.parse(cookie)
  } catch {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 })
  }

  if (session.expiresAt && session.expiresAt < Date.now()) {
    return NextResponse.json({ error: "Session expired" }, { status: 401 })
  }

  const email = (session.email ?? "").trim().toLowerCase()
  if (!email) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  // Cookie flag is convenient but spoofable in theory — re-verify against DB.
  const ok = await isSuperAdmin(email)
  if (!ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  return { email }
}
