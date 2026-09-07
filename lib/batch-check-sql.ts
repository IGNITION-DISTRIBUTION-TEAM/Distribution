import { HLL_TABLE } from "@/lib/silversurfer-push"

/**
 * Reconciling a batch's HLL row count against what reached SilverSurfer.
 *
 * PURE — every function here returns a SQL string and touches nothing, so the
 * whole thing is testable from literals. Which matters more than usual: the
 * output of `missingWhere` feeds a WRITE to a live CRM, and the batch names in
 * it come from a request body.
 *
 * THE MEASURE IS BATCH + ID. A lead counts as loaded only when SilverSurfer
 * holds it under THE SAME BATCH NAME. That is what makes a batch that never
 * arrived read as fully missing, and a batch that half-arrived read as short by
 * the difference.
 *
 * It is also the correction to an earlier mistake in this file. It once matched
 * on IDNUMBER alone, on the theory that a person already in the CRM should not
 * be sent again. Real data killed that: eight batches held zero rows in
 * SilverSurfer while most of their people existed there under OTHER batch
 * names, from earlier campaigns. ID-only therefore skipped ten thousand leads
 * that genuinely needed to exist under the new batch — the CRM keys work on
 * (person, batch), so the same person legitimately appears in many batches.
 *
 * WHICH SILVERSURFER. `SILVERSURFER` here, matching the reconciliation query
 * this was built from. Note that the export's own lookup
 * (lib/distribution-export.ts) reads SILVERSURFER_LEAD_HEVO instead, so the two
 * do not currently share a definition of "already in SilverSurfer". One
 * constant, so switching is one line — but it is an open question, not a
 * settled one.
 *
 * AND IT IS A COPY, NOT THE CRM. The `*_HEVO` naming across this repo says this
 * family is replicated, and a replica lags. That is why every caller of this
 * module also reports how fresh each side is, and why the push defaults to a
 * dry run: a check made minutes after a sync can report every lead as missing,
 * and "fixing" that would send a second copy of all of them.
 */

const SS_LEAD = `"DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER"`
const SS_DETAIL = `"DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMERDETAILS"`

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Longest batch name we will accept, and how many at once. */
export const MAX_BATCH_NAME = 200
export const MAX_BATCHES = 50

/**
 * Runaway guard, not a policy. A single missing batch is 13,000 leads in the
 * observed data and a full reload of everything short is around 35,000, so a
 * 20,000 ceiling refused the normal case. The confirm always states the number,
 * which is the real check.
 */
export const MAX_PUSH_ROWS = 100000

/** A SQL string literal, quotes doubled. The injection boundary for batch names. */
export const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`

/**
 * `campaignId` null means EVERY campaign.
 *
 * That is the default on the screen, and deliberately: you do not know which
 * campaign is short until you have looked, so making the campaign a required
 * filter meant checking them one at a time.
 */
export type CheckScope = { campaignId: number | null; from: string; to: string }

export function assertScope(scope: CheckScope): CheckScope {
  if (scope.campaignId !== null && (!Number.isInteger(scope.campaignId) || scope.campaignId < 0)) {
    throw new Error("campaignId must be a non-negative integer, or null for all campaigns")
  }
  for (const d of [scope.from, scope.to]) {
    if (!ISO_DATE_RE.test(d)) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(d)}`)
  }
  return scope
}

/**
 * Batch names, cleaned. Rejects rather than escapes anything odd — a name that
 * needs more than quote-doubling to be safe is a sign the list did not come
 * from the picker.
 */
export function assertBatchNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Pick at least one batch")
  }
  if (raw.length > MAX_BATCHES) {
    throw new Error(`At most ${MAX_BATCHES} batches at a time`)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    const name = String(v ?? "").trim()
    if (!name) continue
    if (name.length > MAX_BATCH_NAME) throw new Error(`Batch name too long: ${name.slice(0, 40)}…`)
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  if (out.length === 0) throw new Error("Pick at least one batch")
  return out
}

/** The HLL side's filter, shared by the summary and the push. */
function hllWhere(scope: CheckScope): string {
  const campaign = scope.campaignId === null ? "" : `CAMPAIGNID = ${scope.campaignId}\n     AND `
  return (
    `${campaign}CAST(CREATEDONDATE AS DATE) BETWEEN ${lit(scope.from)} AND ${lit(scope.to)}\n` +
    `     AND ESTATUS IS NULL`
  )
}

/**
 * Per batch: how many in HLL, how many in SilverSurfer, and how many would
 * actually be sent.
 *
 * Three numbers rather than one because they answer different questions and can
 * legitimately disagree:
 *
 *   HLL_COUNT      rows loaded for the batch
 *   SS_COUNT       distinct leads SilverSurfer has under that batch name.
 *                  COUNT(DISTINCT …) not COUNT(*): the detail join fans out if a
 *                  LeadCustomerId ever has two detail rows, and an over-count
 *                  would make a short batch read as complete.
 *   MISSING_BY_ID  rows whose IDNUMBER is nowhere in SilverSurfer at all.
 *                  THIS is what a push would send.
 *
 * SS_COUNT can exceed or undershoot MISSING_BY_ID because a lead already in the
 * CRM under an earlier batch counts as loaded here. Showing both is the honest
 * answer; picking one would hide the case where a batch looks short but every
 * person in it is already there.
 *
 * ONE KNOWN IMPRECISION. Rows are grouped by campaign AND batch, but the
 * SilverSurfer side has only the batch name to join on, so if the same batch
 * name ever appeared under two campaigns in the window, both rows would be
 * credited the same SS_COUNT and both SHORTFALLs would be wrong. MISSING_BY_ID
 * is unaffected — it is a NOT EXISTS filtered by campaign and batch — and it is
 * the number a push acts on, so the imprecision is confined to a column that is
 * advisory. Batch templates embed the date and differ per campaign, so this
 * should not arise; the campaign column makes it visible if it ever does.
 */
export function buildSummary(scope: CheckScope): string {
  assertScope(scope)
  return `
WITH hll AS (
  SELECT CAMPAIGNID, BATCHNAME, COUNT(*) AS HLL_COUNT
    FROM ${HLL_TABLE}
   WHERE ${hllWhere(scope)}
   GROUP BY CAMPAIGNID, BATCHNAME
),
ss AS (
  SELECT d.BATCHNAME, COUNT(DISTINCT s.LEADCUSTOMERID) AS SS_COUNT
    FROM ${SS_LEAD} s
    JOIN ${SS_DETAIL} d ON s.LEADCUSTOMERID = d.LEADCUSTOMERID
   WHERE d.BATCHNAME IN (SELECT BATCHNAME FROM hll)
   GROUP BY d.BATCHNAME
),
missing AS (
  -- Batch AND id: absent under THIS batch name is what "missing" means, even
  -- if the person exists in the CRM under an earlier one.
  SELECT h.CAMPAIGNID, h.BATCHNAME, COUNT(*) AS MISSING_BY_BATCH
    FROM ${HLL_TABLE} h
   WHERE ${hllWhere(scope)}
     AND NOT EXISTS (
       SELECT 1 FROM ${SS_LEAD} ss
        JOIN ${SS_DETAIL} dd ON dd.LEADCUSTOMERID = ss.LEADCUSTOMERID
       WHERE ss.IDNUMBER = h.IDNUMBER AND dd.BATCHNAME = h.BATCHNAME
     )
   GROUP BY h.CAMPAIGNID, h.BATCHNAME
),
newToCrm AS (
  -- Of the missing, how many are people the CRM has never seen at all. Purely
  -- informational, and the number that answers "are we creating duplicates?" —
  -- missing minus this is people being re-sent under a new batch, which is
  -- normal rather than a fault.
  SELECT h.CAMPAIGNID, h.BATCHNAME, COUNT(*) AS NEW_TO_CRM
    FROM ${HLL_TABLE} h
   WHERE ${hllWhere(scope)}
     AND NOT EXISTS (SELECT 1 FROM ${SS_LEAD} ss WHERE ss.IDNUMBER = h.IDNUMBER)
   GROUP BY h.CAMPAIGNID, h.BATCHNAME
)
SELECT h.CAMPAIGNID,
       h.BATCHNAME,
       h.HLL_COUNT,
       COALESCE(s.SS_COUNT, 0) AS SS_COUNT,
       h.HLL_COUNT - COALESCE(s.SS_COUNT, 0) AS SHORTFALL,
       COALESCE(m.MISSING_BY_BATCH, 0) AS MISSING_BY_BATCH,
       COALESCE(n.NEW_TO_CRM, 0) AS NEW_TO_CRM
  FROM hll h
  LEFT JOIN ss s ON h.BATCHNAME = s.BATCHNAME
  LEFT JOIN missing m ON h.CAMPAIGNID = m.CAMPAIGNID AND h.BATCHNAME = m.BATCHNAME
  LEFT JOIN newToCrm n ON h.CAMPAIGNID = n.CAMPAIGNID AND h.BATCHNAME = n.BATCHNAME
 ORDER BY MISSING_BY_BATCH DESC, h.CAMPAIGNID, h.BATCHNAME
`
}

/**
 * How current each side is.
 *
 * The single most important number on the screen, and the one the raw
 * reconciliation query does not give you: if SilverSurfer's newest row is
 * hours behind HLL's, every "missing" verdict is suspect and nothing should be
 * pushed until it catches up.
 */
export function buildFreshness(): string {
  return `
SELECT (SELECT MAX(CREATEDONDATE) FROM ${HLL_TABLE})                    AS HLL_LATEST,
       (SELECT MAX(s.CREATEDONDATE) FROM ${SS_LEAD} s)                  AS SS_LATEST
`
}

/**
 * The WHERE a push stages, matching on IDNUMBER only.
 *
 * Batch AND id. A lead is missing when SilverSurfer has no row for it under
 * THIS batch name, which is what makes a batch that never arrived send whole
 * and a batch that half-arrived send only its gap.
 *
 * The same person legitimately appears in many batches — the CRM works on
 * (person, batch) — so matching on id alone would skip leads that need to exist
 * under the new batch. Eight batches in the observed data had zero SilverSurfer
 * rows while most of their people were present from earlier campaigns.
 *
 * The QUALIFY is carried over from the extend flow: without it, a lead loaded
 * into HLL twice is pushed twice.
 */
export type BatchPick = { campaignId: number; batchName: string }

/**
 * Picks, cleaned. Rejects rather than escapes anything odd — a name that needs
 * more than quote-doubling to be safe did not come from the table.
 */
export function assertPicks(raw: unknown): BatchPick[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Pick at least one batch")
  if (raw.length > MAX_BATCHES) throw new Error(`At most ${MAX_BATCHES} batches at a time`)
  const out: BatchPick[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    const row = (v ?? {}) as Partial<BatchPick>
    const cid = Math.trunc(Number(row.campaignId))
    if (!Number.isInteger(cid) || cid < 0) throw new Error(`Bad campaign id: ${String(row.campaignId)}`)
    const name = String(row.batchName ?? "").trim()
    if (!name) continue
    if (name.length > MAX_BATCH_NAME) throw new Error(`Batch name too long: ${name.slice(0, 40)}…`)
    const key = `${cid}\u0000${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ campaignId: cid, batchName: name })
  }
  if (out.length === 0) throw new Error("Pick at least one batch")
  return out
}

/**
 * The WHERE a push stages, matching on IDNUMBER only.
 *
 * Batch AND id. A lead is missing when SilverSurfer has no row for it under
 * THIS batch name, which is what makes a batch that never arrived send whole
 * and a batch that half-arrived send only its gap.
 *
 * The same person legitimately appears in many batches — the CRM works on
 * (person, batch) — so matching on id alone would skip leads that need to exist
 * under the new batch. Eight batches in the observed data had zero SilverSurfer
 * rows while most of their people were present from earlier campaigns.
 *
 * PICKS CAN SPAN CAMPAIGNS, so the campaign is paired with its batches rather
 * than being one predicate over all of them. Batch names are campaign-specific
 * in practice, but relying on that would mean a batch name reused elsewhere
 * silently widened a write to a live CRM. One OR-group per campaign keeps it a
 * single push — one truncate, one insert, one CALL — rather than N sequential
 * ones, which would each truncate the previous one's staged rows.
 *
 * The QUALIFY is carried over from the extend flow: without it, a lead loaded
 * into HLL twice is pushed twice.
 */
export function missingWhere(
  scope: CheckScope,
  picks: unknown
): { where: string; qualify: string; picks: BatchPick[] } {
  assertScope(scope)
  const clean = assertPicks(picks)

  const byCampaign = new Map<number, string[]>()
  for (const p of clean) {
    const list = byCampaign.get(p.campaignId)
    if (list) list.push(p.batchName)
    else byCampaign.set(p.campaignId, [p.batchName])
  }
  const groups = [...byCampaign.entries()]
    .map(([cid, names]) => `(CAMPAIGNID = ${cid} AND BATCHNAME IN (${names.map(lit).join(", ")}))`)
    .join("\n          OR ")

  // The scope's own campaign filter is dropped here: the picks carry their own,
  // and keeping both would silently return nothing whenever the two disagree.
  const dateAndStatus =
    `CAST(CREATEDONDATE AS DATE) BETWEEN ${lit(scope.from)} AND ${lit(scope.to)}\n` +
    `     AND ESTATUS IS NULL`

  return {
    where:
      `${dateAndStatus}\n` +
      `     AND (${groups})\n` +
      `     AND NOT EXISTS (\n` +
      `       SELECT 1 FROM ${SS_LEAD} ss\n` +
      `        JOIN ${SS_DETAIL} dd ON dd.LEADCUSTOMERID = ss.LEADCUSTOMERID\n` +
      `       WHERE ss.IDNUMBER = s.IDNUMBER AND dd.BATCHNAME = s.BATCHNAME\n` +
      `     )`,
    qualify: "QUALIFY ROW_NUMBER() OVER (PARTITION BY IDNUMBER ORDER BY CREATEDONDATE DESC) = 1",
    picks: clean,
  }
}

/** How many rows a push would send, and a sample, without sending anything. */
export function buildDryRun(scope: CheckScope, picks: unknown): string {
  const { where } = missingWhere(scope, picks)
  return `
SELECT COUNT(*) AS MISSING, MIN(s.IDNUMBER) AS FIRST_ID, MAX(s.IDNUMBER) AS LAST_ID
  FROM ${HLL_TABLE} s
 WHERE ${where}
`
}
