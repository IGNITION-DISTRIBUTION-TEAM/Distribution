import { executeSnowflakeQuery } from "@/lib/snowflake"

/**
 * Pushing HLL leads on to SilverSurfer.
 *
 * SilverSurfer is a SQL Server system, not a Snowflake schema. The push is a
 * three-step sequence that `app/api/leads/extend/run/route.ts` has been running
 * in production, and which this module now owns so a second caller cannot
 * fork it:
 *
 *   1. TRUNCATE an app-owned staging table in LEADS_DISTRIBUTION;
 *   2. INSERT the leads to send into it, straight from the HLL table;
 *   3. CALL SP_SYNC_TO_SQLSERVER_LARGE pointing at that staging table.
 *
 * THE PROCEDURE TAKES ANY QUALIFIED OBJECT NAME as its source, which is the
 * whole reason this is generic. There is no per-campaign view to maintain —
 * "which leads" is an ordinary WHERE clause on the HLL table, so campaign,
 * batch and anything else are just predicates.
 *
 * THE CONTRACT THAT MUST NOT DRIFT. The INSERT carries no column list, so it
 * writes into the staging table POSITIONALLY, and the procedure is handed a
 * separate comma-joined string naming the SQL Server columns. Three things
 * therefore have to stay in lockstep: the order of SELECT_ITEMS, the order of
 * TARGET_COLUMNS, and the column order of the staging table itself. Nothing in
 * SQL will complain if they slip — the leads simply land in the wrong fields.
 * Hence one source of truth here, and a test asserting the two lists are the
 * same length.
 *
 * The SELECT aliases and the target column names DELIBERATELY disagree in
 * three places (CreatedByUserId/UpdatedByUserId, CreatedOnDate/UpdatedOnDate,
 * HLL_ID/HistoryLeadId). Because the insert is positional the aliases are
 * documentary only, and renaming them to match would be churn on a working
 * production path.
 */

export const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

/** Where the procedure lands the rows on the SQL Server side. */
export const SYNC_TARGET = "Upload.TempUpload"
export const SYNC_BATCH_SIZE = 10000
export const SYNC_PROCEDURE = "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE"

/**
 * The two date expressions that differ between callers.
 *
 * Extend Expired Leads exists to MOVE the expiry, so it writes
 * `CURRENT_DATE() + 10`. A re-push of leads that failed to arrive must not
 * silently extend anything — it sends the lead as it was loaded, so it writes
 * the stored LEADEXPIRY. Getting this wrong is invisible in the file and
 * visible only weeks later as leads living longer than they should.
 */
export type PushDates = {
  /** SQL for the LeadExpiry column. */
  leadExpiry: string
  /** SQL for the CreatedOnDate column. */
  createdOn: string
}

/** What Extend Expired Leads has always written. */
export const EXTEND_DATES: PushDates = {
  leadExpiry: "CURRENT_DATE() + 10",
  createdOn: "CURRENT_DATE()",
}

/** A re-push preserves what the lead was loaded with. */
export const REPUSH_DATES: PushDates = {
  leadExpiry: "LEADEXPIRY",
  createdOn: "CREATEDONDATE",
}

/**
 * The 39 SELECT items, in the order the staging table's columns are in.
 *
 * Transcribed from the extend route rather than rewritten — the golden test in
 * scripts/distribution/batch-check-sql-tests.ts asserts the generated SQL still
 * matches what that route produced before this extraction.
 */
export function selectItems(dates: PushDates): string[] {
  return [
    `CAST(NULL AS VARCHAR(50)) AS CustomerCode`,
    `campaignid`,
    `IDNUMBER AS IdNumber`,
    `CASE WHEN CONCAT('0', RIGHT(CELLNUMBER, 9)) = '0'
         THEN CONCAT('0', RIGHT(contactnumber1, 9))
         ELSE CONCAT('0', RIGHT(CELLNUMBER, 9))
    END AS CellNumber`,
    `CUSTOMERNAME AS CustomerName`,
    `LASTNAME AS LastName`,
    `CAST(NULL AS VARCHAR(50)) AS Tariff`,
    `DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER1) AS ContactNumber1`,
    `DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER2) AS ContactNumber2`,
    `DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER3) AS ContactNumber3`,
    `CAST(NULL AS VARCHAR(50)) AS ContactNumber4`,
    `CAST(NULL AS VARCHAR(50)) AS AvgSpend`,
    `CAST(NULL AS VARCHAR(50)) AS HandsetType`,
    `CAST(NULL AS VARCHAR(50)) AS HandsetCost`,
    `CAST(NULL AS VARCHAR(50)) AS DelAdd`,
    `EMAIL AS Email`,
    `CAST(NULL AS VARCHAR(50)) AS ContractDate`,
    `CAST(NULL AS VARCHAR(50)) AS AllocateUser`,
    `CAST(NULL AS VARCHAR(50)) AS AllocateDate`,
    `CAST(NULL AS VARCHAR(50)) AS AllocateTimeFrom`,
    `CAST(NULL AS VARCHAR(50)) AS AllocateTimeTo`,
    `${dates.leadExpiry} AS LeadExpiry`,
    `BatchName`,
    `REPLACE(EXTRADATA, ',', '') AS ExtraData`,
    `CAST(NULL AS VARCHAR(50)) AS SystemMessage`,
    `CAST(NULL AS VARCHAR(50)) AS CreatedByUserId`,
    `${dates.createdOn} AS CreatedOnDate`,
    `CAST(NULL AS VARCHAR(50)) AS Affordability`,
    `AccountNumber AS AccountNumber`,
    `2 AS LeadSystemTypeId`,
    `BranchCode AS BranchCode`,
    `Bank AS Bank`,
    `BankAccountType AS BankAccountType`,
    `CAST(NULL AS VARCHAR(50)) AS AccountFirstName`,
    `CAST(NULL AS VARCHAR(50)) AS AccountLastName`,
    `CAST(NULL AS VARCHAR(50)) AS LeadSourceId`,
    `SOURCEORDERID AS SourceOrderId`,
    `HLL_ID`,
    `CAST(NULL AS VARCHAR(50)) AS OptInStatus`,
  ]
}

/** The SQL Server column names, in the SAME ORDER as selectItems(). */
export const TARGET_COLUMNS = [
  "CustomerCode", "CampaignId", "IdNumber", "CellNumber", "CustomerName",
  "LastName", "Tariff", "ContactNumber1", "ContactNumber2", "ContactNumber3",
  "ContactNumber4", "AvgSpend", "HandsetType", "HandsetCost", "DelAdd",
  "Email", "ContractDate", "AllocateUser", "AllocateDate", "AllocateTimeFrom",
  "AllocateTimeTo", "LeadExpiry", "BatchName", "ExtraData", "SystemMessage",
  "UpdatedByUserId", "UpdatedOnDate", "Affordability", "AccountNumber",
  "LeadSystemTypeId", "BranchCode", "Bank", "BankAccountType",
  "AccountFirstName", "AccountLastName", "LeadSourceId", "SourceOrderId",
  "HistoryLeadId", "OptInStatus",
] as const

/** What the procedure's third argument is, built from the list above. */
export function syncColumnsArg(): string {
  return TARGET_COLUMNS.join(",")
}

/**
 * Stage the rows a push will send.
 *
 * `where` and `qualify` are the caller's — every value inside them must already
 * be validated or escaped, because they are interpolated whole. Extend passes
 * an id list; the batch check passes a campaign, batch names and a NOT EXISTS.
 */
export function buildStagingInsert(input: {
  stagingTable: string
  where: string
  qualify: string
  dates: PushDates
}): string {
  return `
INSERT INTO ${input.stagingTable}
SELECT * FROM (
  SELECT
    ${selectItems(input.dates).join(",\n    ")}
  FROM ${HLL_TABLE} s
  WHERE ${input.where}
  ${input.qualify}
)
`
}

export function buildSyncCall(stagingTable: string): string {
  return `
    CALL ${SYNC_PROCEDURE}(
      '${stagingTable}',
      '${SYNC_TARGET}',
      '${syncColumnsArg()}',
      ${SYNC_BATCH_SIZE}
    )
  `
}

export type PushStep = { name: string; ok: boolean; rowCount?: number; error?: string }

/**
 * Truncate, insert, call — stopping at the first failure.
 *
 * Never throws: it returns the step list so the caller can report exactly how
 * far the push got. Stopping matters, because a truncate that worked followed
 * by an insert that failed leaves the staging table empty, and calling the
 * procedure then would push nothing while reporting success.
 */
export async function pushToSilverSurfer(input: {
  stagingTable: string
  where: string
  qualify: string
  dates: PushDates
}): Promise<{ ok: boolean; steps: PushStep[]; inserted: number; syncResult: Record<string, unknown>[] }> {
  const steps: PushStep[] = []
  const APP_SF = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }

  try {
    await executeSnowflakeQuery(`TRUNCATE TABLE ${input.stagingTable}`, APP_SF)
    steps.push({ name: "truncate", ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "truncate", ok: false, error: message })
    return { ok: false, steps, inserted: 0, syncResult: [] }
  }

  let inserted = 0
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      buildStagingInsert(input),
      APP_SF
    )
    // Snowflake returns DML as one row whose single column counts the writes.
    if (rows.length > 0) {
      const v = Object.values(rows[0])[0]
      inserted = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0
    }
    steps.push({ name: "insert", ok: true, rowCount: inserted })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "insert", ok: false, error: message })
    return { ok: false, steps, inserted: 0, syncResult: [] }
  }

  // Nothing staged means nothing to send. Calling the procedure with an empty
  // source would succeed and read as a completed push.
  if (inserted === 0) {
    steps.push({ name: "syncToSqlServer", ok: true, rowCount: 0 })
    return { ok: true, steps, inserted: 0, syncResult: [] }
  }

  let syncResult: Record<string, unknown>[] = []
  try {
    syncResult = await executeSnowflakeQuery<Record<string, unknown>>(
      buildSyncCall(input.stagingTable),
      { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_AUTOMATION" }
    )
    steps.push({ name: "syncToSqlServer", ok: true, rowCount: syncResult.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: "syncToSqlServer", ok: false, error: message })
    return { ok: false, steps, inserted, syncResult: [] }
  }

  return { ok: true, steps, inserted, syncResult }
}
