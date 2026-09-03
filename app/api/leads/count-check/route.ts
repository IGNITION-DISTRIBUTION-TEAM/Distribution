import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { readCampaignSetting } from "@/lib/config-lookup"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const HLL_SF_OPTS = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

async function countRows(sql: string, opts: { database: string; schema: string }): Promise<number> {
  const rows = await executeSnowflakeQuery<{ CNT: number | string }>(sql, opts)
  const v = rows[0]?.CNT
  return typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0
}

// Compare the stage table row count against the HLL (main) table for this
// campaign loaded today. Stage table is read from the campaign config.
export async function POST(request: Request) {
  let body: { campaignId?: unknown; configId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const id = Number(body.campaignId)
  const configId =
    body.configId != null && /^[0-9]+$/.test(String(body.configId)) ? Number(body.configId) : null

  let stageTable: string | null
  let configSource: string
  try {
    const found = await readCampaignSetting(id, configId, ["UPLOAD_TARGET_TABLE"])
    stageTable = found.value
    configSource = found.source
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/count-check] config read error:", message)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  if (!stageTable) {
    return NextResponse.json(
      {
        error:
          `No upload target (stage) table is configured for campaign ${id}` +
          `${configId != null ? ` in config ${configId}` : ""}. Set it in ` +
          `Settings → Campaign automation, on the same config this panel is using — ` +
          `checked ${configSource}.`,
      },
      { status: 400 }
    )
  }
  stageTable = stageTable.trim()
  if (!QUALIFIED.test(stageTable)) {
    return NextResponse.json(
      { error: `Configured stage table is not a valid DATABASE.SCHEMA.NAME: ${stageTable}` },
      { status: 400 }
    )
  }
  const [stageDb, stageSchema] = stageTable.split(".")

  try {
    const [stageCount, hllCount] = await Promise.all([
      countRows(`SELECT COUNT(1) AS CNT FROM ${stageTable}`, {
        database: stageDb,
        schema: stageSchema,
      }),
      // Campaign + today, deliberately WITHOUT an ESTATUS filter.
      countRows(
        `SELECT COUNT(1) AS CNT FROM ${HLL_TABLE}
         WHERE CAMPAIGNID = ${id}
           AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()`,
        HLL_SF_OPTS
      ),
    ])

    return NextResponse.json({
      stageTable,
      stageCount,
      hllCount,
      match: stageCount === hllCount,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/count-check] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
