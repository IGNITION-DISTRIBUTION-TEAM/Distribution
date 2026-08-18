import { NextRequest, NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/admin-guard"
import { readGraphMailConfig, getGraphAppToken, sendGraphMailWith } from "@/lib/graph-mail"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Verify the certificate credentials, and optionally send a test message.
 *
 * mode "token" — only mint an app-only token (proves cert auth works without
 *                sending mail).
 * mode "send"  — mint a token and send a test message to `to`.
 *
 * Runs against the SAVED config but ignores the `enabled` flag, so the
 * integration can be verified before it is switched on.
 */
export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { mode?: string; to?: string; subject?: string; body?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const mode = body.mode === "send" ? "send" : "token"

  try {
    const config = await readGraphMailConfig()
    if (!config.tenantId || !config.clientId || !config.thumbprint || !config.mailbox) {
      return NextResponse.json(
        { error: "Save the mailbox, tenant ID, client ID and thumbprint first." },
        { status: 400 }
      )
    }

    // Force a fresh token so the test reflects the current cert/config rather
    // than a cached one from an earlier attempt.
    await getGraphAppToken(config, { force: true })

    if (mode === "token") {
      return NextResponse.json({
        ok: true,
        message: `Certificate authentication succeeded — app-only token acquired for ${config.mailbox}.`,
      })
    }

    const to = (body.to ?? "").trim()
    if (!EMAIL.test(to)) {
      return NextResponse.json({ error: "Enter a valid recipient email address" }, { status: 400 })
    }

    const subject = (body.subject ?? "").trim() || "Test message from Distribution portal"
    const text =
      (body.body ?? "").trim() ||
      `This is a test message sent via Microsoft Graph as ${config.mailbox}.\n\n` +
        `Triggered from App settings → Email by ${guard.email}.`

    await sendGraphMailWith(config, { to: [to], subject, body: text })

    return NextResponse.json({ ok: true, message: `Test message sent to ${to}.` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/admin/graph-mail/test] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
