import { NextResponse } from "next/server"
import * as XLSX from "xlsx"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_SAMPLE_ROWS = 10

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File exceeds 50MB limit" }, { status: 400 })
    }

    const lower = file.name.toLowerCase()
    const isCsv = lower.endsWith(".csv")
    const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls")
    if (!isCsv && !isExcel) {
      return NextResponse.json(
        { error: "Only .csv, .xlsx, and .xls files are accepted" },
        { status: 400 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const workbook = isCsv
      ? XLSX.read(buffer.toString("utf-8"), { type: "string" })
      : XLSX.read(buffer, { type: "buffer", cellDates: true })

    const sheetName = workbook.SheetNames[0]
    if (!sheetName) {
      return NextResponse.json({ error: "File contains no sheets" }, { status: 400 })
    }

    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    })

    if (rows.length === 0) {
      return NextResponse.json({ error: "File contains no data rows" }, { status: 400 })
    }

    const headers = Object.keys(rows[0])
    const sample = rows.slice(0, MAX_SAMPLE_ROWS).map((row) =>
      headers.map((h) => {
        const v = row[h]
        return v === null || v === undefined ? "" : String(v)
      })
    )

    return NextResponse.json({
      fileName: file.name,
      sheetName,
      sheetCount: workbook.SheetNames.length,
      rowCount: rows.length,
      headers,
      sample,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/upload/preview] error:", message)
    return NextResponse.json({ error: `Failed to parse file: ${message}` }, { status: 500 })
  }
}
