/**
 * Checks for lib/sftp-endpoint-sql.ts and the registry round trip.
 *
 *   npx tsx scripts/task-automation/endpoint-sql-tests.ts
 *
 * The one that matters most is PRIVATE KEY: this column has had a private key
 * pasted into it once already, and the error must say so WITHOUT copying any of
 * the key into a message that ends up in logs.
 */
import {
  EMPTY_ENDPOINT,
  buildEndpointInsert,
  validateEndpoint,
  type EndpointDraft,
} from "../../lib/sftp-endpoint-sql"
import { rowToConfig } from "../../lib/sftp-sync-registry"
import { buildSyncScript, type SyncConfig } from "../../lib/sftp-sync-codegen"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const GOOD_KEY = "AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDhA9RBTfKQqiZ1nZQm8pQxQ0example"

function draft(over: Partial<EndpointDraft> = {}): EndpointDraft {
  return {
    ...EMPTY_ENDPOINT,
    name: "SPOT2",
    label: "Spot secure transfer",
    host: "securetransfer.spotplatformapi.com",
    port: 22,
    sftpUser: "ignition_snowflake_sync",
    hostKeyType: "ssh-rsa",
    hostKeyB64: GOOD_KEY,
    rootFloor: "/spot_money",
    allowedRoot: "/spot_money",
    notes: "Added from the app",
    ...over,
  }
}

/* ---- 1. A private key is refused, and never echoed ----------------------- */

console.log("Private key")
{
  const PEM =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n-----END OPENSSH PRIVATE KEY-----"
  const errors = validateEndpoint(draft({ hostKeyB64: PEM }))
  const joined = errors.join("\n")
  check("refused", errors.length > 0)
  check("says it is a private key", /PRIVATE key/.test(joined), joined)
  check("says to rotate", /rotate/i.test(joined))
  check(
    "NO key material in the message",
    !joined.includes("b3BlbnNzaC1rZXktdjEA") && !joined.includes("BEGIN OPENSSH"),
    "the error echoed part of the key"
  )
  let threw = false
  try {
    buildEndpointInsert(draft({ hostKeyB64: PEM }))
  } catch (e) {
    threw = true
    check("...and the built SQL never contains it", !String(e).includes("b3BlbnNzaC1rZXktdjEA"))
  }
  check("buildEndpointInsert throws rather than emitting", threw)
}

/* ---- 2. Other rejections -------------------------------------------------- */

console.log("Validation")
for (const [over, because] of [
  [{ name: "spot-2" }, "letters, digits and underscores"],
  [{ name: "a'b" }, "letters, digits and underscores"],
  [{ name: "" }, "letters, digits and underscores"],
  [{ label: "  " }, "label"],
  [{ host: "sftp://host.com" }, "hostname"],
  [{ host: "host.com:22" }, "hostname"],
  [{ host: "localhost" }, "hostname"],
  [{ port: 0 }, "between 1 and 65535"],
  [{ port: 70000 }, "between 1 and 65535"],
  [{ sftpUser: "a b" }, "SFTP user"],
  [{ hostKeyB64: "" }, "host key is required"],
  [{ hostKeyB64: "not base64!" }, "bare base64"],
  [{ hostKeyB64: "AAAAC3NzaC1lZDI1NTE5AAAA" }, "AAAAB3NzaC1yc2E"],
  [{ rootFloor: "/" }, 'cannot be "/"'],
  [{ allowedRoot: "/" }, 'cannot be "/"'],
  [{ rootFloor: "/spot_money", allowedRoot: "/etc" }, "inside the root floor"],
  [{ rootFloor: "/spot_money", allowedRoot: "/spot_money_other" }, "inside the root floor"],
  // Matches PATH_RE (dots are legal in a directory name) and passes a prefix
  // test against a floor of /spot_money, so only the .. check catches it.
  [{ allowedRoot: "/spot_money/../etc" }, 'contains ".."'],
  [{ rootFloor: "/spot_money/.." }, 'contains ".."'],
  [{ maxEntries: 0 }, "Max entries"],
  [{ maxPeekLines: -1 }, "Max peek lines"],
] as [Partial<EndpointDraft>, string][]) {
  const errors = validateEndpoint(draft(over))
  check(
    `refuses ${JSON.stringify(over)}`,
    errors.some((e) => e.includes(because)),
    errors.join(" | ") || "accepted"
  )
}

console.log("Acceptance")
{
  check("a good draft validates", validateEndpoint(draft()).length === 0, validateEndpoint(draft()).join(" | "))
  check(
    "a narrowed allowed root inside the floor is fine",
    validateEndpoint(draft({ rootFloor: "/spot_money", allowedRoot: "/spot_money/fees" })).length === 0
  )
  const sql = buildEndpointInsert(draft())
  check("emits an INSERT into the registry", /INSERT INTO SPOT_DW\.SFTP_ADMIN\.SFTP_ENDPOINTS/.test(sql))
  check("uppercases the name", sql.includes("'SPOT2'"))
  check("binds the secret names, not the secrets", sql.includes("'pkey', 'passphrase'"))
  check("is guarded against a duplicate", /WHERE NOT EXISTS/.test(sql))
  check("suggests verifying with SP_SFTP_INSPECT", sql.includes("SP_SFTP_INSPECT"))
  check("no stray quote breaks the statement", (sql.match(/'/g) ?? []).length % 2 === 0)
  // A quote in a free-text field must be escaped, not able to close a literal.
  const quoted = buildEndpointInsert(draft({ label: "Spot's transfer", notes: "it's fine" }))
  check("escapes quotes in free text", quoted.includes("'Spot''s transfer'") && quoted.includes("'it''s fine'"))
}

/* ---- 3. Registry round trip ---------------------------------------------- */

console.log("Registry round trip")
{
  const configs: SyncConfig[] = [
    {
      syncName: "ARPU_FEES",
      endpoint: "SPOT",
      remoteDir: "/spot_money",
      filePattern: "ARPU_*.csv",
      targetDb: "SPOT_DW",
      targetSchema: "SPOT_SFTP",
      targetTable: "ARPU_FEES",
      createTable: true,
      columns: [
        { source: "DATE", ordinal: 1, target: "TXN_DATE", type: "VARCHAR(1000)" },
        { source: "INCOME", ordinal: 3, target: "INCOME", type: "VARCHAR(1000)" },
      ],
      loadMode: "merge",
      mergeKeys: ["TXN_DATE"],
      delimiter: ",",
      skipHeader: true,
      warehouse: "SPOT_WH",
      scheduleCron: "0 7 * * *",
      scheduleTz: "Africa/Johannesburg",
      onError: "ABORT_STATEMENT",
    },
    // The tab is the case that would break a naive JSON round trip.
    {
      syncName: "TABBED",
      endpoint: "SPOT",
      remoteDir: "/spot_money",
      filePattern: "t_*.tsv",
      targetDb: "SPOT_DW",
      targetSchema: "SPOT_SFTP",
      targetTable: "TABBED",
      createTable: false,
      columns: [{ source: "a", ordinal: 1, target: "A", type: "VARCHAR" }],
      loadMode: "truncate_insert",
      mergeKeys: [],
      delimiter: "\t",
      skipHeader: false,
      warehouse: "SPOT_WH",
      scheduleCron: "30 5 * * 1-5",
      scheduleTz: "Africa/Johannesburg",
      onError: "CONTINUE",
    },
  ]

  for (const cfg of configs) {
    // Simulate what Snowflake hands back for a stored row.
    const row: Record<string, unknown> = {
      SYNC_NAME: cfg.syncName,
      ENDPOINT: cfg.endpoint,
      REMOTE_DIR: cfg.remoteDir,
      FILE_PATTERN: cfg.filePattern,
      TARGET_DB: cfg.targetDb,
      TARGET_SCHEMA: cfg.targetSchema,
      TARGET_TABLE: cfg.targetTable,
      CREATE_TABLE: cfg.createTable ? "true" : "false",
      COLUMN_MAP_JSON: JSON.stringify(cfg.columns),
      LOAD_MODE: cfg.loadMode,
      MERGE_KEYS_JSON: JSON.stringify(cfg.mergeKeys),
      DELIMITER: cfg.delimiter === "\t" ? "\\t" : cfg.delimiter,
      SKIP_HEADER: cfg.skipHeader ? "true" : "false",
      ON_ERROR: cfg.onError,
      SCHEDULE_CRON: cfg.scheduleCron,
      SCHEDULE_TZ: cfg.scheduleTz,
      WAREHOUSE: cfg.warehouse,
    }
    const back = rowToConfig(row)
    check(`${cfg.syncName}: config survives the round trip`, JSON.stringify(back) === JSON.stringify(cfg), JSON.stringify(back))
    // The check that actually matters: reopening a job and redeploying it must
    // produce the same objects, not merely a similar-looking config.
    const before = JSON.stringify(buildSyncScript(cfg).statements)
    const after = JSON.stringify(buildSyncScript(back).statements)
    check(`${cfg.syncName}: regenerates identical SQL`, before === after)
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
