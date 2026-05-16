import { readFileSync } from "node:fs"
import { createPublicKey, createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, "..", ".env.local")
const env = readFileSync(envPath, "utf-8")

function readMultiline(name) {
  const re = new RegExp(`^${name}="([\\s\\S]*?)"`, "m")
  const m = env.match(re)
  if (m) return m[1]
  const single = new RegExp(`^${name}=(.*)$`, "m")
  const s = env.match(single)
  return s ? s[1] : null
}

const pk = readMultiline("SNOWFLAKE_PRIVATE_KEY")
const envFp = readMultiline("SNOWFLAKE_KEY_FINGERPRINT")

if (!pk || !pk.includes("BEGIN")) {
  console.error("Could not read SNOWFLAKE_PRIVATE_KEY")
  process.exit(1)
}

const publicKey = createPublicKey(pk)
const der = publicKey.export({ type: "spki", format: "der" })
const fingerprint = "SHA256:" + createHash("sha256").update(der).digest("base64")

console.log("Computed fingerprint :", fingerprint)
console.log("Env fingerprint      :", envFp)
console.log("Match                :", fingerprint === envFp ? "YES ✓" : "NO ✗")
