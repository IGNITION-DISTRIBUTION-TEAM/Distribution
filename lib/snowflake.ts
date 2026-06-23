/**
 * Snowflake connection utility using Key Pair JWT authentication.
 *
 * Required environment variables:
 *   SNOWFLAKE_ACCOUNT       - Snowflake account identifier (e.g. xy12345.us-east-1)
 *   SNOWFLAKE_USER          - Snowflake username
 *   SNOWFLAKE_PRIVATE_KEY   - RSA private key in PEM format (base64 encoded)
 *   SNOWFLAKE_KEY_FINGERPRINT - SHA256 fingerprint of the public key
 *   SNOWFLAKE_DATABASE      - Target database name
 *   SNOWFLAKE_SCHEMA        - Target schema name
 *   SNOWFLAKE_WAREHOUSE     - Warehouse to use
 *   SNOWFLAKE_ROLE          - Role to use (optional)
 *
 * The private key should be the base64 encoded content of your PEM file.
 * The key fingerprint should be in format: SHA256:<HEX_STRING>
 */

export type SnowflakeConfig = {
  account: string
  user: string
  privateKey: string
  keyFingerprint: string
  database: string
  schema: string
  warehouse: string
  role?: string
}

export function getSnowflakeConfig(): SnowflakeConfig {
  const account = process.env.SNOWFLAKE_ACCOUNT
  const user = process.env.SNOWFLAKE_USER
  const privateKey = process.env.SNOWFLAKE_PRIVATE_KEY
  const keyFingerprint = process.env.SNOWFLAKE_KEY_FINGERPRINT
  const database = process.env.SNOWFLAKE_DATABASE
  const schema = process.env.SNOWFLAKE_SCHEMA
  const warehouse = process.env.SNOWFLAKE_WAREHOUSE
  const role = process.env.SNOWFLAKE_ROLE

  if (!account || !user || !privateKey || !keyFingerprint || !database || !schema || !warehouse) {
    throw new Error(
      "Missing required Snowflake environment variables. " +
        "Please set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY, " +
        "SNOWFLAKE_KEY_FINGERPRINT, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA, and SNOWFLAKE_WAREHOUSE."
    )
  }

  return { account, user, privateKey, keyFingerprint, database, schema, warehouse, role }
}

/**
 * Generates a JWT token for Snowflake key pair authentication.
 * Exactly mirrors the Python implementation using PyJWT and cryptography library.
 */
export function generateSnowflakeJWT(config: SnowflakeConfig): string {
  const crypto = require("crypto")

  console.log("[JWT] ========== JWT Generation Start ==========")

  // Prepare private key
  let privateKeyPem = config.privateKey
  console.log("[JWT] Raw key length:", privateKeyPem.length)

  // Handle escaped newlines from environment variables
  privateKeyPem = privateKeyPem.replace(/\\n/g, "\n")

  // If key doesn't contain PEM markers, it's base64 encoded
  if (!privateKeyPem.includes("-----BEGIN")) {
    try {
      console.log("[JWT] Key is base64, decoding...")
      const decoded = Buffer.from(privateKeyPem, "base64").toString("utf-8")
      if (decoded.includes("-----BEGIN")) {
        privateKeyPem = decoded
        console.log("[JWT] Successfully decoded from base64")
      }
    } catch (e) {
      console.log("[JWT] Base64 decode failed, using as-is")
    }
  }

  // Build payload exactly like Python: qualified_username.fingerprint
  // Extract just the account ID (before the first dot) for the JWT
  // Full account is used for API URL, but JWT needs just the account ID
  const accountIdOnly = config.account.split(".")[0]
  const qualifiedUsername = `${accountIdOnly.toUpperCase()}.${config.user.toUpperCase()}`
  const fingerprint = config.keyFingerprint.trim()
  const issuer = `${qualifiedUsername}.${fingerprint}`

  console.log("[JWT] Account (full): " + config.account)
  console.log("[JWT] Account ID (for JWT): " + accountIdOnly)
  console.log("[JWT] Qualified username: " + qualifiedUsername)
  console.log("[JWT] Issuer: " + issuer)

  // Unix timestamps (PyJWT converts datetime to Unix timestamps)
  const now = Math.floor(Date.now() / 1000)
  const lifetime = 59 * 60

  const payload = {
    iss: issuer,
    sub: qualifiedUsername,
    iat: now,
    exp: now + lifetime,
  }

  console.log("[JWT] Payload:", JSON.stringify(payload, null, 2))

  // Build JWT manually using crypto.sign (same as PyJWT does internally)
  const base64url = (buf: Buffer | string): string => {
    const str = typeof buf === "string" ? buf : buf.toString("base64")
    return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  }

  const header = { alg: "RS256", typ: "JWT" }
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)))
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)))
  const message = `${encodedHeader}.${encodedPayload}`

  try {
    // Sign with SHA256 using the private key (PyJWT uses this exact approach)
    const signature = crypto.sign("sha256", Buffer.from(message), privateKeyPem)
    const encodedSignature = base64url(signature)
    const token = `${message}.${encodedSignature}`

    console.log("[JWT] Token generated successfully")
    console.log("[JWT] FULL TOKEN:", token)

    // Verify
    const parts = token.split(".")
    const decodedPayload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    )
    console.log("[JWT] Decoded payload:", JSON.stringify(decodedPayload, null, 2))
    console.log("[JWT] ========== JWT Generation Complete ==========")

    return token
  } catch (error) {
    console.error("[JWT] ERROR:", error)
    throw new Error(`JWT generation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export type SnowflakeColumn = {
  name: string
  type: string
  scale?: number
  precision?: number
}

/**
 * Format a Snowflake API value according to its declared column type.
 * Snowflake encodes:
 *   - DATE as days-since-epoch integer (string)
 *   - TIME as nanoseconds-since-midnight integer (string)
 *   - TIMESTAMP_* as "<seconds>.<nanos> [<tz_offset_minutes>]" (string)
 * Numeric types come through as strings too, but parseable as-is.
 *
 * Returns ISO/standard strings for date/time types so they're safe to pass
 * directly to the client.
 */
export function formatSnowflakeValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return value
  const upper = (type || "").toUpperCase()

  if (upper === "DATE") {
    const days = typeof value === "number" ? value : parseInt(String(value), 10)
    if (Number.isFinite(days)) {
      const d = new Date(days * 86_400_000)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
    return value
  }

  if (upper === "TIME") {
    const ns = typeof value === "number" ? value : parseInt(String(value), 10)
    if (Number.isFinite(ns)) {
      const totalSec = Math.floor(ns / 1_000_000_000)
      const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0")
      const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")
      const ss = String(totalSec % 60).padStart(2, "0")
      return `${hh}:${mm}:${ss}`
    }
    return value
  }

  if (upper.startsWith("TIMESTAMP")) {
    const seconds = parseFloat(String(value).split(/\s+/)[0])
    if (Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000)
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString().replace(/\.\d{3}Z$/, "Z")
      }
    }
    return value
  }

  return value
}

/**
 * Convert a Snowflake API result (rows + column metadata) into an array of
 * plain objects with date/time columns formatted as ISO/standard strings.
 */
export function formatSnowflakeRows(
  columns: SnowflakeColumn[],
  rows: unknown[][]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      obj[col.name] = formatSnowflakeValue(row[i], col.type)
    })
    return obj
  })
}

/**
 * Executes a SELECT statement against Snowflake via the SQL API and returns
 * the raw rows + column metadata. Used when callers need column types
 * (e.g. to format DATE/TIMESTAMP values).
 */
export async function executeSnowflakeQueryWithMeta(
  sql: string,
  opts: { database?: string; schema?: string } = {}
): Promise<{ columns: SnowflakeColumn[]; rows: unknown[][] }> {
  const config = getSnowflakeConfig()
  const jwt = generateSnowflakeJWT(config)
  const statementsUrl = `https://${config.account}.snowflakecomputing.com/api/v2/statements`
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
    Accept: "application/json",
    "User-Agent": "DataPlatform/1.0",
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
  }

  const body = {
    statement: sql,
    database: opts.database ?? config.database,
    schema: opts.schema ?? config.schema,
    warehouse: config.warehouse,
    role: config.role || "ACCOUNTADMIN",
  }

  const response = await fetch(statementsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Snowflake query failed (${response.status}): ${text}`)
  }

  const parsed = JSON.parse(text) as {
    statementHandle?: string
    resultSetMetaData?: {
      rowType?: { name: string; type: string; scale?: number; precision?: number }[]
      partitionInfo?: { rowCount?: number }[]
    }
    data?: unknown[][]
  }

  const columns = (parsed.resultSetMetaData?.rowType ?? []).map((c) => ({
    name: c.name,
    type: c.type,
    scale: c.scale,
    precision: c.precision,
  }))

  // The SQL API splits large result sets into partitions. `data` holds only the
  // first partition (index 0); any others are listed in partitionInfo and must
  // be fetched separately, or the result is silently truncated.
  const rows: unknown[][] = parsed.data ? [...parsed.data] : []

  const partitions = parsed.resultSetMetaData?.partitionInfo ?? []
  const handle = parsed.statementHandle
  if (handle && partitions.length > 1) {
    for (let p = 1; p < partitions.length; p++) {
      const partitionUrl =
        `${statementsUrl}/${encodeURIComponent(handle)}?partition=${p}`
      const partResponse = await fetch(partitionUrl, { method: "GET", headers })
      const partText = await partResponse.text()
      if (!partResponse.ok) {
        throw new Error(
          `Snowflake partition ${p} fetch failed (${partResponse.status}): ${partText}`
        )
      }
      const partParsed = JSON.parse(partText) as { data?: unknown[][] }
      if (partParsed.data) {
        // Append element-by-element: spreading a very large partition into
        // push(...) can exceed the JS argument-count limit.
        for (const r of partParsed.data) rows.push(r)
      }
    }
  }

  return { columns, rows }
}

/**
 * Executes a SELECT statement against Snowflake via the SQL API and returns
 * an array of plain objects keyed by column name.
 */
export async function executeSnowflakeQuery<T = Record<string, unknown>>(
  sql: string,
  opts: { database?: string; schema?: string } = {}
): Promise<T[]> {
  const { columns, rows } = await executeSnowflakeQueryWithMeta(sql, opts)
  return rows.map((row) => {
    const obj: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      obj[col.name] = row[i]
    })
    return obj as T
  })
}
