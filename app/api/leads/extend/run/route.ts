import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { EXTEND_DATES, pushToSilverSurfer } from "@/lib/silversurfer-push"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SAFE_VALUE = /^[0-9A-Za-z]{1,32}$/

const TARGET_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS"

type Body = { campaignId?: unknown; idnumbers?: unknown }

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { campaignId, idnumbers } = body
  if (!campaignId || !/^[0-9]+$/.test(String(campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const campaignIdNum = Number(campaignId)

  if (!Array.isArray(idnumbers) || idnumbers.length === 0) {
    return NextResponse.json({ error: "idnumbers must be a non-empty array" }, { status: 400 })
  }
  if (idnumbers.length > 5000) {
    return NextResponse.json({ error: "Max 5000 idnumbers per request" }, { status: 400 })
  }

  const cleaned = Array.from(
    new Set(
      (idnumbers as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    )
  )
  const invalid = cleaned.filter((v) => !SAFE_VALUE.test(v))
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid idnumbers: ${invalid.slice(0, 5).join(", ")}` },
      { status: 400 }
    )
  }

  const inList = cleaned.map((v) => `'${v}'`).join(",")
  /**
   * The truncate -> insert -> CALL sequence now lives in lib/silversurfer-push.ts
   * so the Batch upload check can reuse it without forking a 39-column
   * positional contract. EXTEND_DATES keeps this route's own behaviour: it
   * exists to MOVE the expiry, so it writes CURRENT_DATE() + 10.
   */
  const where =
    `idnumber IN (${inList})\n` +
    `    AND campaignid = ${campaignIdNum}\n` +
    `    AND (estatus IS NULL OR UPPER(TRIM(estatus)) IN ('SALE', 'SALE MADE'))`
  const qualify =
    "QUALIFY ROW_NUMBER() OVER (PARTITION BY idnumber ORDER BY CREATEDONDATE DESC) = 1"

  const result = await pushToSilverSurfer({
    stagingTable: TARGET_TABLE,
    where,
    qualify,
    dates: EXTEND_DATES,
  })
  const { steps, inserted, syncResult } = result
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, steps, inserted, requested: cleaned.length },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok: true,
    steps,
    inserted,
    requested: cleaned.length,
    syncResult,
  })
}
