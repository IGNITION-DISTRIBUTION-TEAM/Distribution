import { NextResponse } from "next/server"
import {
  executeSnowflakeQuery,
  executeSnowflakeQueryWithMeta,
  formatSnowflakeRows,
} from "@/lib/snowflake"

export const dynamic = "force-dynamic"

type LookupKind = "idnumber" | "cellnumber"

type Body = {
  campaignId?: string | number
  lookupKind?: LookupKind
  values?: string[]
}

type HistoryRow = {
  IDNUMBER: string | null
  CELLNUMBER: string | null
  CREATEDONDATE: string | null
  LEADEXPIRY: string | null
  ESTATUS: string | null
}

const HISTORY_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const SS_VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_EXPIRED_SS_CHECKS"

// idnumber and cellnumber are digit strings — reject anything else as a safety net.
const SAFE_VALUE = /^[0-9A-Za-z]{1,32}$/

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { campaignId, lookupKind, values } = body

  if (!campaignId || !/^[0-9]+$/.test(String(campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  if (lookupKind !== "idnumber" && lookupKind !== "cellnumber") {
    return NextResponse.json(
      { error: 'lookupKind must be "idnumber" or "cellnumber"' },
      { status: 400 }
    )
  }
  if (!Array.isArray(values) || values.length === 0) {
    return NextResponse.json({ error: "values must be a non-empty array" }, { status: 400 })
  }

  const cleaned = Array.from(new Set(values.map((v) => String(v).trim()).filter(Boolean)))
  const invalid = cleaned.filter((v) => !SAFE_VALUE.test(v))
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid lookup values: ${invalid.slice(0, 5).join(", ")}` },
      { status: 400 }
    )
  }
  if (cleaned.length > 5000) {
    return NextResponse.json({ error: "Max 5000 values per request" }, { status: 400 })
  }

  const inList = cleaned.map((v) => `'${v}'`).join(",")
  const sql = `
    SELECT idnumber, cellnumber, createdondate, leadexpiry, estatus
    FROM ${HISTORY_TABLE}
    WHERE campaignid = ${Number(campaignId)}
      AND ${lookupKind} IN (${inList})
  `

  try {
    const meta = await executeSnowflakeQueryWithMeta(sql, {
      database: "DATAWAREHOUSE",
      schema: "DISTRIBUTION_DATA_APPLICATION",
    })
    const rows = formatSnowflakeRows(meta.columns, meta.rows) as unknown as HistoryRow[]

    const byValue = new Map<string, HistoryRow>()
    for (const row of rows) {
      const key = lookupKind === "idnumber" ? row.IDNUMBER : row.CELLNUMBER
      if (!key) continue
      const existing = byValue.get(key)
      // Keep the row with the most recent createdondate
      if (
        !existing ||
        (row.CREATEDONDATE && existing.CREATEDONDATE && row.CREATEDONDATE > existing.CREATEDONDATE)
      ) {
        byValue.set(key, row)
      }
    }

    // Collect idnumbers from history hits — used to look up in the SS expired view.
    const idnumbersToCheck = Array.from(
      new Set(
        Array.from(byValue.values())
          .map((row) => row.IDNUMBER)
          .filter((v): v is string => !!v && SAFE_VALUE.test(v))
      )
    )

    type SsRow = Record<string, unknown> & { IDNUMBER?: string | number | null }
    const ssByIdnumber = new Map<string, SsRow>()
    let ssError: string | null = null
    let ssColumns: string[] = []

    if (idnumbersToCheck.length > 0) {
      const ssInList = idnumbersToCheck.map((v) => `'${v}'`).join(",")
      const ssSql = `
        SELECT * FROM ${SS_VIEW}
        WHERE IDNUMBER IN (${ssInList})
          AND CAMPAIGNID = ${Number(campaignId)}
      `
      try {
        const ssMeta = await executeSnowflakeQueryWithMeta(ssSql, {
          database: "DATAWAREHOUSE",
          schema: "LEADS_DISTRIBUTION",
        })
        const ssRows = formatSnowflakeRows(ssMeta.columns, ssMeta.rows) as SsRow[]
        if (ssRows.length > 0) ssColumns = ssMeta.columns.map((c) => c.name)
        for (const row of ssRows) {
          const idn = row.IDNUMBER
          if (idn === null || idn === undefined) continue
          ssByIdnumber.set(String(idn), row)
        }
      } catch (error) {
        // Don't fail the whole request — surface the error so the UI can show "history OK, SS failed".
        ssError = error instanceof Error ? error.message : String(error)
        console.error("[/api/leads/extend/check] SS lookup error:", ssError)
      }
    }

    const results = cleaned.map((value) => {
      const hit = byValue.get(value)
      const ssRow = hit?.IDNUMBER ? ssByIdnumber.get(hit.IDNUMBER) : undefined
      return {
        value,
        inHistory: !!hit,
        idnumber: hit?.IDNUMBER ?? null,
        cellnumber: hit?.CELLNUMBER ?? null,
        historyCreatedOn: hit?.CREATEDONDATE ?? null,
        historyExpiry: hit?.LEADEXPIRY ?? null,
        // ESTATUS gates upload: NULL = eligible to upload, any value = blocked.
        historyEstatus: hit?.ESTATUS ?? null,
        inSs: !!ssRow,
        ssRow: ssRow ?? null,
      }
    })

    return NextResponse.json({
      results,
      totalChecked: cleaned.length,
      totalFound: byValue.size,
      ss: { columns: ssColumns, error: ssError, idnumbersChecked: idnumbersToCheck.length },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/extend/check] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
