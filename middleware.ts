import { NextRequest, NextResponse } from "next/server"

// Gate the static Spot Report site (served from public/spot-report/*) behind a
// valid login session. Files under public/ are otherwise world-readable by URL,
// and these reports contain internal financials. This is a lightweight cookie
// presence/expiry check — the same session cookie the app issues; department
// authorization is still enforced by the dashboard tile and (for any data
// APIs) the per-request guards.
export function middleware(request: NextRequest) {
  const cookie = request.cookies.get("azure_session")?.value
  let ok = false
  if (cookie) {
    try {
      const session = JSON.parse(cookie) as { email?: string; expiresAt?: number }
      ok = !!session.email && (!session.expiresAt || session.expiresAt > Date.now())
    } catch {
      ok = false
    }
  }
  if (ok) return NextResponse.next()

  // Not signed in — send them to the portal login, remembering where to return.
  const url = request.nextUrl.clone()
  url.pathname = "/"
  url.search = ""
  const res = NextResponse.redirect(url)
  res.cookies.set("post_login_redirect", request.nextUrl.pathname, {
    path: "/",
    maxAge: 600,
    sameSite: "lax",
  })
  return res
}

export const config = {
  matcher: ["/spot-report/:path*"],
}
