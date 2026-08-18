import { NextRequest, NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/admin-guard"
import {
  readGraphMailConfig,
  writeGraphMailConfig,
  hasGraphMailPrivateKey,
  thumbprintToX5t,
} from "@/lib/graph-mail"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  try {
    const config = await readGraphMailConfig()
    // The private key never leaves the server — report only whether it is set.
    return NextResponse.json({ config, privateKeyPresent: hasGraphMailPrivateKey() })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/admin/graph-mail] GET error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: {
    mailbox?: string
    tenantId?: string
    clientId?: string
    thumbprint?: string
    enabled?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const mailbox = (body.mailbox ?? "").trim()
  const tenantId = (body.tenantId ?? "").trim()
  const clientId = (body.clientId ?? "").trim()
  const thumbprint = (body.thumbprint ?? "").replace(/[\s:]/g, "").trim().toUpperCase()
  const enabled = !!body.enabled

  if (!EMAIL.test(mailbox)) {
    return NextResponse.json({ error: "Mailbox must be a valid email address" }, { status: 400 })
  }
  if (!GUID.test(tenantId)) {
    return NextResponse.json({ error: "Tenant ID must be a GUID" }, { status: 400 })
  }
  if (!GUID.test(clientId)) {
    return NextResponse.json({ error: "Application (client) ID must be a GUID" }, { status: 400 })
  }
  try {
    thumbprintToX5t(thumbprint)
  } catch {
    return NextResponse.json(
      { error: "Certificate thumbprint must be hex (e.g. 40 hex characters for SHA-1)" },
      { status: 400 }
    )
  }
  // Enabling without a key would fail at the first send — catch it here.
  if (enabled && !hasGraphMailPrivateKey()) {
    return NextResponse.json(
      { error: "Cannot enable sending: GRAPH_MAIL_PRIVATE_KEY is not set on the server." },
      { status: 400 }
    )
  }

  try {
    await writeGraphMailConfig({ mailbox, tenantId, clientId, thumbprint, enabled }, guard.email)
    const config = await readGraphMailConfig()
    return NextResponse.json({ ok: true, config, privateKeyPresent: hasGraphMailPrivateKey() })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/admin/graph-mail] PUT error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
