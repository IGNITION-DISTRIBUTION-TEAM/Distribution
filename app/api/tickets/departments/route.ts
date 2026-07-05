import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireAuthenticated, requireSuperAdmin } from "@/lib/admin-guard"
import {
  TICKETS_DEPARTMENTS_TABLE,
  DEPT_SLUG_RE,
  slugifyDepartment,
} from "@/lib/tickets-shared"
import { SF_OPTS, ensureTicketTables, getActiveDepartments, sqlString } from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

// GET /api/tickets/departments — active departments. Any signed-in user (the
// capture page needs this before the requester has any department grants).
export async function GET(request: NextRequest) {
  const guard = await requireAuthenticated(request)
  if (guard instanceof NextResponse) return guard

  try {
    await ensureTicketTables()
    const departments = await getActiveDepartments()
    return NextResponse.json({ departments })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/departments] list error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/tickets/departments — add (or reactivate) a department. Super admin.
export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { name?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const name = String(body.name ?? "").trim().slice(0, 80)
  if (!name) return NextResponse.json({ error: "Department name is required" }, { status: 400 })
  const slug = slugifyDepartment(name)
  if (!DEPT_SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Name must contain letters or numbers" }, { status: 400 })
  }

  try {
    await ensureTicketTables()
    const { rows } = await executeSnowflakeQueryWithMeta(
      `SELECT COUNT(*) FROM ${TICKETS_DEPARTMENTS_TABLE} WHERE SLUG = ${sqlString(slug)}`,
      SF_OPTS
    )
    const exists = Number(rows[0]?.[0] ?? 0) > 0
    if (exists) {
      // Reactivate (and refresh the display name) instead of duplicating.
      await executeSnowflakeQueryWithMeta(
        `UPDATE ${TICKETS_DEPARTMENTS_TABLE} SET ACTIVE = TRUE, NAME = ${sqlString(name)} ` +
          `WHERE SLUG = ${sqlString(slug)}`,
        SF_OPTS
      )
    } else {
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${TICKETS_DEPARTMENTS_TABLE} (NAME, SLUG, ACTIVE, CREATED_BY) ` +
          `SELECT ${sqlString(name)}, ${sqlString(slug)}, TRUE, ${sqlString(guard.email)}`,
        SF_OPTS
      )
    }
    return NextResponse.json({ success: true, department: { name, slug } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/departments] add error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/tickets/departments?slug=<slug> — deactivate. Super admin.
// Soft delete: existing tickets keep their department answer; the capture
// link stops accepting new tickets.
export async function DELETE(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  const slug = request.nextUrl.searchParams.get("slug") ?? ""
  if (!DEPT_SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Invalid department slug" }, { status: 400 })
  }

  try {
    await executeSnowflakeQueryWithMeta(
      `UPDATE ${TICKETS_DEPARTMENTS_TABLE} SET ACTIVE = FALSE WHERE SLUG = ${sqlString(slug)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/departments] remove error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
