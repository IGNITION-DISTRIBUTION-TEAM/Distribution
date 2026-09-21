/* =============================================================================
   The Dialler report's new source — FACT_YAXXA_DIALLER
   -----------------------------------------------------------------------------
   Section 1 is GRANTS and needs ACCOUNTADMIN. Everything else is read-only.

   The report moved off DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS, which
   was pre-aggregated, onto DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER, one
   row per call. What that buys:

     * CAMP_ID. The old view had only CAMPAIGN_NAME, so the campaign mapping had
       to translate a selection into Yaxxa NAMES and compare strings. CAMP_ID is
       what TSK_CAMPAIGN_DIALLER_MAP is keyed on, so the join is now an id join
       and the name matching is gone entirely.
     * SCORE / SCOREGROUP that are actually populated. On the old view they were
       empty, and the score grid rendered every lead in one "(none)" band.
     * A row per call, so calls, customers (RSA_ID) and outcomes can be counted
       rather than summing a pre-computed LEADS measure.
     * Timings, so connect rate, abandon rate and time-to-answer exist at all.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — grants. ACCOUNTADMIN. Safe to re-run.

   USAGE ON THE SCHEMA MATTERS AS MUCH AS SELECT: without it every object inside
   is invisible however it is granted, and Snowflake reports that identically to
   the object not existing. A Dialler report that says the table does not exist
   is usually this.
-------------------------------------------------------------------------------- */

GRANT USAGE  ON DATABASE DATAWAREHOUSE                    TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE  ON SCHEMA   DATAWAREHOUSE.CX_PRODUCTION      TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE    DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
  TO ROLE SVC_VERCEL_APP_ROLE;
-- If FACT_YAXXA_DIALLER is a VIEW rather than a table the grant above fails;
-- use GRANT SELECT ON VIEW instead. Section 2 tells you which it is.


/* -----------------------------------------------------------------------------
   SECTION 2 — is it a table or a view, and what does it hold?
-------------------------------------------------------------------------------- */

SELECT TABLE_TYPE, ROW_COUNT, BYTES, CREATED, LAST_ALTERED
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = 'CX_PRODUCTION' AND TABLE_NAME = 'FACT_YAXXA_DIALLER';

SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'CX_PRODUCTION' AND TABLE_NAME = 'FACT_YAXXA_DIALLER'
 ORDER BY ORDINAL_POSITION;


/* -----------------------------------------------------------------------------
   SECTION 3 — IS CALL_START_TIME UTC OR LOCAL?

   THE ONE CHECK THAT DECIDES A VISIBLE NUMBER. The report shifts it +2 hours
   for SAST, inherited from the old view, which shifted VW_DIALLER_STATS the
   same way. But CALL_DATE exists alongside CALL_START_TIME, which is what a
   source that has already localised looks like — so the inherited shift may be
   double-counting and put the intraday chart two hours out.

   Dialling runs roughly 08:00–17:00 local. Whichever column puts the peak
   inside that window is the correct one.

   If RAW is right, set SAST_SHIFT_HOURS to 0 in lib/dialler-fact.ts.
-------------------------------------------------------------------------------- */

SELECT TO_CHAR(TIME_SLICE(CALL_START_TIME, 60, 'MINUTE'), 'HH24:MI')                  AS RAW_HOUR,
       TO_CHAR(TIME_SLICE(TIMEADD(HOUR, 2, CALL_START_TIME), 60, 'MINUTE'), 'HH24:MI') AS SHIFTED_HOUR,
       COUNT(*)                                                                        AS CALLS
  FROM DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
 WHERE TENANT_ID = 1002
   AND CAST(CALL_DATE AS DATE) >= DATEADD(DAY, -7, CURRENT_DATE())
 GROUP BY 1, 2
 ORDER BY CALLS DESC
 LIMIT 10;


/* -----------------------------------------------------------------------------
   SECTION 4 — how much does the deduplication remove?

   The table is reloaded, so a CALL_ID appears once per load and only the latest
   row counts. Every query in the app applies

       QUALIFY ROW_NUMBER() OVER (PARTITION BY CALL_ID ORDER BY LOAD_DATE DESC) = 1

   Without it a re-loaded day counts twice and NOTHING ON SCREEN LOOKS WRONG.
   This measures the gap so the size of that error is known rather than assumed.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                  AS RAW_ROWS,
       COUNT(DISTINCT CALL_ID)   AS DISTINCT_CALLS,
       COUNT(*) - COUNT(DISTINCT CALL_ID) AS SUPERSEDED_ROWS,
       ROUND(100 * (COUNT(*) - COUNT(DISTINCT CALL_ID)) / NULLIF(COUNT(*), 0), 2) AS PCT_DUPLICATE
  FROM DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
 WHERE CAST(CALL_DATE AS DATE) >= DATEADD(MONTH, -3, CURRENT_DATE());


/* -----------------------------------------------------------------------------
   SECTION 5 — do the mapped campaigns actually appear here?

   The report joins CAMP_ID to TSK_CAMPAIGN_DIALLER_MAP.YAXXA_CAMPAIGNID. If the
   mapping holds ids that never appear in this table, the report is empty for a
   reason that has nothing to do with dialling — and an empty report looks
   identical to a quiet day.
-------------------------------------------------------------------------------- */

WITH calls AS (
    SELECT DISTINCT CAST(CAMP_ID AS VARCHAR) AS CAMP_ID, CAMPAIGN
      FROM DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
     WHERE TENANT_ID = 1002
       AND CAST(CALL_DATE AS DATE) >= DATEADD(MONTH, -3, CURRENT_DATE())
)
SELECT m.SS_CAMPAIGNID,
       m.SS_TITLE,
       m.YAXXA_CAMPAIGNID,
       m.YAXXA_NAME        AS MAPPED_NAME,
       c.CAMPAIGN          AS NAME_IN_FACT,
       IFF(c.CAMP_ID IS NULL, 'NO CALLS IN 3 MONTHS', 'ok') AS STATUS
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP m
  LEFT JOIN calls c ON c.CAMP_ID = m.YAXXA_CAMPAIGNID
 ORDER BY STATUS, m.SS_TITLE;


/* -----------------------------------------------------------------------------
   SECTION 6 — what the report's tiles compute, straight in SQL

   Run this and the numbers should equal the screen for the same window.

   CONNECT AND ABANDON COME FROM THE TIMINGS, NOT FROM CALL_STATUS. Nobody has
   recorded what each status value means, and the spelling does not settle it —
   "ANSWERED" could be the switch or the person, and those answer the same
   question differently. A non-null answer time is not open to interpretation.
   `> 0` as well as non-null, because a zero-second answer is the switch rather
   than a human and counting those inflates connect rate.
-------------------------------------------------------------------------------- */

WITH calls AS (
    SELECT *
      FROM DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
     WHERE TENANT_ID = 1002
       AND CAST(CALL_DATE AS DATE) BETWEEN '2026-09-01' AND '2026-09-21'
       AND CAST(CAMP_ID AS VARCHAR) IN (
             SELECT YAXXA_CAMPAIGNID
               FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CALL_ID ORDER BY LOAD_DATE DESC) = 1
)
SELECT COUNT(*)                                        AS CALLS,
       COUNT(DISTINCT RSA_ID)                          AS CUSTOMERS,
       COUNT(DISTINCT CAMP_ID)                         AS CAMPAIGNS,
       COUNT(DISTINCT CAST(CALL_DATE AS DATE))         AS DAYS,
       COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0)                AS CONNECTED,
       COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_AGENT_TIME) > 0)                   AS AGENT_CONNECTED,
       COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0
                AND NOT (DATEDIFF(second, CALL_START_TIME, CALL_AGENT_TIME) > 0))         AS ABANDONED,
       ROUND(100 * COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0) / NULLIF(COUNT(*), 0), 1) AS CONNECT_RATE,
       -- Of those who PICKED UP. An abandon rate over every dial is dominated
       -- by no-answers, which are not abandons and are not the dialler's fault.
       ROUND(100 * COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0 AND NOT (DATEDIFF(second, CALL_START_TIME, CALL_AGENT_TIME) > 0))
             / NULLIF(COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0), 0), 1)                AS ABANDON_RATE,
       AVG(IFF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0,
               DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME), NULL))             AS AVG_SECS_TO_ANSWER,
       -- Negative talk time is clock skew between two stamps, not a short call.
       AVG(IFF(DATEDIFF(second, CALL_START_TIME, CALL_AGENT_TIME) > 0
               AND CALL_HANGUP_TIME > CALL_AGENT_TIME,
               DATEDIFF(second, CALL_AGENT_TIME, CALL_HANGUP_TIME), NULL))     AS AVG_TALK_SECS,
       AVG(NULLIF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)), 0))                      AS AVG_SCORE
  FROM calls;


/* -----------------------------------------------------------------------------
   SECTION 7 — what CALL_STATUS, HANGUP_REASON and ACTION actually contain

   Send this back. Connect and abandon are derived from timings above precisely
   because these are undocumented — but once somebody says which values mean
   what, richer measures (right-party contact, machine detection, retry
   outcomes) become expressible.
-------------------------------------------------------------------------------- */

WITH calls AS (
    SELECT *
      FROM DATAWAREHOUSE.CX_PRODUCTION.FACT_YAXXA_DIALLER
     WHERE TENANT_ID = 1002
       AND CAST(CALL_DATE AS DATE) >= DATEADD(DAY, -30, CURRENT_DATE())
    QUALIFY ROW_NUMBER() OVER (PARTITION BY CALL_ID ORDER BY LOAD_DATE DESC) = 1
)
SELECT 'CALL_STATUS'   AS COLUMN_NAME, COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(blank)')   AS VALUE,
       COUNT(*) AS CALLS, COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0) AS ANSWERED
  FROM calls GROUP BY 1, 2
UNION ALL
SELECT 'HANGUP_REASON', COALESCE(NULLIF(TRIM(HANGUP_REASON), ''), '(blank)'),
       COUNT(*), COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0)
  FROM calls GROUP BY 1, 2
UNION ALL
SELECT 'ACTION', COALESCE(NULLIF(TRIM(ACTION), ''), '(blank)'),
       COUNT(*), COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0)
  FROM calls GROUP BY 1, 2
UNION ALL
SELECT 'LEAD_STATUS', COALESCE(NULLIF(TRIM(LEAD_STATUS), ''), '(blank)'),
       COUNT(*), COUNT_IF(DATEDIFF(second, CALL_START_TIME, CALL_ANSWER_TIME) > 0)
  FROM calls GROUP BY 1, 2
 ORDER BY COLUMN_NAME, CALLS DESC;
