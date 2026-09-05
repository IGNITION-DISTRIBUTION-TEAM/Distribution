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

export type PrivateKeyStatus = {
  /** The env var is set to a non-empty value. */
  present: boolean
  /** The value loads as a usable private key (decrypting it if needed). */
  usable: boolean
  /** Human-readable diagnosis, safe to show in the UI. */
  detail: string
  keyType?: string
  bits?: number
  /** The value is an encrypted PEM. */
  encrypted?: boolean
  /** GRAPH_MAIL_KEY_PASSPHRASE is set. */
  passphraseSet?: boolean
}

/**
 * Diagnose the configured private key WITHOUT revealing it. Returns why the key
 * is unusable (missing / not a PEM / encrypted without a passphrase / wrong
 * passphrase) so the settings UI can say something actionable instead of just
 * "not found".
 */
export function inspectGraphMailPrivateKey(): PrivateKeyStatus {
  const raw = (process.env.GRAPH_MAIL_PRIVATE_KEY ?? "").trim()
  const passphrase = (process.env.GRAPH_MAIL_KEY_PASSPHRASE ?? "").trim()
  const passphraseSet = !!passphrase

  if (!raw) {
    return {
      present: false,
      usable: false,
      passphraseSet,
      detail:
        "GRAPH_MAIL_PRIVATE_KEY is not set on this server. Add it to the environment (on Vercel: Project → Settings → Environment Variables, for the environment this deployment runs in) and redeploy — env var changes only apply to new deployments.",
    }
  }

  let pem: string
  try {
    pem = readPrivateKeyPem()
  } catch (error) {
    // Set, but not recognisable as a PEM. Most often the whole
    // `NAME="value"` line was pasted into the value box instead of just the key.
    return {
      present: true,
      usable: false,
      passphraseSet,
      detail:
        `GRAPH_MAIL_PRIVATE_KEY is set (${raw.length} characters) but is not a PEM private key. ` +
        "Paste only the key itself — from -----BEGIN to -----END — with no variable name and no surrounding quotes. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    }
  }

  const encrypted = /BEGIN ENCRYPTED PRIVATE KEY/.test(pem) || /DEK-Info:/.test(pem)
  if (encrypted && !passphraseSet) {
    return {
      present: true,
      usable: false,
      encrypted: true,
      passphraseSet,
      detail:
        "The key is an encrypted PEM but GRAPH_MAIL_KEY_PASSPHRASE is not set. Set the passphrase too, or re-export the key unencrypted (openssl ... -nodes).",
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: node:crypto must not be bundled for any importer that only wants this module's types or constants
    const crypto = require("crypto") as typeof import("crypto")
    const key = crypto.createPrivateKey(
      passphraseSet ? { key: pem, passphrase } : pem
    )
    return {
      present: true,
      usable: true,
      encrypted,
      passphraseSet,
      keyType: key.asymmetricKeyType,
      bits: key.asymmetricKeyDetails?.modulusLength,
      detail: `Private key loaded (${key.asymmetricKeyType?.toUpperCase() ?? "unknown"}${
        key.asymmetricKeyDetails?.modulusLength
          ? `, ${key.asymmetricKeyDetails.modulusLength} bits`
          : ""
      }${encrypted ? ", decrypted with the configured passphrase" : ""}).`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const wrongPassphrase = /bad decrypt|wrong final block|DECRYPT/i.test(message)
    return {
      present: true,
      usable: false,
      encrypted,
      passphraseSet,
      detail: wrongPassphrase
        ? "The key is encrypted and GRAPH_MAIL_KEY_PASSPHRASE does not decrypt it — check the passphrase."
        : `The key is set but could not be loaded: ${message}`,
    }
  }
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

  // Be tolerant of how the value was pasted: openssl's -nocerts output carries a
  // "Bag Attributes" preamble, and it is easy to paste the whole
  // GRAPH_MAIL_PRIVATE_KEY="..." line (or a quoted value) from a .env snippet.
  // Extracting just the PEM block handles all of those. Any DEK-Info headers of
  // a legacy encrypted key live inside the block, so they are preserved.
  const block = pem.match(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/
  )
  if (!block) {
    throw new Error(
      "GRAPH_MAIL_PRIVATE_KEY has a -----BEGIN marker but no complete PRIVATE KEY block — the value looks truncated."
    )
  }
  return block[0] + "\n"
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: node:crypto must not be bundled for any importer that only wants this module's types or constants
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

// ---------------------------------------------------------------------------
// Large attachments
// ---------------------------------------------------------------------------

/**
 * Thrown when a payload will not fit a single sendMail request and the caller has
 * ruled out the draft + upload-session path (which needs Mail.ReadWrite). Carries
 * the sizes so the caller can explain the decision rather than guess at it.
 */
export class TooLargeForInline extends Error {
  constructor(
    readonly rawBytes: number,
    readonly zippedBytes: number | null,
    readonly zipError: string | null
  ) {
    const zipNote =
      zippedBytes !== null
        ? `${(zippedBytes / 1024 / 1024).toFixed(2)}MB zipped`
        : `could not be zipped${zipError ? ` (${zipError})` : ""}`
    super(
      `Payload is ${(rawBytes / 1024 / 1024).toFixed(2)}MB raw, ${zipNote}, over the ` +
        `${(INLINE_ATTACHMENT_LIMIT / 1024 / 1024).toFixed(0)}MB a single Graph message allows.`
    )
    this.name = "TooLargeForInline"
  }
}

/**
 * Attachment carried as raw bytes. Kept as a Buffer rather than base64 so the
 * upload-session path can PUT it directly without a pointless re-encode.
 */
export type MailFile = { name: string; content: Buffer; contentType?: string }

/**
 * sendMail carries attachments inside the request body, which Graph caps at 4MB.
 * Base64 inflates by 4/3, so the inline path is only safe for roughly 3MB of raw
 * bytes. Anything larger goes through a draft message and an upload session,
 * which has no practical size limit.
 */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024

/** What one sendMail request can carry, so callers can plan a split. */
export const INLINE_LIMIT_BYTES = INLINE_ATTACHMENT_LIMIT

/**
 * Compressed size of a set of files, for planning a split without sending
 * anything. Returns null if compression fails, so the caller falls back to raw
 * sizes rather than treating a zip failure as "it fits".
 */
export async function zippedBytesFor(files: MailFile[]): Promise<number | null> {
  try {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const f of files) zip.file(f.name, f.content)
    const buf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    })
    return buf.length
  } catch {
    return null
  }
}

/**
 * Upload chunks must be a multiple of 320 KiB, and Graph rejects requests over
 * 4MB, so 12 x 320 KiB (3.75MB) is the largest legal chunk.
 */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 12

const graphHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
})

async function graphJson(
  res: Response,
  what: string
): Promise<Record<string, unknown>> {
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 300)}`)
    return {}
  }
  if (!res.ok) {
    const err = parsed.error as { message?: string; code?: string } | undefined
    const detail = err?.message || err?.code || text.slice(0, 300)
    // A 403 here is almost always a missing application permission rather than a
    // bad credential: sending needs Mail.Send, but creating a draft and running
    // an upload session need Mail.ReadWrite. Say so, because "Access is denied.
    // Check credentials" sends people to check the certificate, which is fine.
    if (res.status === 403) {
      throw new Error(
        `${what} failed (403): ${detail} — this step needs the Mail.ReadWrite ` +
          "application permission on the mailbox; Mail.Send alone only covers the " +
          "single-request send path."
      )
    }
    throw new Error(`${what} failed (${res.status}): ${detail}`)
  }
  return parsed
}

/**
 * Attach one file to a draft by upload session, in chunks.
 *
 * The upload URL is pre-authorised, so the chunk PUTs deliberately carry no
 * Authorization header — Graph rejects some requests that include one.
 */
async function uploadAttachment(
  mailbox: string,
  messageId: string,
  file: MailFile,
  token: string
): Promise<void> {
  const size = file.content.length
  const sessionRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments/createUploadSession`,
    {
      method: "POST",
      headers: graphHeaders(token),
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: "file",
          name: file.name,
          size,
          contentType: file.contentType ?? "application/octet-stream",
        },
      }),
    }
  )
  const session = await graphJson(sessionRes, `Create upload session for ${file.name}`)
  const uploadUrl = String(session.uploadUrl ?? "")
  if (!uploadUrl) throw new Error(`Graph returned no uploadUrl for ${file.name}`)

  for (let start = 0; start < size; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, size) - 1
    const chunk = file.content.subarray(start, end + 1)
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
      body: new Uint8Array(chunk),
    })
    // 200/201 close the session on the final chunk; 202 accepts an interim one.
    if (![200, 201, 202].includes(res.status)) {
      const text = await res.text()
      throw new Error(
        `Uploading ${file.name} failed at bytes ${start}-${end} (${res.status}): ${text.slice(0, 300)}`
      )
    }
  }
}

/**
 * Send mail with attachments of any size.
 *
 * Small payloads take the single-request sendMail path. Larger ones create a
 * draft, stream each attachment into it via an upload session, then send the
 * draft — which is how Graph supports large files, and removes any size ceiling
 * from the caller's point of view.
 */
export async function sendGraphMailFiles(input: {
  to: string[]
  subject: string
  body: string
  files: MailFile[]
  contentType?: "Text" | "HTML"
  cc?: string[]
  bcc?: string[]
  /** Name for the archive if the files have to be zipped to fit. */
  archiveName?: string
  /**
   * Allow the draft + upload-session path, which needs Mail.ReadWrite. Set false
   * to keep strictly within Mail.Send: the call then throws TooLargeForInline
   * instead, and the caller can split the payload and send several messages.
   */
  allowUpload?: boolean
}): Promise<{ path: "inline" | "zipped" | "upload"; bytes: number; sentBytes: number }> {
  const config = await readGraphMailConfig()
  if (!config.enabled) throw new Error("Graph mail is disabled in App settings → Email.")
  if (!config.mailbox) throw new Error("Graph mail has no sending mailbox configured.")

  const bytes = input.files.reduce((a, f) => a + f.content.length, 0)

  const sendInline = async (files: MailFile[]) =>
    sendGraphMailWith(config, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body: input.body,
      contentType: input.contentType,
      attachments: files.map((f) => ({
        name: f.name,
        contentBytes: f.content.toString("base64"),
        contentType: f.contentType,
      })),
    })

  // Small enough to ride along in the send request.
  if (bytes <= INLINE_ATTACHMENT_LIMIT) {
    await sendInline(input.files)
    return { path: "inline", bytes, sentBytes: bytes }
  }

  let zippedBytes: number | null = null
  let zipError: string | null = null

  // Too big to send as-is. Try compressing before reaching for the draft path:
  // CSV deflates to roughly a tenth of its size, so a 25MB export still fits in
  // a single request — and that path needs only Mail.Send, where the draft plus
  // upload-session path additionally needs Mail.ReadWrite.
  try {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const f of input.files) zip.file(f.name, f.content)
    const zipped = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    })
    if (zipped.length <= INLINE_ATTACHMENT_LIMIT) {
      const name = `${(input.archiveName || "attachments").replace(/\.zip$/i, "")}.zip`
      await sendInline([
        { name, content: Buffer.from(zipped), contentType: "application/zip" },
      ])
      return { path: "zipped", bytes, sentBytes: zipped.length }
    }
    zippedBytes = zipped.length
  } catch (error) {
    // Compression is an optimisation, not a requirement — fall through rather
    // than failing the send because zipping went wrong.
    console.warn("[graph-mail] zip fallback failed:", error)
    zipError = error instanceof Error ? error.message : String(error)
  }

  // Caller wants to stay inside Mail.Send: report the sizes so the decision to
  // split is made on facts rather than a guess about compression.
  if (input.allowUpload === false) {
    throw new TooLargeForInline(bytes, zippedBytes, zipError)
  }

  const token = await getGraphAppToken(config)
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mailbox)}`

  // 1. draft
  const draftRes = await fetch(`${base}/messages`, {
    method: "POST",
    headers: graphHeaders(token),
    body: JSON.stringify({
      subject: input.subject,
      body: { contentType: input.contentType ?? "Text", content: input.body },
      toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
      ...(input.cc?.length
        ? { ccRecipients: input.cc.map((address) => ({ emailAddress: { address } })) }
        : {}),
      ...(input.bcc?.length
        ? { bccRecipients: input.bcc.map((address) => ({ emailAddress: { address } })) }
        : {}),
    }),
  })
  const draft = await graphJson(draftRes, "Create draft message")
  const messageId = String(draft.id ?? "")
  if (!messageId) throw new Error("Graph returned no message id for the draft")

  // 2. attachments, one upload session each
  for (const file of input.files) {
    await uploadAttachment(config.mailbox, messageId, file, token)
  }

  // 3. send it
  const sendRes = await fetch(`${base}/messages/${messageId}/send`, {
    method: "POST",
    headers: graphHeaders(token),
  })
  if (!sendRes.ok) {
    const text = await sendRes.text()
    throw new Error(`Sending the draft failed (${sendRes.status}): ${text.slice(0, 300)}`)
  }

  return { path: "upload", bytes, sentBytes: bytes }
}
