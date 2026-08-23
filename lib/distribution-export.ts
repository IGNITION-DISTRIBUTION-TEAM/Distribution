import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { rowsToCsv, safeFilename } from "@/lib/dialler-csv"
import { CONFIGS_TABLE, CONFIG_SF } from "@/lib/distribution-steps"
import { normLeadExpiryDays, DEFAULT_LEAD_EXPIRY_DAYS } from "@/lib/hll-insert"

/**
 * The distribution export, shared by the download (step 4) and the email
 * (step 5) so both produce byte-identical files. Extracted from the download
 * route rather than reimplemented — two copies of a CXM layout would drift, and
 * the version that goes to the dialler team must be the version that was
 * checked in the browser.
 */

const HLL = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

export type ExportFile = { filename: string; csv: string; rows: number; batchName: string | null }

export type ExportResult = {
  files: ExportFile[]
  totalRows: number
  /** Name for a bundle when there are several batches. */
  fallbackName: string
}

// Resolve the lead-expiry days configured for the campaign so the export's
// LeadExpiry matches what was loaded into the HLL. A campaign can have several
// automation configs — prefer an active one, then the most recently updated.
// Best-effort: falls back to the default (45) if nothing is configured or the
// lookup fails. Always returns a validated integer safe to interpolate.
export async function resolveLeadExpiryDays(cid: number): Promise<number> {
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
export function buildQuery(cid: number, expiryDays: number): string {
  return `with cte1 as (
  select a.IDNUMBER, a.LEADCUSTOMERID
  from "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER" a
  join "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMERDETAILS" b on a.LeadCustomerId = b.LeadCustomerId
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

/**
 * Run the export and split it into one file per BATCHNAME.
 *
 * The file name IS the batch name — that is what the dialler team keys on — with
 * rows carrying no batch falling back to a campaign+date name. Two batch names
 * that sanitise to the same file name get a numeric suffix rather than silently
 * overwriting one another.
 */
export async function buildExportFiles(cid: number): Promise<ExportResult> {
  const expiryDays = await resolveLeadExpiryDays(cid)
  const { columns, rows } = await executeSnowflakeQueryWithMeta(buildQuery(cid, expiryDays), {
    database: "DATAWAREHOUSE",
    schema: "DISTRIBUTION_DATA_APPLICATION",
  })

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const fallbackName = `distribution_${cid}_${stamp}`

  const batchIdx = columns.findIndex((c) => c.name.toUpperCase() === "BATCHNAME")
  const groups = new Map<string, { label: string; batchName: string | null; rows: unknown[][] }>()
  if (batchIdx >= 0) {
    for (const row of rows) {
      const v = row[batchIdx]
      const hasBatch = v !== null && v !== undefined && String(v) !== ""
      const key = hasBatch ? `b:${String(v)}` : "n:"
      const label = hasBatch ? safeFilename(String(v)) : `${fallbackName}_nobatch`
      const g = groups.get(key) ?? {
        label,
        batchName: hasBatch ? String(v) : null,
        rows: [] as unknown[][],
      }
      g.rows.push(row)
      groups.set(key, g)
    }
  }

  // No batch column at all, or nothing to group: a single file.
  if (groups.size === 0) {
    return {
      files: [
        { filename: `${fallbackName}.csv`, csv: rowsToCsv(columns, rows), rows: rows.length, batchName: null },
      ],
      totalRows: rows.length,
      fallbackName,
    }
  }

  const used = new Set<string>()
  const files: ExportFile[] = []
  for (const g of groups.values()) {
    let name = `${g.label}.csv`
    for (let n = 2; used.has(name); n++) name = `${g.label}_${n}.csv`
    used.add(name)
    files.push({
      filename: name,
      csv: rowsToCsv(columns, g.rows),
      rows: g.rows.length,
      batchName: g.batchName,
    })
  }
  return { files, totalRows: rows.length, fallbackName }
}
