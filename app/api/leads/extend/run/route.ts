import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SAFE_VALUE = /^[0-9A-Za-z]{1,32}$/

const TARGET_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS"
const HISTORY_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

type Body = { campaignId?: unknown; idnumbers?: unknown }

export async function POST(request: Request) {
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
  const steps: { name: string; ok: boolean; rowCount?: number; error?: string }[] = []

  const truncateSql = `TRUNCATE TABLE ${TARGET_TABLE}`

  const insertSql = `
INSERT INTO ${TARGET_TABLE}
SELECT * FROM (
  SELECT
    CAST(NULL AS VARCHAR(50)) AS CustomerCode,
    campaignid,
    IDNUMBER AS IdNumber,
    CASE WHEN CONCAT('0', RIGHT(CELLNUMBER, 9)) = '0'
         THEN CONCAT('0', RIGHT(contactnumber1, 9))
         ELSE CONCAT('0', RIGHT(CELLNUMBER, 9))
    END AS CellNumber,
    CUSTOMERNAME AS CustomerName,
    LASTNAME AS LastName,
    CAST(NULL AS VARCHAR(50)) AS Tariff,
    DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER1) AS ContactNumber1,
    DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER2) AS ContactNumber2,
    DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER3) AS ContactNumber3,
    CAST(NULL AS VARCHAR(50)) AS ContactNumber4,
    CAST(NULL AS VARCHAR(50)) AS AvgSpend,
    CAST(NULL AS VARCHAR(50)) AS HandsetType,
    CAST(NULL AS VARCHAR(50)) AS HandsetCost,
    CAST(NULL AS VARCHAR(50)) AS DelAdd,
    EMAIL AS Email,
    CAST(NULL AS VARCHAR(50)) AS ContractDate,
    CAST(NULL AS VARCHAR(50)) AS AllocateUser,
    CAST(NULL AS VARCHAR(50)) AS AllocateDate,
    CAST(NULL AS VARCHAR(50)) AS AllocateTimeFrom,
    CAST(NULL AS VARCHAR(50)) AS AllocateTimeTo,
    CURRENT_DATE() + 10 AS LeadExpiry,
    BatchName,
    REPLACE(EXTRADATA, ',', '') AS ExtraData,
    CAST(NULL AS VARCHAR(50)) AS SystemMessage,
    CAST(NULL AS VARCHAR(50)) AS CreatedByUserId,
    CURRENT_DATE() AS CreatedOnDate,
    CAST(NULL AS VARCHAR(50)) AS Affordability,
    AccountNumber AS AccountNumber,
    2 AS LeadSystemTypeId,
    BranchCode AS BranchCode,
    Bank AS Bank,
    BankAccountType AS BankAccountType,
    CAST(NULL AS VARCHAR(50)) AS AccountFirstName,
    CAST(NULL AS VARCHAR(50)) AS AccountLastName,
    CAST(NULL AS VARCHAR(50)) AS LeadSourceId,
    SOURCEORDERID AS SourceOrderId,
    HLL_ID,
    CAST(NULL AS VARCHAR(50)) AS OptInStatus
  FROM ${HISTORY_TABLE} s
  WHERE idnumber IN (${inList})
    AND campaignid = ${campaignIdNum}
    AND estatus IS NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY idnumber ORDER BY CREATEDONDATE DESC) = 1
)
`

  // Step 1 — truncate the target table
  try {
    await executeSnowflakeQuery(truncateSql, {
      database: "DATAWAREHOUSE",
      schema: "LEADS_DISTRIBUTION",
    })
    steps.push({ name: "truncate", ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "truncate", ok: false, error: message })
    return NextResponse.json({ ok: false, steps }, { status: 500 })
  }

  // Step 2 — insert
  let inserted = 0
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(insertSql, {
      database: "DATAWAREHOUSE",
      schema: "LEADS_DISTRIBUTION",
    })
    if (rows.length > 0) {
      const r = rows[0]
      const k = Object.keys(r)[0]
      const v = r[k]
      inserted = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0
    }
    steps.push({ name: "insert", ok: true, rowCount: inserted })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "insert", ok: false, error: message })
    return NextResponse.json({ ok: false, steps }, { status: 500 })
  }

  // Step 3 — sync to SQL Server via stored procedure
  const syncSql = `
    CALL DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE(
      'DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS',
      'Upload.TempUpload',
      'CustomerCode,CampaignId,IdNumber,CellNumber,CustomerName,LastName,Tariff,ContactNumber1,ContactNumber2,ContactNumber3,ContactNumber4,AvgSpend,HandsetType,HandsetCost,DelAdd,Email,ContractDate,AllocateUser,AllocateDate,AllocateTimeFrom,AllocateTimeTo,LeadExpiry,BatchName,ExtraData,SystemMessage,UpdatedByUserId,UpdatedOnDate,Affordability,AccountNumber,LeadSystemTypeId,BranchCode,Bank,BankAccountType,AccountFirstName,AccountLastName,LeadSourceId,SourceOrderId,HistoryLeadId,OptInStatus',
      10000
    )
  `
  let syncResult: Record<string, unknown>[] = []
  try {
    syncResult = await executeSnowflakeQuery<Record<string, unknown>>(syncSql, {
      database: "DATAWAREHOUSE",
      schema: "DISTRIBUTION_AUTOMATION",
    })
    steps.push({ name: "syncToSqlServer", ok: true, rowCount: syncResult.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "syncToSqlServer", ok: false, error: message })
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
