/**
 * Microsoft Graph app-only mail sending (DWH_automation mailbox).
 *
 * Auth is the OAuth 2.0 client-credentials flow using **certificate**
 * authentication (not a client secret): we sign a short-lived JWT "client
 * assertion" with the certificate's private key, exchange it at Azure AD for
 * an app-only access token, then call
 *
 *   POST https://graph.microsoft.com/v1.0/users/{mailbox}/sendMail
 *
 * SECURITY — where the pieces live:
 *   - Non-secret identifiers (tenant id, client id, certificate thumbprint,
 *     mailbox) are stored in Snowflake and editable in App settings → Email.
 *   - The certificate PRIVATE KEY and its passphrase are read from environment
 *     variables ONLY. They are never stored in Snowflake, never returned by an
 *     API route, and never sent to the browser.
 *
 * Required environment variables:
 *   GRAPH_MAIL_PRIVATE_KEY      - RSA private key, PEM (raw, \n-escaped, or base64 of the PEM)
 *   GRAPH_MAIL_KEY_PASSPHRASE   - optional; only if the PEM is encrypted
 *
 * Azure hands out the certificate as a password-protected .pfx/.p12. Node
 * cannot read PKCS#12 directly, so convert it to a PEM private key once:
 *
 *   openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem
 *   # then use the contents of key.pem (no passphrase needed with -nodes)
 *
 * To keep the key encrypted at rest instead, drop -nodes and set
 * GRAPH_MAIL_KEY_PASSPHRASE to the PEM passphrase you choose.
 */

import { executeSnowflakeQuery } from "@/lib/snowflake"

const CONFIG_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_GRAPH_MAIL_CONFIG"

export type GraphMailConfig = {
  mailbox: string
  tenantId: string
  clientId: string
  thumbprint: string
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export const EMPTY_GRAPH_MAIL_CONFIG: GraphMailConfig = {
  mailbox: "",
  tenantId: "",
  clientId: "",
  thumbprint: "",
  enabled: false,
  updatedAt: null,
  updatedBy: null,
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Single-row config table. Created on demand so the feature works without a
 * manual DDL step; CREATE TABLE IF NOT EXISTS is idempotent.
 */
export async function ensureGraphMailTable(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
       ID NUMBER(1) NOT NULL,
       MAILBOX VARCHAR(320),
       TENANT_ID VARCHAR(64),
       CLIENT_ID VARCHAR(64),
       THUMBPRINT VARCHAR(128),
       ENABLED BOOLEAN,
       UPDATED_AT TIMESTAMP_NTZ,
       UPDATED_BY VARCHAR(320)
     )`
  )
}

export async function readGraphMailConfig(): Promise<GraphMailConfig> {
  await ensureGraphMailTable()
  const rows = await executeSnowflakeQuery<{
    MAILBOX: string | null
    TENANT_ID: string | null
    CLIENT_ID: string | null
    THUMBPRINT: string | null
    ENABLED: boolean | string | null
    UPDATED_AT: string | null
    UPDATED_BY: string | null
  }>(
    `SELECT MAILBOX, TENANT_ID, CLIENT_ID, THUMBPRINT, ENABLED, UPDATED_AT, UPDATED_BY
     FROM ${CONFIG_TABLE} WHERE ID = 1`
  )
  const row = rows[0]
  if (!row) return { ...EMPTY_GRAPH_MAIL_CONFIG }
  return {
    mailbox: (row.MAILBOX ?? "").trim(),
    tenantId: (row.TENANT_ID ?? "").trim(),
    clientId: (row.CLIENT_ID ?? "").trim(),
    thumbprint: (row.THUMBPRINT ?? "").trim(),
    enabled: row.ENABLED === true || String(row.ENABLED).toLowerCase() === "true",
    updatedAt: row.UPDATED_AT ? String(row.UPDATED_AT) : null,
    updatedBy: row.UPDATED_BY ? String(row.UPDATED_BY) : null,
  }
}

export async function writeGraphMailConfig(
  config: Omit<GraphMailConfig, "updatedAt" | "updatedBy">,
  updatedBy: string
): Promise<void> {
  await ensureGraphMailTable()
  await executeSnowflakeQuery(
    `MERGE INTO ${CONFIG_TABLE} t
     USING (SELECT 1 AS ID) s ON t.ID = s.ID
     WHEN MATCHED THEN UPDATE SET
       MAILBOX = ${sqlString(config.mailbox)},
       TENANT_ID = ${sqlString(config.tenantId)},
       CLIENT_ID = ${sqlString(config.clientId)},
       THUMBPRINT = ${sqlString(config.thumbprint)},
       ENABLED = ${config.enabled ? "TRUE" : "FALSE"},
       UPDATED_AT = CURRENT_TIMESTAMP(),
       UPDATED_BY = ${sqlString(updatedBy)}
     WHEN NOT MATCHED THEN INSERT
       (ID, MAILBOX, TENANT_ID, CLIENT_ID, THUMBPRINT, ENABLED, UPDATED_AT, UPDATED_BY)
       VALUES (1, ${sqlString(config.mailbox)}, ${sqlString(config.tenantId)},
               ${sqlString(config.clientId)}, ${sqlString(config.thumbprint)},
               ${config.enabled ? "TRUE" : "FALSE"}, CURRENT_TIMESTAMP(),
               ${sqlString(updatedBy)})`
  )
}

/** True when the certificate private key is present in the environment. */
export function hasGraphMailPrivateKey(): boolean {
  return !!(process.env.GRAPH_MAIL_PRIVATE_KEY ?? "").trim()
}

/**
 * Normalise the PEM private key from the environment. Accepts a raw PEM, a PEM
 * with escaped \n (common when pasting into a hosting provider's env UI), or
 * base64 of the PEM — mirroring how SNOWFLAKE_PRIVATE_KEY is handled.
 */
function readPrivateKeyPem(): string {
  const raw = (process.env.GRAPH_MAIL_PRIVATE_KEY ?? "").trim()
  if (!raw) {
    throw new Error(
      "Missing GRAPH_MAIL_PRIVATE_KEY. Convert the .pfx to a PEM private key and set it as an environment variable."
    )
  }
  let pem = raw.replace(/\\n/g, "\n")
  if (!pem.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(pem, "base64").toString("utf-8")
      if (decoded.includes("-----BEGIN")) pem = decoded
    } catch {
      // fall through — the error below is clearer than a base64 failure
    }
  }
  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      "GRAPH_MAIL_PRIVATE_KEY is not a PEM private key (no -----BEGIN marker found)."
    )
  }
  return pem
}

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

/**
 * Azure AD identifies the signing certificate via the `x5t` JWT header, which
 * is the base64url of the certificate's SHA-1 hash BYTES. Portal/admins supply
 * the thumbprint as a hex string (sometimes with spaces or colons), so convert
 * hex -> bytes -> base64url.
 */
export function thumbprintToX5t(thumbprint: string): string {
  const hex = thumbprint.replace(/[\s:]/g, "").toUpperCase()
  if (!/^[0-9A-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`Invalid certificate thumbprint: "${thumbprint}" (expected hex)`)
  }
  return base64url(Buffer.from(hex, "hex"))
}

/**
 * Build and sign the client assertion JWT proving possession of the
 * certificate's private key (RFC 7523 / Azure AD certificate credentials).
 */
function buildClientAssertion(config: {
  tenantId: string
  clientId: string
  thumbprint: string
}): string {
  const crypto = require("crypto") as typeof import("crypto")
  const pem = readPrivateKeyPem()
  const passphrase = (process.env.GRAPH_MAIL_KEY_PASSPHRASE ?? "").trim()

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT", x5t: thumbprintToX5t(config.thumbprint) }
  const payload = {
    aud: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    iss: config.clientId,
    sub: config.clientId,
    jti: crypto.randomUUID(),
    nbf: now - 60,
    iat: now,
    exp: now + 9 * 60, // Azure AD rejects assertions with a long lifetime
  }

  const message = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload))
  )}`

  const key = passphrase ? { key: pem, passphrase } : pem
  const signature = crypto.sign("sha256", Buffer.from(message), key)
  return `${message}.${base64url(signature)}`
}

// App-only tokens last ~1h. Cache in module scope and refresh a minute early,
// so a burst of sends does not hammer Azure AD.
let tokenCache: { token: string; expiresAt: number } | null = null

export async function getGraphAppToken(
  config: Pick<GraphMailConfig, "tenantId" | "clientId" | "thumbprint">,
  opts: { force?: boolean } = {}
): Promise<string> {
  if (!opts.force && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token
  }
  if (!config.tenantId || !config.clientId || !config.thumbprint) {
    throw new Error("Graph mail is not configured (tenant id, client id and thumbprint are required).")
  }

  const assertion = buildClientAssertion(config)
  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString(),
    }
  )

  const text = await res.text()
  let data: { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Azure AD returned a non-JSON response (${res.status}): ${text.slice(0, 300)}`)
  }
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || text.slice(0, 300)
    throw new Error(`Azure AD token request failed (${res.status}): ${detail}`)
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
  return tokenCache.token
}

export type SendMailInput = {
  to: string[]
  subject: string
  body: string
  /** "Text" (default) or "HTML" */
  contentType?: "Text" | "HTML"
  cc?: string[]
  bcc?: string[]
  replyTo?: string[]
  /** Keep a copy in the mailbox's Sent Items (Graph default is true). */
  saveToSentItems?: boolean
  attachments?: { name: string; contentBytes: string; contentType?: string }[]
}

const recipients = (list: string[] | undefined) =>
  (list ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }))

/**
 * Send mail as the configured mailbox. Graph returns 202 Accepted with an
 * empty body on success.
 */
export async function sendGraphMail(input: SendMailInput): Promise<void> {
  const config = await readGraphMailConfig()
  if (!config.enabled) {
    throw new Error("Graph mail is disabled in App settings → Email.")
  }
  if (!config.mailbox) {
    throw new Error("Graph mail has no sending mailbox configured.")
  }
  await sendGraphMailWith(config, input)
}

/**
 * Send using an explicit config — used by the settings "send test" action so a
 * test can run against unsaved/disabled config without flipping the toggle.
 */
export async function sendGraphMailWith(
  config: Pick<GraphMailConfig, "mailbox" | "tenantId" | "clientId" | "thumbprint">,
  input: SendMailInput
): Promise<void> {
  const to = recipients(input.to)
  if (to.length === 0) throw new Error("At least one recipient is required.")
  if (!input.subject.trim()) throw new Error("Subject is required.")

  const message: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: input.contentType ?? "Text", content: input.body },
    toRecipients: to,
  }
  const cc = recipients(input.cc)
  const bcc = recipients(input.bcc)
  const replyTo = recipients(input.replyTo)
  if (cc.length) message.ccRecipients = cc
  if (bcc.length) message.bccRecipients = bcc
  if (replyTo.length) message.replyTo = replyTo
  if (input.attachments?.length) {
    message.attachments = input.attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType ?? "application/octet-stream",
      contentBytes: a.contentBytes,
    }))
  }

  const send = async (token: string) =>
    fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mailbox)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, saveToSentItems: input.saveToSentItems ?? true }),
      }
    )

  let res = await send(await getGraphAppToken(config))
  // A cached token can be revoked server-side before it expires; retry once
  // with a freshly minted one before surfacing an auth failure.
  if (res.status === 401) {
    res = await send(await getGraphAppToken(config, { force: true }))
  }

  if (!res.ok) {
    const text = await res.text()
    let detail = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } }
      detail = parsed.error?.message || parsed.error?.code || detail
    } catch {
      // keep the raw snippet
    }
    throw new Error(`Graph sendMail failed (${res.status}): ${detail}`)
  }
}
