/**
 * Verify the DWH_automation Graph certificate locally and print what to paste
 * into App settings → Email and into the GRAPH_MAIL_PRIVATE_KEY env var.
 *
 * Run this on your own machine, never on a shared box: it reads the private
 * key. Nothing is uploaded — this is offline maths only.
 *
 * First convert the .pfx Azure gave you into a PEM private key (enter the
 * certificate password from Teams when prompted):
 *
 *   openssl pkcs12 -in DWH_automation-app-private.pfx -nocerts -nodes -out key.pem
 *
 * Then:
 *
 *   node scripts/graph-cert-check.mjs key.pem DWH_automation-app-public.cer
 *
 * It confirms the private key really matches the public certificate, prints the
 * thumbprint to paste into settings, and writes an env-ready key file.
 *
 * DELETE key.pem (and the generated .env-snippet.txt) once the value is in
 * Vercel — they contain the unencrypted private key.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { X509Certificate, createPrivateKey, createHash } from "node:crypto"

const [keyPath, certPath, passphraseArg] = process.argv.slice(2)

if (!keyPath) {
  console.error(
    "Usage: node scripts/graph-cert-check.mjs <key.pem> [public.cer] [pem-passphrase]\n\n" +
      "Convert the .pfx first:\n" +
      "  openssl pkcs12 -in DWH_automation-app-private.pfx -nocerts -nodes -out key.pem"
  )
  process.exit(1)
}

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

// ---- private key ----------------------------------------------------------
let privateKey
let keyPem
let encrypted = false
try {
  keyPem = readFileSync(keyPath, "utf-8")
  // openssl -nocerts output starts with "Bag Attributes" preamble; node is fine
  // with that, but trim to the PEM block so the env value stays clean.
  const match = keyPem.match(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/)
  if (!match) {
    console.error(`✗ No PRIVATE KEY block found in ${keyPath}.`)
    console.error("  Did the openssl conversion succeed? Check the password.")
    process.exit(1)
  }
  keyPem = match[0] + "\n"

  // An encrypted PEM makes node prompt on stdin and fail with an opaque error,
  // so detect it up front: PKCS#8 says "ENCRYPTED PRIVATE KEY", the legacy
  // OpenSSL format carries Proc-Type/DEK-Info headers inside the block.
  encrypted = /BEGIN ENCRYPTED PRIVATE KEY/.test(keyPem) || /DEK-Info:/.test(keyPem)
  if (encrypted && !passphraseArg) {
    console.error(`✗ ${keyPath} is an ENCRYPTED private key and no passphrase was given.`)
    console.error("\n  Either re-run the conversion so the PEM is unencrypted:")
    console.error("    openssl pkcs12 -in <file>.pfx -nocerts -nodes -out key.pem")
    console.error("\n  Or keep it encrypted, pass the passphrase to verify it here:")
    console.error(`    node scripts/graph-cert-check.mjs ${keyPath} <public.cer> "<passphrase>"`)
    console.error("  ...and also set GRAPH_MAIL_KEY_PASSPHRASE in Vercel alongside the key.")
    process.exit(1)
  }

  privateKey = passphraseArg
    ? createPrivateKey({ key: keyPem, passphrase: passphraseArg })
    : createPrivateKey(keyPem)
} catch (err) {
  console.error(`✗ Could not read a private key from ${keyPath}: ${err.message}`)
  if (/bad decrypt|passphrase|PEM routines|interrupted or cancelled/i.test(err.message)) {
    console.error("  If the PEM is encrypted, pass the passphrase as the 3rd argument,")
    console.error("  or re-run the openssl conversion with -nodes to produce a plain key.")
  }
  process.exit(1)
}
console.log(`✓ Private key read (${privateKey.asymmetricKeyType}, ${privateKey.asymmetricKeyDetails?.modulusLength ?? "?"} bits)`)

// ---- public certificate (optional but strongly recommended) ---------------
let thumbprintHex = null
if (certPath) {
  let cert
  try {
    const raw = readFileSync(certPath)
    // X509Certificate accepts PEM text or DER bytes.
    cert = new X509Certificate(raw)
  } catch (err) {
    console.error(`✗ Could not read certificate ${certPath}: ${err.message}`)
    process.exit(1)
  }

  if (!cert.checkPrivateKey(privateKey)) {
    console.error("✗ MISMATCH: this private key does not belong to that certificate.")
    console.error("  You likely converted a different .pfx than the .cer uploaded to Azure.")
    process.exit(1)
  }
  console.log("✓ Private key matches the public certificate")

  thumbprintHex = cert.fingerprint.replace(/:/g, "").toUpperCase()
  const validTo = new Date(cert.validTo)
  const daysLeft = Math.round((validTo.getTime() - Date.now()) / 86_400_000)
  console.log(`✓ Subject: ${cert.subject.replace(/\n/g, " ")}`)
  console.log(
    `${daysLeft > 30 ? "✓" : "!"} Valid until ${validTo.toDateString()} (${daysLeft} days left)`
  )
  if (daysLeft <= 0) console.log("  ⚠ This certificate has EXPIRED — Azure AD will reject it.")
}

console.log("\n──── paste into App settings → Email ────")
if (thumbprintHex) {
  console.log(`Certificate thumbprint : ${thumbprintHex}`)
  console.log(`(x5t sent to Azure AD  : ${base64url(Buffer.from(thumbprintHex, "hex"))})`)
  console.log("\nConfirm this thumbprint matches the one IT sent you. If it differs,")
  console.log("the wrong certificate is registered on the app and auth will fail.")
} else {
  console.log("Re-run with the .cer path to print and verify the thumbprint.")
}

// ---- env-ready private key -----------------------------------------------
const outPath = ".env-snippet.txt"
let snippet = `GRAPH_MAIL_PRIVATE_KEY="${keyPem.trimEnd()}"\n`
if (encrypted) {
  snippet += `GRAPH_MAIL_KEY_PASSPHRASE="<the PEM passphrase>"\n`
}
writeFileSync(outPath, snippet, { mode: 0o600 })
console.log(`\n──── private key ────`)
console.log(`Written to ${outPath} as a ready-to-paste GRAPH_MAIL_PRIVATE_KEY value.`)
if (encrypted) {
  console.log("The key is encrypted, so GRAPH_MAIL_KEY_PASSPHRASE must be set too")
  console.log("(the snippet has a placeholder — fill in the passphrase yourself).")
}
console.log("Add it to Vercel → Project → Settings → Environment Variables, then redeploy.")
console.log(`\n⚠ Delete ${outPath} and ${keyPath} once it is in Vercel.`)
