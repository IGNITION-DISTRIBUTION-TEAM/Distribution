import { NextRequest, NextResponse } from "next/server"
import { isSuperAdmin, getUserDepartments, checkAccess } from "@/lib/auth-gate"

// Confirm the caller has a valid session and passes the role/active gate, with
// no department requirement. Used for org-wide endpoints (e.g. logging a
// ticket). Returns the caller's AD email or a NextResponse.
export async function requireAuthenticated(
  request: NextRequest
): Promise<{ email: string } | NextResponse> {
  const cookie = request.cookies.get("azure_session")?.value
  if (!cookie) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  let session: { email?: string; expiresAt?: number }
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

  // Re-verify against the DB gate rather than trusting the cookie alone.
  const access = await checkAccess(email)
  if (!access.allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  return { email }
}

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

// Confirm the caller is authenticated and has access to a given department
// (super admins always pass). Re-verifies grants against the DB rather than
// trusting the session cookie. Returns the caller's AD email or a NextResponse.
export async function requireDepartmentAccess(
  request: NextRequest,
  department: string
): Promise<{ email: string } | NextResponse> {
  const cookie = request.cookies.get("azure_session")?.value
  if (!cookie) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  let session: { email?: string; expiresAt?: number }
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

  if (await isSuperAdmin(email)) return { email }

  const departments = await getUserDepartments(email)
  if (!departments.includes(department.toLowerCase())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  return { email }
}
