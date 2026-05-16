import { NextResponse } from "next/server"
import { validateTableIndex } from "../../route"
import { buildDiallerCsv, DiallerCsvError } from "@/lib/dialler-csv"

export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ index: string }> }
) {
  const { index } = await params
  const idx = validateTableIndex(index)
  if (typeof idx !== "number") return NextResponse.json(idx, { status: 400 })

  try {
    const result = await buildDiallerCsv(idx)
    return new NextResponse(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Row-Count": String(result.rowCount),
        "X-View-Name": result.viewName,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    if (error instanceof DiallerCsvError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dialler-tables/[index]/csv] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
