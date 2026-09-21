/* =============================================================================
   Credit scores at LEAD grain — CREDITRISK, SCORE3 / SCOREGROUP3
   -----------------------------------------------------------------------------
   NOTHING IN THE APP READS THIS ANY MORE. The Dialler report was built on
   VW_DIALLER_STATS, which carried no usable score, so this view existed to
   attach CREDITRISK through the lead history. The report now reads
   DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER, which carries SCORE and
   SCOREGROUP on the call itself — so the score needs no join, no second view,
   and no second population to reconcile.

   Kept because it is still the only place that attaches SALARY, AVAILABLESPEND,
   CREDITRATIO and the risk flags (debt review, sequestration, judgements) to a
   campaign and date, none of which the call fact carries. Deploy it if a report
   needs those; the Dialler report does not.
   -----------------------------------------------------------------------------
   Sections A–D are READ-ONLY diagnostics. Section E creates a view. Section F
   is the grants, which need ACCOUNTADMIN.

   -----------------------------------------------------------------------------
   WHY THIS IS NOT A JOIN ONTO THE DIALLER VIEW

   VW_DIALLER_STATS is PRE-AGGREGATED: LEADS is a measure, and there is no ID at
   person grain. CREDITRISK is keyed on IDNO. The two cannot meet directly, and
   joining them on campaign name would multiply every lead count by the number
   of matching credit rows — inflating the whole report without erroring.

   The bridge is TM_HLL_HISTORYLEADSLOADED, which is per-lead and carries
   IDNUMBER, CAMPAIGNID and CREATEDONDATE.

   -----------------------------------------------------------------------------
   AND WHY IT IS KEYED ON THE SILVERSURFER CAMPAIGN, NOT THE YAXXA ONE

   The obvious move is to aggregate up through VW_CAMPAIGN_DIALLER_MAP so the
   result lines up with VW_DIALLER_STATS.CAMPAIGN_NAME. THAT WOULD FAN OUT. The
   mapping is one SilverSurfer campaign to MANY Yaxxa campaigns, so a campaign
   feeding three dialler campaigns would have every one of its distributed leads
   counted three times.

   There is no honest fix, because there is nothing in the HLL that says which
   Yaxxa campaign a distributed lead ended up on — that is precisely the
   information the dialler holds and the HLL does not.

   So this view is keyed on the SILVERSURFER campaign, which is what the report's
   picker selects anyway. The score panel filters on the same ids the rest of the
   page sends, and no translation is involved.

   -----------------------------------------------------------------------------
   POINT IN TIME, NOT LATEST

   CREDITRISK is snapshot history — IMPORTDATE runs from 2022 to now and one ID
   has many rows. A report about leads distributed on a date wants the credit
   position AS AT THAT DATE, not today's: the score the lead was actually worked
   on. Taking the latest snapshot would restate history every time the file is
   refreshed, and last month's report would change.

   SCORE, SCOREGROUP, SALARY and AVAILABLESPEND therefore come from the HLL,
   where the post-load procedures stamped them at distribution time. Only
   CREDITRATIO and the risk flags — which the HLL does not carry — are joined,
   and those use the latest snapshot AT OR BEFORE the load date.

   -----------------------------------------------------------------------------
   ZERO IS NOT A SCORE

   SCORE3 = 0 and SCOREGROUP3 = '0' mean UNSCORED. Averaging them in drags every
   average down. Every average below excludes them and the unscored count is
   reported separately, so the exclusion is visible rather than hidden.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION A — how many rows per IDNO, and does IMPORTDATE explain them?

   If MAX_ROWS_PER_ID is above 1 and DISTINCT_IMPORTDATES matches it, the
   duplicates are snapshot history and section E's as-of pick is right.

   If an ID has two rows with the SAME IMPORTDATE and different SCORE3, that is
   a different problem: the pick becomes arbitrary and section E needs a
   tie-break that is not in this file yet.
-------------------------------------------------------------------------------- */

SELECT MAX(ROWS_PER_ID)                       AS MAX_ROWS_PER_ID,
       MAX(DISTINCT_IMPORTDATES)              AS MAX_DISTINCT_IMPORTDATES,
       COUNT_IF(ROWS_PER_ID > DISTINCT_IMPORTDATES) AS IDS_WITH_SAME_DAY_DUPLICATES,
       COUNT(*)                               AS IDS_SAMPLED
  FROM (
        SELECT IDNO,
               COUNT(*)                  AS ROWS_PER_ID,
               COUNT(DISTINCT IMPORTDATE) AS DISTINCT_IMPORTDATES
          FROM DATAWAREHOUSE.DW_XDS.CREDITRISK
         WHERE IDNO IS NOT NULL
         GROUP BY IDNO
         LIMIT 500000
       );


/* -----------------------------------------------------------------------------
   SECTION B — is the report's SCORE already SCORE3?

   The bands VW_DIALLER_STATS renders ("1 to 601", "618 to 636", "836 to 858")
   are CREDITRISK's own banding, and sp-mtn-save-post-load.sql stamps
   SCORE = CREDITRISK.SCORE3 onto the HLL. So the report is probably showing
   SCORE3 already.

   If it is, the new panel's averages should AGREE with the Avg score tile —
   that is a check, not a duplicate. If they disagree, one of the two is reading
   something else and this says so before anybody trusts either.

   Edit the dates to a range with activity.
-------------------------------------------------------------------------------- */

-- B1. What the dialler view carries.
SELECT COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
       COUNT(*)   AS ROWS_FOUND,
       SUM(LEADS) AS LEADS,
       MIN(SCORE) AS MIN_SCORE,
       MAX(SCORE) AS MAX_SCORE
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31'
 GROUP BY 1
 ORDER BY 1;

-- B2. What CREDITRISK says for the same people, via the HLL.
--     Compares BOTH scores, so "we use SCORE3" is confirmed rather than assumed.
SELECT COUNT(*)                                   AS LEADS_MATCHED,
       COUNT_IF(TRY_TO_NUMBER(h.SCORE) = c.SCORE3) AS MATCHES_SCORE3,
       COUNT_IF(TRY_TO_NUMBER(h.SCORE) = c.SCORE)  AS MATCHES_SCORE,
       COUNT_IF(TRIM(h.SCOREGROUP) = TRIM(c.SCOREGROUP3)) AS MATCHES_SCOREGROUP3
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
  JOIN DATAWAREHOUSE.DW_XDS.CREDITRISK c
    ON c.IDNO = h.IDNUMBER
 WHERE h.CREATEDONDATE BETWEEN '2026-08-01' AND '2026-08-31'
   AND c.IMPORTDATE <= CAST(h.CREATEDONDATE AS DATE)
QUALIFY ROW_NUMBER() OVER (
          PARTITION BY h.IDNUMBER, h.CAMPAIGNID, CAST(h.CREATEDONDATE AS DATE)
          ORDER BY c.IMPORTDATE DESC) = 1;


/* -----------------------------------------------------------------------------
   SECTION C — do HLL campaigns reach the dialler, and do the counts agree?

   TWO DIFFERENT MEASURES. The HLL counts leads DISTRIBUTED. VW_DIALLER_STATS
   counts leads CALLED. They are not the same population and must never be
   added together or drawn as one series. This measures how far apart they are,
   so the report can say so in the right words.

   A campaign listed with DIALLER_LEADS of NULL has no mapping behind it — fix
   that in Dialler → Campaign mapping, not here.
-------------------------------------------------------------------------------- */

WITH HLL AS (
    SELECT CAST(h.CAMPAIGNID AS VARCHAR)   AS SS_CAMPAIGNID,
           CAST(h.CREATEDONDATE AS DATE)   AS LOAD_DATE,
           COUNT(*)                        AS DISTRIBUTED
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
     WHERE h.CREATEDONDATE BETWEEN '2026-08-01' AND '2026-08-31'
     GROUP BY 1, 2
),
MAPPED AS (
    SELECT DISTINCT SS_CAMPAIGNID, SS_TITLE, YAXXA_NAME
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP
),
DIALLED AS (
    SELECT CAMPAIGN_NAME,
           CAST(CALL_START_TIME AS DATE) AS CALL_DATE,
           SUM(LEADS)                    AS CALLED
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
     WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31'
     GROUP BY 1, 2
)
SELECT m.SS_TITLE,
       h.SS_CAMPAIGNID,
       -- COUNT(DISTINCT) because one SilverSurfer campaign feeds MANY Yaxxa
       -- campaigns; this is the fan-out factor that section E refuses to apply
       -- to lead counts.
       COUNT(DISTINCT m.YAXXA_NAME) AS YAXXA_CAMPAIGNS,
       SUM(h.DISTRIBUTED)           AS DISTRIBUTED,
       SUM(d.CALLED)                AS DIALLER_LEADS
  FROM HLL h
  LEFT JOIN MAPPED m ON m.SS_CAMPAIGNID = h.SS_CAMPAIGNID
  LEFT JOIN DIALLED d
         ON TRIM(UPPER(d.CAMPAIGN_NAME)) = TRIM(UPPER(m.YAXXA_NAME))
        AND d.CALL_DATE = h.LOAD_DATE
 GROUP BY 1, 2
 ORDER BY DISTRIBUTED DESC NULLS LAST;


/* -----------------------------------------------------------------------------
   SECTION D — how much of the Avg score tile is the zero sentinel?

   The report runs a bare AVG(SCORE). If a meaningful share of rows carry
   SCORE = 0 meaning UNSCORED, that tile is understated today and has been all
   along. AVG_EXCLUDING_ZERO is what it should read.

   If ZERO_ROWS is 0, the dialler view already filters them and the app change
   for this is unnecessary — say so and it gets dropped.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                  AS ROWS_FOUND,
       COUNT_IF(SCORE = 0 OR SCORE IS NULL)      AS ZERO_OR_NULL_ROWS,
       ROUND(100 * COUNT_IF(SCORE = 0 OR SCORE IS NULL) / NULLIF(COUNT(*), 0), 1)
                                                 AS PCT_UNSCORED,
       AVG(SCORE)                                AS AVG_AS_REPORTED_TODAY,
       AVG(IFF(SCORE > 0, SCORE, NULL))          AS AVG_EXCLUDING_ZERO
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31';


/* -----------------------------------------------------------------------------
   SECTION E — the view the report reads

   Grain: SilverSurfer campaign + load date + score band. One row per
   combination, so the report can filter it with the SAME campaign ids the
   picker already sends and sum it without any risk of fanning out.

   COPY GRANTS because CREATE OR REPLACE VIEW without it silently revokes
   everything granted on the previous version.

   POPIA: no IDNUMBER, no names, no contact details. Aggregate only, like the
   other reporting views.

   THE 13-MONTH WINDOW is not tidying. Without it the HLL side of this view is
   every lead ever distributed, and the CREDITRISK join is evaluated against all
   of it before any date predicate from the report narrows it down.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_CREDIT_SCORES
COPY GRANTS AS
WITH LEADS AS (
    SELECT h.IDNUMBER,
           CAST(h.CAMPAIGNID AS VARCHAR)   AS SS_CAMPAIGNID,
           CAST(h.CREATEDONDATE AS DATE)   AS LOAD_DATE,
           -- From the HLL, stamped at distribution time by the post-load
           -- procedures. NOT re-read from CREDITRISK: these are the values the
           -- lead was actually worked on, and today's snapshot would restate
           -- last month's report.
           TRY_TO_NUMBER(h.SCORE)          AS SCORE3,
           NULLIF(TRIM(h.SCOREGROUP), '')  AS SCOREGROUP3_HLL,
           TRY_TO_NUMBER(h.SALARY)         AS SALARY,
           TRY_TO_NUMBER(h.AVAILABLESPEND) AS AVAILABLESPEND
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
     WHERE h.CREATEDONDATE >= DATEADD(MONTH, -13, CURRENT_DATE())
       AND h.IDNUMBER IS NOT NULL
),
/* The credit position AS AT the load date — the latest snapshot at or before
   it. A lead distributed before its first CREDITRISK snapshot matches nothing
   and keeps NULL flags; it is counted in LEADS and in NO_CREDIT_SNAPSHOT, never
   silently dropped. */
CREDIT AS (
    SELECT l.IDNUMBER,
           l.SS_CAMPAIGNID,
           l.LOAD_DATE,
           c.SCOREGROUP3,
           c.CREDITRATIO,
           c.DEBTREVIEW,
           c.SEQUESTRATION,
           c.ADMINORDER,
           c.DECEASEDSTATUS,
           c.JUDGEMENTLAST12MONTHS,
           c.DEFAULTSLAST12MONTHS,
           c.CREDITINFOMATIONAVAILABLE
      FROM LEADS l
      JOIN DATAWAREHOUSE.DW_XDS.CREDITRISK c
        ON c.IDNO = l.IDNUMBER
       AND c.IMPORTDATE <= l.LOAD_DATE
    QUALIFY ROW_NUMBER() OVER (
              PARTITION BY l.IDNUMBER, l.SS_CAMPAIGNID, l.LOAD_DATE
              ORDER BY c.IMPORTDATE DESC) = 1
)
SELECT l.SS_CAMPAIGNID,
       l.LOAD_DATE,

       /* THE BAND, IN ORDER OF PREFERENCE. SCOREGROUP is not always populated
          on the HLL — scripts/dialler-stats.sql section 6b notes it is empty
          there often enough that the Distributed report already derives a band
          instead — and without a fallback every lead would land in '(none)' and
          the whole breakdown would be one row.

          CREDITRISK's own SCOREGROUP3 comes SECOND rather than the derived
          band, so the banding scheme stays consistent ("650 to 661") wherever
          it possibly can. The 50-point derivation is last because it is a
          DIFFERENT scheme, and mixing two of them in one column is only worth
          it against the alternative of no band at all. It is the same
          expression app/api/dashboard/leads-loaded/route.ts:146 uses, so the
          two reports band a lead identically. */
       COALESCE(
         l.SCOREGROUP3_HLL,
         NULLIF(TRIM(c.SCOREGROUP3), ''),
         CASE
           WHEN l.SCORE3 IS NULL OR l.SCORE3 <= 0 THEN NULL
           WHEN l.SCORE3 < 600  THEN '0-599'
           WHEN l.SCORE3 >= 900 THEN '900+'
           ELSE TO_VARCHAR(FLOOR(l.SCORE3 / 50) * 50) || '-'
             || TO_VARCHAR(FLOOR(l.SCORE3 / 50) * 50 + 49)
         END,
         '(none)'
       ) AS SCOREGROUP3,

       COUNT(*)                                   AS LEADS,
       -- Zero means UNSCORED. Counted, never averaged.
       COUNT_IF(l.SCORE3 > 0)                     AS SCORED_LEADS,
       COUNT_IF(NVL(l.SCORE3, 0) = 0)             AS UNSCORED_LEADS,
       COUNT_IF(c.IDNUMBER IS NULL)               AS NO_CREDIT_SNAPSHOT,

       /* SUMS AND COUNTS AS WELL AS AVERAGES, because AVERAGES DO NOT
          RE-AGGREGATE. Anything reading this view by campaign or by date is
          combining bands, and averaging a column of averages weights a band of
          9 leads the same as one of 9,000. The sums make that rollup exact.
          Each measure carries its OWN count: salary is present on a different
          set of leads from score, so one shared denominator would be wrong for
          at least one of them. */
       SUM(IFF(l.SCORE3 > 0, l.SCORE3, NULL))     AS SUM_SCORE3,
       AVG(IFF(l.SCORE3 > 0, l.SCORE3, NULL))     AS AVG_SCORE3,

       SUM(IFF(l.SALARY > 0, l.SALARY, NULL))     AS SUM_SALARY,
       COUNT_IF(l.SALARY > 0)                     AS SALARY_LEADS,
       AVG(IFF(l.SALARY > 0, l.SALARY, NULL))     AS AVG_SALARY,

       SUM(IFF(l.AVAILABLESPEND > 0, l.AVAILABLESPEND, NULL)) AS SUM_AVAILABLE_SPEND,
       COUNT_IF(l.AVAILABLESPEND > 0)             AS AVAILABLE_SPEND_LEADS,
       AVG(IFF(l.AVAILABLESPEND > 0, l.AVAILABLESPEND, NULL)) AS AVG_AVAILABLE_SPEND,

       SUM(IFF(TRY_TO_DOUBLE(c.CREDITRATIO) > 0,
               TRY_TO_DOUBLE(c.CREDITRATIO), NULL)) AS SUM_CREDIT_RATIO,
       COUNT_IF(TRY_TO_DOUBLE(c.CREDITRATIO) > 0)   AS CREDIT_RATIO_LEADS,
       AVG(IFF(TRY_TO_DOUBLE(c.CREDITRATIO) > 0,
               TRY_TO_DOUBLE(c.CREDITRATIO), NULL)) AS AVG_CREDIT_RATIO,

       -- Flags are 'Y'/'N' text. Counted as leads, so they add up against LEADS
       -- on the same row rather than needing a second denominator.
       COUNT_IF(c.DEBTREVIEW = 'Y')               AS DEBT_REVIEW,
       COUNT_IF(c.SEQUESTRATION = 'Y')            AS SEQUESTRATION,
       COUNT_IF(c.ADMINORDER = 'Y')               AS ADMIN_ORDER,
       COUNT_IF(c.DECEASEDSTATUS = 'Y')           AS DECEASED,
       COUNT_IF(c.JUDGEMENTLAST12MONTHS = 'Y')    AS JUDGEMENT_12M,
       COUNT_IF(c.DEFAULTSLAST12MONTHS = 'Y')     AS DEFAULTS_12M,
       COUNT_IF(c.CREDITINFOMATIONAVAILABLE = 'N') AS NO_CREDIT_INFO
  FROM LEADS l
  LEFT JOIN CREDIT c
         ON c.IDNUMBER     = l.IDNUMBER
        AND c.SS_CAMPAIGNID = l.SS_CAMPAIGNID
        AND c.LOAD_DATE    = l.LOAD_DATE
 GROUP BY 1, 2, 3;


/* -----------------------------------------------------------------------------
   SECTION F — grants. ACCOUNTADMIN. Safe to re-run.

   The app has never read CREDITRISK, so USAGE on DW_XDS is as necessary as the
   SELECT: without it every object inside is invisible, and Snowflake reports
   that identically to the object not existing.
-------------------------------------------------------------------------------- */

GRANT USAGE  ON SCHEMA DATAWAREHOUSE.DW_XDS                            TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE  DATAWAREHOUSE.DW_XDS.CREDITRISK                 TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW   DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_CREDIT_SCORES
                                                                       TO ROLE SVC_VERCEL_APP_ROLE;

-- Confirm. Anything missing here is why the panel says it cannot read the view.
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;
