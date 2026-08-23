import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { buildExportFiles } from "@/lib/distribution-export"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

// GET ?campaignId=608 — export today's distributed leads for the campaign as a
// UTF-8 (no BOM) CSV in the CXM format, named after the batch. Several batches
// come back as a ZIP of per-batch CSVs.
//
// The file is built by lib/distribution-export.ts, shared with the step 5 email
// route so the emailed file is byte-identical to the downloaded one.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const raw = request.nextUrl.searchParams.get("campaignId") ?? ""
  if (!/^[0-9]+$/.test(raw)) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const cid = Number(raw)

  try {
    const { files, totalRows, fallbackName, lookupTier } = await buildExportFiles(cid)

    if (files.length <= 1) {
      const only = files[0]
      return new NextResponse(only ? only.csv : "", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${only ? only.filename : fallbackName + ".csv"}"`,
          "X-Row-Count": String(totalRows),
          "X-Lookup-Tier": lookupTier,
          "Cache-Control": "no-store",
        },
      })
    }

    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    for (const f of files) zip.file(f.filename, f.csv)
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" })
    return new NextResponse(new Uint8Array(zipBuf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fallbackName}.zip"`,
        "X-Row-Count": String(totalRows),
        "X-Batch-Count": String(files.length),
        "X-Lookup-Tier": lookupTier,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
