import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildExportFiles } from "@/lib/distribution-export"
import { sendGraphMail } from "@/lib/graph-mail"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Step 5 — email the step 4 export.
 *
 * Builds the file through the same buildExportFiles() the download uses, so what
 * lands in the mailbox is byte-identical to what the browser would have saved.
 * Each attachment is named after its BATCHNAME, which is what the dialler team
 * keys on.
 *
 * Recipient defaults to the DATA Operations and Dialler channel and can be
 * overridden per environment with DISTRIBUTION_EXPORT_EMAIL_TO (comma-separated
 * for several).
 */

const DEFAULT_TO = "b2a181bc.bizsparkmobiusco.onmicrosoft.com@emea.teams.ms"

// Graph's sendMail carries attachments inside the request body and caps the
// request at 4MB. Base64 inflates by 4/3, so 3MB of CSV already encodes to a
// full 4MB with nothing left for the message itself — the ceiling is set at
// 2.5MB (~3.3MB encoded) to leave headroom. Beyond that Graph needs an upload
// session against a draft message, which this does not implement, so the limit
// is checked up front and reported rather than failing deep inside the send.
const MAX_RAW_ATTACHMENT_BYTES = Math.floor(2.5 * 1024 * 1024)

function recipients(): string[] {
  const configured = (process.env.DISTRIBUTION_EXPORT_EMAIL_TO ?? "").trim()
  const list = (configured || DEFAULT_TO)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
  return list
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const raw = request.nextUrl.searchParams.get("campaignId") ?? ""
  if (!/^[0-9]+$/.test(raw)) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const cid = Number(raw)

  try {
    const { files, totalRows } = await buildExportFiles(cid)

    if (totalRows === 0) {
      return NextResponse.json(
        {
          error:
            "Nothing to send — the export returned no rows for today. Run the distribution and sync first.",
        },
        { status: 400 }
      )
    }

    const bytes = files.reduce((a, f) => a + Buffer.byteLength(f.csv, "utf-8"), 0)
    if (bytes > MAX_RAW_ATTACHMENT_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1)
      return NextResponse.json(
        {
          error:
            `The export is ${mb}MB, over the ${(MAX_RAW_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)}MB ` +
            "that fits in a Graph message. Use Download data (CSV) and attach it manually, or ask for " +
            "large-attachment support (an upload session against a draft) to be added.",
          bytes,
          rows: totalRows,
        },
        { status: 413 }
      )
    }

    const to = recipients()
    const batchNames = files.map((f) => f.batchName).filter((b): b is string => !!b)
    const subject =
      batchNames.length === 1
        ? `Distribution export — ${batchNames[0]}`
        : `Distribution export — campaign ${cid} (${files.length} batches)`

    const lines = [
      `Distributed leads for campaign ${cid}, ${totalRows.toLocaleString()} row${
        totalRows === 1 ? "" : "s"
      } in the CXM format (CSV, UTF-8, no BOM).`,
      "",
      ...files.map((f) => `  ${f.filename} — ${f.rows.toLocaleString()} rows`),
      "",
      `Sent from the Distribution portal by ${guard.email}.`,
    ]

    await sendGraphMail({
      to,
      subject,
      body: lines.join("\n"),
      attachments: files.map((f) => ({
        name: f.filename,
        contentBytes: Buffer.from(f.csv, "utf-8").toString("base64"),
        contentType: "text/csv",
      })),
    })

    return NextResponse.json({
      ok: true,
      to,
      subject,
      rows: totalRows,
      files: files.map((f) => ({ filename: f.filename, rows: f.rows })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export/email] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
