/**
 * Offline tests for the SilverSurfer push and the batch reconciliation.
 *
 *   npx tsx scripts/distribution/batch-check-sql-tests.ts
 *
 * No warehouse, no SQL Server, no writes. Two things are covered, and both
 * would fail silently in production rather than loudly:
 *
 *  1. THE 39-COLUMN POSITIONAL CONTRACT. The staging INSERT carries no column
 *     list, so it writes by position, and the procedure is handed a separate
 *     string naming the SQL Server columns. If those two orders ever diverge,
 *     leads land in the wrong fields and nothing errors.
 *
 *  2. THE GOLDEN TEST. Extend Expired Leads was a working production path
 *     before its SQL moved into lib/silversurfer-push.ts. Its generated
 *     statement has to still say the same thing, or the extraction broke
 *     something no test would otherwise notice.
 */
import {
  EXTEND_DATES,
  REPUSH_DATES,
  TARGET_COLUMNS,
  buildStagingInsert,
  buildSyncCall,
  selectItems,
  syncColumnsArg,
} from "../../lib/silversurfer-push"
import {
  MAX_BATCHES,
  MAX_BATCH_NAME,
  assertPicks,
  buildDryRun,
  buildFreshness,
  buildSummary,
  lit,
  missingWhere,
} from "../../lib/batch-check-sql"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

/* ---- 1. The positional contract ---------------------------------------- */

console.log("the 39-column contract")
{
  const items = selectItems(EXTEND_DATES)
  check("39 SELECT items", items.length === 39, String(items.length))
  check("39 target columns", TARGET_COLUMNS.length === 39, String(TARGET_COLUMNS.length))
  // The invariant that matters: same length, so position N of one lines up
  // with position N of the other. Nothing in SQL checks this.
  check(
    "the two lists are the same length",
    items.length === TARGET_COLUMNS.length,
    `${items.length} vs ${TARGET_COLUMNS.length}`
  )
  check(
    "the procedure argument is built from that one list",
    syncColumnsArg().split(",").length === TARGET_COLUMNS.length
  )
  check("no target column is blank", TARGET_COLUMNS.every((c) => /^[A-Za-z][A-Za-z0-9_]*$/.test(c)))
  check("no duplicate target columns", new Set(TARGET_COLUMNS).size === TARGET_COLUMNS.length)
  // The three deliberate alias/column disagreements are documentary; assert
  // they are still where they were so a "tidy-up" cannot quietly reorder.
  check("position 26 is UpdatedByUserId", TARGET_COLUMNS[25] === "UpdatedByUserId")
  check("position 27 is UpdatedOnDate", TARGET_COLUMNS[26] === "UpdatedOnDate")
  check("position 38 is HistoryLeadId", TARGET_COLUMNS[37] === "HistoryLeadId")
  check("BatchName is position 23", TARGET_COLUMNS[22] === "BatchName")
}

/* ---- 2. The golden test: extend must be unchanged ---------------------- */

console.log("\nExtend Expired Leads — unchanged by the extraction")
{
  /**
   * Captured from app/api/leads/extend/run/route.ts as it stood at ab2b593,
   * before its SQL moved into lib/silversurfer-push.ts. Placeholders stand in
   * for the interpolated id list and campaign id.
   */
  const BEFORE = `
INSERT INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS
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
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED s
  WHERE idnumber IN (@IDS@)
    AND campaignid = @CID@
    AND (estatus IS NULL OR UPPER(TRIM(estatus)) IN ('SALE', 'SALE MADE'))
  QUALIFY ROW_NUMBER() OVER (PARTITION BY idnumber ORDER BY CREATEDONDATE DESC) = 1
)
`
  const now = buildStagingInsert({
    stagingTable: "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS",
    where:
      `idnumber IN (@IDS@)\n` +
      `    AND campaignid = @CID@\n` +
      `    AND (estatus IS NULL OR UPPER(TRIM(estatus)) IN ('SALE', 'SALE MADE'))`,
    qualify: "QUALIFY ROW_NUMBER() OVER (PARTITION BY idnumber ORDER BY CREATEDONDATE DESC) = 1",
    dates: EXTEND_DATES,
  })
  check("the generated INSERT still matches what shipped", norm(now) === norm(BEFORE),
    norm(now) === norm(BEFORE) ? "" : "the extraction changed a production statement")

  const call = buildSyncCall("DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS")
  check("the CALL names the staging table", call.includes("'DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS'"))
  check("the CALL targets Upload.TempUpload", call.includes("'Upload.TempUpload'"))
  check("the CALL keeps the 10000 batch size", call.includes("10000"))
  check(
    "the CALL's column string is the one from TARGET_COLUMNS",
    call.includes(`'${TARGET_COLUMNS.join(",")}'`)
  )
}

/* ---- 3. A re-push must not move the expiry ----------------------------- */

console.log("\nREPUSH_DATES — a re-push sends the lead as it was loaded")
{
  const extend = buildStagingInsert({
    stagingTable: "T", where: "1=1", qualify: "", dates: EXTEND_DATES,
  })
  const repush = buildStagingInsert({
    stagingTable: "T", where: "1=1", qualify: "", dates: REPUSH_DATES,
  })
  // Extend exists to MOVE the expiry. A re-push of leads that failed to arrive
  // must not silently extend anything — that would be invisible in the file
  // and visible weeks later as leads outliving their batch.
  check("extend writes today + 10", extend.includes("CURRENT_DATE() + 10 AS LeadExpiry"))
  check("a re-push writes the stored expiry", repush.includes("LEADEXPIRY AS LeadExpiry"))
  check("and does not extend it", !repush.includes("CURRENT_DATE() + 10"))
  check("extend stamps today as created", extend.includes("CURRENT_DATE() AS CreatedOnDate"))
  check("a re-push keeps the original load date", repush.includes("CREATEDONDATE AS CreatedOnDate"))
  // Everything else must be identical between the two.
  const strip = (s: string) =>
    norm(s).replace(/CURRENT_DATE\(\) \+ 10|LEADEXPIRY(?= AS LeadExpiry)|CURRENT_DATE\(\)|CREATEDONDATE(?= AS CreatedOnDate)/g, "@D@")
  check("nothing else differs between the two", strip(extend) === strip(repush))
}

/* ---- 4. The reconciliation SQL ----------------------------------------- */

const scope = { campaignId: 11381, from: "2026-09-01", to: "2026-09-30" }
const rejects = (fn: () => unknown) => {
  try { fn(); return false } catch { return true }
}

console.log("\nlit — the injection boundary for batch names")
{
  check("wraps in quotes", lit("BATCH_A") === "'BATCH_A'")
  check("doubles a quote", lit("BATCH_O'BRIEN") === "'BATCH_O''BRIEN'", lit("BATCH_O'BRIEN"))
  check("neutralises a payload", lit("x' OR 1=1 --") === "'x'' OR 1=1 --'")
}

const pick = (campaignId: number, batchName: string) => ({ campaignId, batchName })

console.log("\nassertPicks")
{
  check("accepts picks", assertPicks([pick(1, "A"), pick(1, "B")]).length === 2)
  check("trims the name", assertPicks([pick(1, " A ")])[0].batchName === "A")
  // A batch name is only unique WITHIN a campaign, so the same name under two
  // campaigns is two distinct picks — collapsing them would drop a real batch.
  check("keeps the same name under two campaigns", assertPicks([pick(1, "A"), pick(2, "A")]).length === 2)
  check("dedupes an exact repeat", assertPicks([pick(1, "A"), pick(1, "A")]).length === 1)
  check("refuses an empty list", rejects(() => assertPicks([])))
  check("refuses a non-array", rejects(() => assertPicks("A")))
  check("refuses a bad campaign id", rejects(() => assertPicks([pick(NaN, "A")])))
  check("refuses a negative campaign id", rejects(() => assertPicks([pick(-1, "A")])))
  check(`refuses more than ${MAX_BATCHES}`, rejects(() => assertPicks(Array.from({ length: MAX_BATCHES + 1 }, (_, i) => pick(1, `B${i}`)))))
  check("refuses an over-long name", rejects(() => assertPicks([pick(1, "x".repeat(MAX_BATCH_NAME + 1))])))
}

console.log("\nbuildSummary")
{
  const sql = buildSummary(scope)
  check("filters the campaign when given one", sql.includes("CAMPAIGNID = 11381"))
  check("groups by campaign and batch", sql.includes("GROUP BY CAMPAIGNID, BATCHNAME"))
  check("selects the campaign", sql.includes("SELECT h.CAMPAIGNID"))
  // The whole point of the screen: no campaign means every campaign.
  const all = buildSummary({ ...scope, campaignId: null })
  // A campaign PREDICATE is `CAMPAIGNID = <number>`; the joins compare two
  // columns, so match only the literal form.
  check("omits the campaign filter when null", !/CAMPAIGNID = \d/.test(all))
  check("but still scopes the dates", all.includes("BETWEEN '2026-09-01' AND '2026-09-30'"))
  check("and still groups by campaign", all.includes("GROUP BY CAMPAIGNID, BATCHNAME"))
  check("joins missing on campaign AND batch", all.includes("h.CAMPAIGNID = m.CAMPAIGNID AND h.BATCHNAME = m.BATCHNAME"))
  check("uses the date range as literals", sql.includes("BETWEEN '2026-09-01' AND '2026-09-30'"))
  check("keeps the ESTATUS filter", sql.includes("ESTATUS IS NULL"))
  // COUNT(*) on the fanned-out join would over-count and make a short batch
  // read as complete.
  check("counts SilverSurfer leads distinctly", sql.includes("COUNT(DISTINCT s.LEADCUSTOMERID)"))
  check("reports the shortfall", sql.includes("AS SHORTFALL"))
  check("reports what a push would actually send", sql.includes("AS MISSING_BY_BATCH"))
  check("also reports who is new to the CRM", sql.includes("AS NEW_TO_CRM"))
  // Batch AND id. Matching on id alone understated eight fully-missing
  // batches by ~80%, because their people existed under earlier batch names.
  check("the missing CTE matches on id AND batch", sql.includes("ss.IDNUMBER = h.IDNUMBER AND dd.BATCHNAME = h.BATCHNAME"))
  check("the new-to-CRM CTE still matches on id alone", sql.includes("ss.IDNUMBER = h.IDNUMBER)"))
  check("orders the worst first", sql.includes("ORDER BY MISSING_BY_BATCH DESC"))

  check("refuses a bad campaign id", rejects(() => buildSummary({ ...scope, campaignId: -1 })))
  check("accepts null as all campaigns", !rejects(() => buildSummary({ ...scope, campaignId: null })))
  check("refuses a malformed date", rejects(() => buildSummary({ ...scope, from: "01-09-2026" })))
  check("refuses SQL in a date", rejects(() => buildSummary({ ...scope, to: "2026-09-30' OR '1'='1" })))
}

console.log("\nbuildFreshness")
{
  const sql = buildFreshness()
  check("reads both sides' newest row", sql.includes("HLL_LATEST") && sql.includes("SS_LATEST"))
}

console.log("\nmissingWhere — what a push stages")
{
  const { where, qualify } = missingWhere(scope, [pick(11381, "BATCH_A"), pick(11381, "BATCH_O'BRIEN")])
  check("scopes the dates", where.includes("BETWEEN '2026-09-01' AND '2026-09-30'"))
  check("keeps ESTATUS IS NULL", where.includes("ESTATUS IS NULL"))
  check("pairs the campaign with its batches", where.includes("(CAMPAIGNID = 11381 AND BATCHNAME IN ('BATCH_A', 'BATCH_O''BRIEN'))"), where)
  check("excludes leads already in SilverSurfer", where.includes("NOT EXISTS"))
  check("the subquery alias does not shadow the outer one", where.includes("ss.IDNUMBER = s.IDNUMBER"))
  // The whole point of the change: a batch absent from SilverSurfer sends whole.
  check("the push matches on id AND batch", where.includes("dd.BATCHNAME = s.BATCHNAME"))
  check("dedupes by IDNUMBER", qualify.includes("PARTITION BY IDNUMBER"))
  check("refuses no picks", rejects(() => missingWhere(scope, [])))

  // Batches from several campaigns in ONE push. Relying on batch names alone
  // would let a name reused elsewhere silently widen a write to a live CRM.
  const multi = missingWhere(scope, [pick(1, "A"), pick(2, "B"), pick(1, "C")])
  check("one OR-group per campaign", multi.where.includes("(CAMPAIGNID = 1 AND BATCHNAME IN ('A', 'C'))"), multi.where)
  check("and the second campaign too", multi.where.includes("(CAMPAIGNID = 2 AND BATCHNAME IN ('B'))"))
  check("joined with OR", multi.where.includes("OR "))
  check("returns the cleaned picks", multi.picks.length === 3)
  // The scope's own campaign must not also be applied — the picks carry theirs,
  // and both would return nothing whenever they disagreed.
  const scoped = missingWhere({ ...scope, campaignId: 99999 }, [pick(1, "A")])
  check("the scope's campaign is not applied on top", !scoped.where.includes("CAMPAIGNID = 99999"))

  const staged = buildStagingInsert({
    stagingTable: "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_BATCH_RECHECK_LEADS",
    where, qualify, dates: REPUSH_DATES,
  })
  check("the staged INSERT names the recheck table", staged.includes("TM_BATCH_RECHECK_LEADS"))
  check("carries the batch filter", staged.includes("BATCH_O''BRIEN"))
  check("carries the NOT EXISTS", staged.includes("NOT EXISTS"))
  check("still emits 39 columns", selectItems(REPUSH_DATES).length === 39)
  check("and preserves the stored expiry", staged.includes("LEADEXPIRY AS LeadExpiry"))
}

console.log("\nbuildDryRun")
{
  const sql = buildDryRun(scope, [pick(11381, "BATCH_A")])
  check("counts rather than writes", /^\s*SELECT COUNT\(\*\)/m.test(sql))
  check("has no INSERT", !/INSERT/i.test(sql))
  check("has no CALL", !/\bCALL\b/i.test(sql))
  check("has no TRUNCATE", !/TRUNCATE/i.test(sql))
  check("uses the same filter as the push", sql.includes("(CAMPAIGNID = 11381 AND BATCHNAME IN ('BATCH_A'))"))
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
