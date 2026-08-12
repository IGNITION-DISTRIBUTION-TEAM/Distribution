import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { rowsToCsv } from "@/lib/dialler-csv"
import { CONFIGS_TABLE, CONFIG_SF } from "@/lib/distribution-steps"
import { normLeadExpiryDays, DEFAULT_LEAD_EXPIRY_DAYS } from "@/lib/hll-insert"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const HLL = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

// Resolve the lead-expiry days configured for the campaign so the export's
// LeadExpiry matches what was loaded into the HLL. A campaign can have several
// automation configs — prefer an active one, then the most recently updated.
// Best-effort: falls back to the default (45) if nothing is configured or the
// lookup fails. Always returns a validated integer safe to interpolate.
async function resolveLeadExpiryDays(cid: number): Promise<number> {
  try {
    const rows = await executeSnowflakeQuery<{ LEAD_EXPIRY_DAYS: unknown }>(
      `SELECT LEAD_EXPIRY_DAYS FROM ${CONFIGS_TABLE}
       WHERE CAMPAIGNID = ${cid} AND LEAD_EXPIRY_DAYS IS NOT NULL
       ORDER BY COALESCE(IS_ACTIVE, TRUE) DESC, UPDATED_AT DESC NULLS LAST
       LIMIT 1`,
      CONFIG_SF
    )
    if (rows.length > 0) return normLeadExpiryDays(rows[0].LEAD_EXPIRY_DAYS)
  } catch {
    /* best-effort — fall back to the default below */
  }
  return DEFAULT_LEAD_EXPIRY_DAYS
}

// The distribution export in the agreed CXM format. `cid` is a validated
// integer substituted into both campaign-id filters; `expiryDays` is a
// validated integer used for the LeadExpiry column.
function buildQuery(cid: number, expiryDays: number): string {
  return `with cte1 as (
  select a.IDNUMBER, a.LEADCUSTOMERID
  from "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMER" a
  join "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMERDETAILS" b on a.LeadCustomerId = b.LeadCustomerId
  where CAMPAIGNID in (${cid})
)
SELECT RTRIM(LTRIM(CUSTOMERNAME)) AS "First Name"
     , RTRIM(LTRIM(LASTNAME)) AS "Last Name"
     , DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CELLNUMBER) as "Contact No"
     , EMAIL as "Email ID"
     , REGEXP_REPLACE(UDM7, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS "Address"
     , RTRIM(IFNULL(A.IDNUMBER, CELLNUMBER)) AS IDNUMBER
     , LEFT(A.IDNUMBER, 6) AS MASKID
     , CAMPAIGNID AS CAMPAIGNID
     , BATCHNAME AS BATCHNAME
     , CURRENT_DATE() AS CREATEDONDATE
     , CURRENT_DATE() + ${expiryDays} as LeadExpiry
     , NULL AS BANK
     , NULL AS BANKACCOUNTTYPE
     , NULL AS BRANCHCODE
     , NULL AS SERIAL_NUMBER
     , NULL AS DEBIT_DAY
     , NULL AS AVERAGESPEND
     , NULL AS MARKETING_OFFER_DESC
     , NULL AS ORDERDATE
     , REGEXP_REPLACE(UDM3, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS ADDRESS_RANK
     , NULL AS SOURCEORDER
     , NULL AS DEVICE_VALUE
     , NULL AS CONTRACTTYPE
     , NULL AS PAYDAY
     , NULL AS SOURCE
     , NULL AS UPGRADE_DATE
     , NULL AS ACTIVATIONDATE
     , NULL AS MVNX_NUMBER
     , REGEXP_REPLACE(UDM6, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS LTE_COVERAGE
     , NULL AS INSURANCEPRICE
     , NULL AS PREMIUM
     , REGEXP_REPLACE(UDM9, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS PROVINCE
     , NULL AS HANDSETPRICE
     , CAST(NULL AS NUMBER(38, 0)) AS PROVINCE_RANK
     , NULL AS DEVICE_TYPE
     , NULL AS DATE_OF_PURCHASE
     , NULL AS TAKEUP_PROB
     , CAST(NULL AS NUMBER(38, 0)) AS MATOGEN_SCORE
     , SCORE AS SCORE
     , SCOREGROUP AS SCOREGROUP
     , CASE
       WHEN OPTINSTATUS::INT = 0 THEN 'CUSTOMER NOT OPTED IN'
       WHEN OPTINSTATUS::INT = 1 THEN 'CUSTOMER ALREADY OPTED'
       WHEN OPTINSTATUS::INT = 2 THEN 'CUSTOMER ALREADY OPTED OUT'
       END AS OPTINSTATUS
     , PROPENSITYTOCONNECT::INT AS PROPENSITYTOCONNECT
     , NULL AS SKILL
     , NULL AS BANK_ACCOUNT_MASKED
     , A.HLL_ID
     , NULL AS CURRENT_PACKAGE
     , REGEXP_REPLACE(UDM30, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS DATA_DAY_RANK
     , NULL AS DEVICE_DETAILS
     , NULL AS PROVIDER_ACCOUNT_NUMBER
     , LEADCUSTOMERID AS SS_LEADCUSTOMERID
     , CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CELLNUMBER)
        THEN NULL ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1) END AS CONTACTNUMBER2
     , CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER1)
        OR DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CELLNUMBER)
        THEN NULL ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(CONTACTNUMBER2) END AS CONTACTNUMBER3
     , NULL AS COMMENT
     , REGEXP_REPLACE(EXTRADATA, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS EXTRADATA
     , NULL AS "Next Dial Time"
FROM ${HLL} a
left join cte1 b on a.IDNUMBER = b.IDNUMBER
WHERE CAMPAIGNID in (${cid})
  AND cast(CREATEDONDATE as date) = cast(CURRENT_DATE() AS date)
  AND ESTATUS IS NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY a.IDNUMBER ORDER BY score desc) = 1
order by cast(UDM30 as int) asc`
}

// GET ?campaignId=608 — export today's distributed leads for the campaign as a
// UTF-8 (no BOM) CSV in the CXM format.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const raw = request.nextUrl.searchParams.get("campaignId") ?? ""
  if (!/^[0-9]+$/.test(raw)) return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  const cid = Number(raw)

  try {
    const expiryDays = await resolveLeadExpiryDays(cid)
    const { columns, rows } = await executeSnowflakeQueryWithMeta(buildQuery(cid, expiryDays), {
      database: "DATAWAREHOUSE",
      schema: "DISTRIBUTION_DATA_APPLICATION",
    })
    const csv = rowsToCsv(columns, rows)
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const filename = `distribution_${cid}_${stamp}.csv`
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Row-Count": String(rows.length),
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/export] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
