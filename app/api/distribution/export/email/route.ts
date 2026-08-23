import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildExportFiles } from "@/lib/distribution-export"
import { sendGraphMailFiles } from "@/lib/graph-mail"

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

// No size ceiling: sendGraphMailFiles() takes the single-request path for small
// payloads and switches to a draft plus chunked upload sessions for large ones,
// so an export of any size sends.

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
    const { files, totalRows, lookupTier, lookupNotes } = await buildExportFiles(cid)

    if (totalRows === 0) {
      return NextResponse.json(
        {
          error:
            "Nothing to send — the export returned no rows for today. Run the distribution and sync first.",
        },
        { status: 400 }
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
      ...(lookupTier === "noLookup"
        ? [
            "NOTE: SS_LEADCUSTOMERID is empty in this file — the SilverSurfer lookup",
            "is not reachable by the reporting role. Every other column is unaffected.",
            "",
          ]
        : lookupTier === "noDetails"
        ? [
            "NOTE: SS_LEADCUSTOMERID was resolved without the LEAD_LEADCUSTOMERDETAILS",
            "filter, which was not reachable. Row count is unaffected.",
            "",
          ]
        : []),
      `Sent from the Distribution portal by ${guard.email}.`,
    ]

    const sent = await sendGraphMailFiles({
      to,
      subject,
      body: lines.join("\n"),
      // Used only if the files have to be zipped to fit a single request.
      archiveName: batchNames.length === 1 ? batchNames[0] : `distribution_${cid}`,
      files: files.map((f) => ({
        name: f.filename,
        content: Buffer.from(f.csv, "utf-8"),
        contentType: "text/csv",
      })),
    })

    return NextResponse.json({
      ok: true,
      to,
      subject,
      rows: totalRows,
      bytes: sent.bytes,
      sentBytes: sent.sentBytes,
      // "upload" means it went via a draft and chunked upload sessions, which is
      // slower but unbounded; "inline" is the single-request path.
      transport: sent.path,
      // Degraded lookups are reported rather than passed off as a clean run.
      lookupTier,
      lookupNotes,
      files: files.map((f) => ({ filename: f.filename, rows: f.rows })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export/email] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
