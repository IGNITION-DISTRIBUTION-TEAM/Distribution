import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildExportFiles, splitExportFile, type ExportFile } from "@/lib/distribution-export"
import {
  sendGraphMailFiles,
  TooLargeForInline,
  INLINE_LIMIT_BYTES,
  zippedBytesFor,
} from "@/lib/graph-mail"

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
    const { files, totalRows, lookupTier, lookupNotes, columns } = await buildExportFiles(cid)

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

    const asAttachment = (f: ExportFile) => ({
      name: f.filename,
      content: Buffer.from(f.csv, "utf-8"),
      contentType: "text/csv",
    })

    // Everything stays inside Mail.Send: the draft + upload path needs
    // Mail.ReadWrite, which this app does not hold. So a payload that will not
    // fit one message is split across several rather than escalating permission.
    //
    // Planning happens against MEASURED compressed sizes, not an assumed ratio.
    // The live export compressed to 22.6% where a sample suggested 11.6%, so
    // guessing would under-split and fail mid-send after some mail had gone out.
    const budget = Math.floor(INLINE_LIMIT_BYTES * 0.85) // headroom for the message itself

    /** Split one file until every part's compressed size fits the budget. */
    async function planFile(file: ExportFile): Promise<ExportFile[]> {
      const zipped = await zippedBytesFor([asAttachment(file)])
      const effective = zipped ?? Buffer.byteLength(file.csv, "utf-8")
      if (effective <= budget) return [file]

      // Start from the measured ratio, then verify and grow if still over.
      let parts = Math.max(2, Math.ceil(effective / budget))
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = splitExportFile(columns, file, parts)
        if (candidate.length < 2) return candidate
        const sizes = await Promise.all(
          candidate.map(async (c) => {
            const z = await zippedBytesFor([asAttachment(c)])
            return z ?? Buffer.byteLength(c.csv, "utf-8")
          })
        )
        if (sizes.every((b) => b <= budget)) return candidate
        // Scale up by the worst overshoot rather than adding one at a time.
        const worst = Math.max(...sizes)
        parts = Math.max(parts + 1, Math.ceil((parts * worst) / budget))
      }
      throw new Error(
        `Could not split ${file.filename} small enough to email — ${file.rows.toLocaleString()} rows ` +
          "still exceed one message after six attempts. Use Download data (CSV)."
      )
    }

    // One message for everything if it fits, otherwise one message per part.
    const sends: { subject: string; filename: string; rows: number; sentBytes: number }[] = []
    let planned: ExportFile[] | null = null

    try {
      const sent = await sendGraphMailFiles({
        to,
        subject,
        body: lines.join("\n"),
        archiveName: batchNames.length === 1 ? batchNames[0] : `distribution_${cid}`,
        files: files.map(asAttachment),
        allowUpload: false,
      })
      sends.push({
        subject,
        filename: files.map((f) => f.filename).join(", "),
        rows: totalRows,
        sentBytes: sent.sentBytes,
      })
    } catch (error) {
      if (!(error instanceof TooLargeForInline)) throw error
      // Plan every file, splitting any that is individually too big.
      planned = (await Promise.all(files.map(planFile))).flat()
    }

    if (planned) {
      const total = planned.length
      for (let i = 0; i < total; i++) {
        const part = planned[i]
        // Keep the batch name in the subject and add the part number, so the
        // dialler team can see which batch it belongs to and that it is one of a
        // set. The file name carries the same marker.
        const label = part.batchName ?? `campaign ${cid}`
        const partSubject = `Distribution export — ${label} — batch ${i + 1} of ${total}`
        const partBody = [
          `Distributed leads for campaign ${cid}.`,
          `Batch ${i + 1} of ${total}${part.batchName ? ` for ${part.batchName}` : ""}.`,
          `${part.filename} — ${part.rows.toLocaleString()} rows, CXM format (CSV, UTF-8, no BOM).`,
          "",
          `The full export is ${totalRows.toLocaleString()} rows and exceeds what one message can`,
          "carry, so it is sent as several. Each part has its own header row.",
          "",
          `Sent from the Distribution portal by ${guard.email}.`,
        ].join("\n")

        const sent = await sendGraphMailFiles({
          to,
          subject: partSubject,
          body: partBody,
          archiveName: part.filename.replace(/\.csv$/i, ""),
          files: [asAttachment(part)],
          allowUpload: false,
        })
        sends.push({
          subject: partSubject,
          filename: part.filename,
          rows: part.rows,
          sentBytes: sent.sentBytes,
        })
      }
    }

    return NextResponse.json({
      ok: true,
      to,
      rows: totalRows,
      messages: sends.length,
      split: !!planned,
      sends,
      // Degraded lookups are reported rather than passed off as a clean run.
      lookupTier,
      lookupNotes,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export/email] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
