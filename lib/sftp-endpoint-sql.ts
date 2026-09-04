/**
 * Build the INSERT that registers a new SFTP endpoint.
 *
 * PURE. NO I/O. The app never runs this statement — it validates the form,
 * renders the SQL, and someone with Snowflake access runs it.
 *
 * WHY THE APP DOES NOT WRITE THIS ROW. A row pairs a host with the public key
 * that will be trusted for that host. Host-key pinning only means something if
 * the pin does not come from whoever names the host: supply both and a bug, or
 * a crafted request from anyone who can reach this department, points the
 * downloader at a server of their choosing AND tells it to trust that server's
 * key — at which point it authenticates there with Spot's real private key.
 * That is credential exfiltration, not untidy config.
 *
 * So the whole form lives here, with all of the validation, and none of the
 * write. Adding a destination for the private key stays a deliberate act by
 * someone who already holds it.
 */

export const ENDPOINTS_TABLE = "SPOT_DW.SFTP_ADMIN.SFTP_ENDPOINTS"

/** Endpoint names are used as identifiers by the procedures that read them. */
const NAME_RE = /^[A-Za-z0-9_]+$/
/** A hostname, not a URL and not a connection string. */
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
/** An SFTP username. Deliberately narrow. */
const USER_RE = /^[A-Za-z0-9._-]+$/
/** An absolute POSIX path. Traversal is checked separately — see hasTraversal. */
const PATH_RE = /^\/[A-Za-z0-9._\-/]*$/

/**
 * Any `..` segment at all.
 *
 * PATH_RE allows dots so that a directory can be called `v1.2`, which means
 * "/spot_money/../etc" matches it — and it also passes a prefix test against a
 * floor of "/spot_money", because it literally starts with those characters.
 * The prefix test alone is therefore not enough, and this is not a normalise-
 * then-check: a form field has no business containing a traversal in the first
 * place, so it is refused outright.
 */
function hasTraversal(path: string): boolean {
  return path.split("/").includes("..")
}

export type EndpointDraft = {
  name: string
  label: string
  host: string
  port: number
  sftpUser: string
  hostKeyType: string
  hostKeyB64: string
  rootFloor: string
  allowedRoot: string
  maxEntries: number
  maxPeekLines: number
  maxPeekBytes: number
  notes: string
}

export const HOST_KEY_TYPES = ["ssh-rsa", "ssh-ed25519", "ecdsa-sha2-nistp256"] as const

export const EMPTY_ENDPOINT: EndpointDraft = {
  name: "",
  label: "",
  host: "",
  port: 22,
  sftpUser: "",
  hostKeyType: "ssh-rsa",
  hostKeyB64: "",
  rootFloor: "/",
  allowedRoot: "/",
  maxEntries: 500,
  maxPeekLines: 50,
  maxPeekBytes: 1048576,
  notes: "",
}

const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`

/**
 * Does this look like a PRIVATE key?
 *
 * This column has had a private key pasted into it once already. The name
 * "HOST_KEY_B64" reads as "a key" to someone who is also holding a private key
 * file, so the check is by shape and the message says what went wrong rather
 * than complaining about base64.
 */
function looksLikePrivateKey(value: string): boolean {
  const v = value.trim()
  return /-----BEGIN/.test(v) && /PRIVATE KEY/.test(v)
}

/**
 * Validate a draft. Returns one message per problem, in form order.
 *
 * Never echoes the host key: on the private-key path the whole point is not to
 * copy key material anywhere else, and an error string ends up in logs.
 */
export function validateEndpoint(d: EndpointDraft): string[] {
  const errors: string[] = []
  const int = (v: number) => Number.isInteger(v) && v > 0

  if (!NAME_RE.test(d.name)) {
    errors.push(
      `Name must be letters, digits and underscores — it is used as an identifier by the ` +
        `procedures that read it. Received ${JSON.stringify(d.name)}.`
    )
  }
  if (!d.label.trim()) errors.push("Give it a label; it is what the endpoint list shows.")
  if (!HOST_RE.test(d.host)) {
    errors.push(
      `Host must be a hostname such as securetransfer.example.com — not a URL, a port or a ` +
        `connection string. Received ${JSON.stringify(d.host)}.`
    )
  }
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    errors.push(`Port must be between 1 and 65535 — received ${d.port}.`)
  }
  if (!USER_RE.test(d.sftpUser)) {
    errors.push(`SFTP user must be letters, digits, dot, dash or underscore.`)
  }

  if (looksLikePrivateKey(d.hostKeyB64)) {
    errors.push(
      "That is a PRIVATE key. This field takes the SERVER's PUBLIC host key — the third field " +
        "of `ssh-keyscan -t rsa <host>` — which is the value pinned so an impostor server is " +
        "detected. A private key belongs only in the Snowflake secret. If you have already " +
        "pasted it anywhere, treat it as exposed and rotate the key pair: query history keeps " +
        "statement text for about a year and cannot be scrubbed."
    )
  } else if (!d.hostKeyB64.trim()) {
    errors.push(
      "The host key is required. Without a pin the connection is unverified, and an endpoint " +
        "with a blank key is refused at connect time anyway. Get it with " +
        "`ssh-keyscan -t rsa <host>` and paste the third field."
    )
  } else if (!/^[A-Za-z0-9+/=]+$/.test(d.hostKeyB64.trim())) {
    errors.push(
      "The host key must be the bare base64 third field of ssh-keyscan — no key type prefix, " +
        "no hostname, no comment."
    )
  } else if (d.hostKeyType === "ssh-rsa" && !d.hostKeyB64.trim().startsWith("AAAAB3NzaC1yc2E")) {
    // The SSH wire format is a 4-byte length followed by the key type as text,
    // so every ssh-rsa key base64-encodes to this same prefix.
    errors.push(
      "That does not look like an ssh-rsa key: every one starts AAAAB3NzaC1yc2E once base64 " +
        "encoded. Either the key type is wrong or this is a different field of the keyscan output."
    )
  }

  for (const [path, what] of [
    [d.rootFloor, "Root floor"],
    [d.allowedRoot, "Allowed root"],
  ] as const) {
    if (!PATH_RE.test(path)) {
      errors.push(`${what} must be an absolute path like /spot_money — received ${JSON.stringify(path)}.`)
    } else if (hasTraversal(path)) {
      errors.push(
        `${what} contains "..". Write the path you mean — a traversal here would read as inside ` +
          `the floor while pointing outside it.`
      )
    } else if (path === "/") {
      errors.push(
        `${what} cannot be "/" — that would let browsing reach the whole server. Name the ` +
          `subtree this endpoint is for.`
      )
    }
  }
  if (PATH_RE.test(d.rootFloor) && PATH_RE.test(d.allowedRoot)) {
    const floor = d.rootFloor.replace(/\/+$/, "")
    const allowed = d.allowedRoot.replace(/\/+$/, "")
    if (!(allowed === floor || allowed.startsWith(`${floor}/`))) {
      errors.push(
        `Allowed root must sit inside the root floor. The floor is the hard boundary and the ` +
          `app may narrow within it, never past it.`
      )
    }
  }

  if (!int(d.maxEntries)) errors.push("Max entries must be a positive whole number.")
  if (!int(d.maxPeekLines)) errors.push("Max peek lines must be a positive whole number.")
  if (!int(d.maxPeekBytes)) errors.push("Max peek bytes must be a positive whole number.")

  return errors
}

/**
 * The INSERT to run in Snowflake. Throws if the draft does not validate, so
 * there is no path that renders SQL from input nobody checked.
 */
export function buildEndpointInsert(d: EndpointDraft): string {
  const errors = validateEndpoint(d)
  if (errors.length > 0) {
    throw new Error(`Cannot build the statement:\n- ${errors.join("\n- ")}`)
  }
  const name = d.name.toUpperCase()
  return `/* Adds the ${name} endpoint. Run as a role that can write
   ${ENDPOINTS_TABLE}.

   The app deliberately cannot run this. This row pairs a host with the public
   key trusted for it, and the private key in DATAWAREHOUSE.SPOT will be offered
   to whatever host this names — so adding one stays a deliberate act by someone
   who already holds that key.

   Check first that the host key is the one the real server presents:
       ssh-keyscan -t ${d.hostKeyType.replace(/^ssh-/, "")} ${d.host} */

INSERT INTO ${ENDPOINTS_TABLE}
    (ENDPOINT_NAME, LABEL, HOST, PORT, SFTP_USER,
     HOST_KEY_TYPE, HOST_KEY_B64,
     SECRET_KEY_NAME, SECRET_PASSPHRASE_NAME,
     ROOT_FLOOR, ALLOWED_ROOT,
     MAX_ENTRIES, MAX_PEEK_LINES, MAX_PEEK_BYTES,
     ENABLED, NOTES)
SELECT ${lit(name)}, ${lit(d.label)}, ${lit(d.host)}, ${d.port}, ${lit(d.sftpUser)},
       ${lit(d.hostKeyType)}, ${lit(d.hostKeyB64.trim())},
       'pkey', 'passphrase',
       ${lit(d.rootFloor)}, ${lit(d.allowedRoot)},
       ${d.maxEntries}, ${d.maxPeekLines}, ${d.maxPeekBytes},
       TRUE, ${lit(d.notes)}
WHERE NOT EXISTS (
    SELECT 1 FROM ${ENDPOINTS_TABLE} WHERE ENDPOINT_NAME = ${lit(name)}
);

/* Then check it before anyone relies on it: */
CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_INSPECT(${lit(name)}, ${lit(d.allowedRoot)}, 'list', 10);`
}
