import { NextResponse } from "next/server"
import JSZip from "jszip"
import { validateTableIndex } from "../route"
import { buildDiallerCsv, DiallerCsvError } from "@/lib/dialler-csv"

export const dynamic = "force-dynamic"
// Building all CSVs and a ZIP in memory can be slow; allow up to 5 minutes.
export const maxDuration = 300

type Body = { indices?: unknown }

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(body.indices) || body.indices.length === 0) {
    return NextResponse.json({ error: "indices must be a non-empty array" }, { status: 400 })
  }
  if (body.indices.length > 100) {
    return NextResponse.json({ error: "Max 100 indices per request" }, { status: 400 })
  }

  const validated: number[] = []
  for (const raw of body.indices) {
    const v = validateTableIndex(raw)
    if (typeof v !== "number") return NextResponse.json(v, { status: 400 })
    validated.push(v)
  }
  const uniqueIndices = Array.from(new Set(validated))

  const zip = new JSZip()
  const errors: { index: number; message: string }[] = []
  const used = new Set<string>()
  let successCount = 0

  for (const idx of uniqueIndices) {
    try {
      const result = await buildDiallerCsv(idx)
      // Avoid filename collisions inside the zip.
      let name = result.filename
      if (used.has(name)) {
        const dot = name.lastIndexOf(".")
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ""
        let n = 2
        while (used.has(`${stem}_${n}${ext}`)) n++
        name = `${stem}_${n}${ext}`
      }
      used.add(name)
      zip.file(name, result.csv)
      successCount++
    } catch (error) {
      const message =
        error instanceof DiallerCsvError
          ? error.message
          : error instanceof Error
          ? error.message
          : String(error)
      errors.push({ index: idx, message })
      console.error(`[/api/dialler-tables/csv-batch] index=${idx} error:`, message)
    }
  }

  if (successCount === 0) {
    return NextResponse.json(
      { error: "All requested views failed", errors },
      { status: 500 }
    )
  }

  if (errors.length > 0) {
    zip.file(
      "_errors.txt",
      errors.map((e) => `Index ${e.index}: ${e.message}`).join("\r\n")
    )
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" })

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const filename = `dialler_views_${stamp}.zip`

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-File-Count": String(successCount),
      "X-Error-Count": String(errors.length),
      "Cache-Control": "no-store",
    },
  })
}
