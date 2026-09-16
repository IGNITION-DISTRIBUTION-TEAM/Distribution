import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"
import {
  DEPT_SLUG_RE,
  TICKETS_CONFIG_TABLE,
  TICKETS_DEPT_CONFIG_TABLE,
  validateFormConfig,
  type TicketFormConfig,
} from "@/lib/tickets-shared"
import {
  SF_OPTS,
  ensureTicketTables,
  getCustomisedDeptSlugs,
  getFieldLabels,
  getFormConfig,
  isDeptConfigAvailable,
  sqlString,
} from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

/**
 * The ticket form, which can differ PER DEPARTMENT.
 *
 * `?dept=<slug>` returns that department's form, falling back to the global one
 * when it has none. `source` says which was used, so the admin screen can show
 * whether a department is inheriting or has its own — without that, "this looks
 * like the default" and "this IS the default" are indistinguishable, and an
 * edit made on the wrong one silently changes every other department.
 */

// GET /api/tickets/form-config[?dept=<slug>][&labels=1]
// PUBLIC: the department capture links render this form without any login.
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams
  const dept = (p.get("dept") ?? "").trim()
  if (dept && !DEPT_SLUG_RE.test(dept)) {
    return NextResponse.json({ error: "Invalid department slug" }, { status: 400 })
  }

  try {
    await ensureTicketTables()
    const { config, source } = await getFormConfig(dept || null)

    // Only asked for by the admin views. The merged label map is a scan of the
    // whole config history, which the public capture form has no use for.
    const labels = p.get("labels") === "1" ? await getFieldLabels() : undefined
    const customised = p.get("labels") === "1" ? await getCustomisedDeptSlugs() : undefined

    return NextResponse.json({ config, source, labels, customisedDepartments: customised })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/form-config] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PUT /api/tickets/form-config — replace a form definition (super admin).
 *
 *   { config }                     the global form
 *   { dept: "<slug>", config }     that department's own form
 *   { dept: "<slug>", inherit: true }  drop it back to the global form
 *
 * Rows are append-only; the newest row for a department wins and older ones
 * remain as history. "inherit" writes a row with a NULL config rather than
 * deleting anything, because deletion would take the history with it and there
 * would be no record that the department ever had its own form.
 */
export async function PUT(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let body: { config?: TicketFormConfig; dept?: unknown; inherit?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const dept = String(body.dept ?? "").trim()
  if (dept && !DEPT_SLUG_RE.test(dept)) {
    return NextResponse.json({ error: "Invalid department slug" }, { status: 400 })
  }
  const inherit = body.inherit === true

  // The global form is what every department without its own one falls back to,
  // so there is nothing above it to inherit from.
  if (inherit && !dept) {
    return NextResponse.json(
      { error: "The default form cannot inherit — it is what departments fall back to" },
      { status: 400 }
    )
  }
  if (!inherit) {
    const problem = validateFormConfig(body.config)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })
  }

  try {
    await ensureTicketTables()

    // Per-department forms live in their own table. If it could not be created
    // the feature is off, and saying so beats a raw privileges error from the
    // INSERT — the default form keeps working either way.
    if (dept && !isDeptConfigAvailable()) {
      return NextResponse.json(
        {
          error:
            "Per-department forms are unavailable: " +
            `${TICKETS_DEPT_CONFIG_TABLE} could not be created. ` +
            "The app's role needs CREATE TABLE on DATAWAREHOUSE.LEADS_DISTRIBUTION. " +
            "The default form is unaffected.",
        },
        { status: 503 }
      )
    }

    const json = inherit ? "NULL" : sqlString(JSON.stringify(body.config))
    await executeSnowflakeQueryWithMeta(
      dept
        ? `INSERT INTO ${TICKETS_DEPT_CONFIG_TABLE} (CONFIG_JSON, DEPT_SLUG, UPDATED_BY) ` +
            `SELECT ${json}, ${sqlString(dept)}, ${sqlString(guard.email)}`
        : `INSERT INTO ${TICKETS_CONFIG_TABLE} (CONFIG_JSON, UPDATED_BY) ` +
            `SELECT ${json}, ${sqlString(guard.email)}`,
      SF_OPTS
    )
    return NextResponse.json({ success: true, inherit, dept: dept || null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/form-config] save error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
