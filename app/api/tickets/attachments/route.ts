import { NextRequest, NextResponse } from "next/server"
import { get } from "@vercel/blob"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"

// GET /api/tickets/attachments?path=<blob pathname> — stream a private ticket
// attachment. Blobs are stored with access: 'private', so this authenticated
// route (tickets grant required) is the only way to read them.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "tickets")
  if (guard instanceof NextResponse) return guard

  const path = request.nextUrl.searchParams.get("path") ?? ""
  // Only ticket attachments — never arbitrary blobs from the store.
  if (!/^tickets\/[\w.\-/]+$/.test(path)) {
    return NextResponse.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  try {
    const result = await get(path, { access: "private" })
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
    }
    const filename = path.split("/").pop() ?? "attachment"
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType || "application/octet-stream",
        "Content-Length": String(result.blob.size),
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/attachments] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
