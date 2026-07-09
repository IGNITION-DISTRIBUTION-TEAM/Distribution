import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { SAFE_IDENT } from "@/lib/engaige-shared"
import { getSourceColumns } from "@/lib/engaige-server"

export const dynamic = "force-dynamic"

// GET /api/engaige/columns?table=NAME — source-table columns for mapping pickers.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "engaige")
  if (guard instanceof NextResponse) return guard

  const table = request.nextUrl.searchParams.get("table") ?? ""
  if (!SAFE_IDENT.test(table)) {
    return NextResponse.json({ error: "Invalid table name" }, { status: 400 })
  }
  try {
    const columns = await getSourceColumns(table)
    return NextResponse.json({ columns })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/engaige/columns] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
