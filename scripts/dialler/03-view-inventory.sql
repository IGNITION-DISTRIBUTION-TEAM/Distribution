/* =============================================================================
   What VW_DIALLER_STATS actually carries
   -----------------------------------------------------------------------------
   Entirely READ-ONLY. Run top to bottom; send back B and D.

   WHY THIS FILE EXISTS. Nothing in this repo creates
   DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS — it is built elsewhere —
   so the only thing the app can prove is which columns it READS. Those seven
   are listed below, and every one of them is already on the report. So "what
   other stats could we show" is a question about columns this app has never
   touched, and only the warehouse can answer it.

   -----------------------------------------------------------------------------
   WHAT THE REPORT ALREADY USES

     CAMPAIGN_NAME      the campaign filter (translated from the SilverSurfer
                        picker through TSK_CAMPAIGN_DIALLER_MAP) and the
                        per-campaign table
     CALL_START_TIME    date filter, multi-day buckets, the Days tile
     TIME_BUCKET_30MIN  the half-hour chart and its forecast, shifted +2h SAST
     LEADS              every measure on the page. A MEASURE, NOT A ROW COUNT —
                        everything is SUM(LEADS); COUNT(*) is a different number
                        and is shown separately as "Rows"
     CALL_STATUS        the status filter and the status table
     SCORE              the Avg score tile — EMPTY IN PRACTICE
     SCOREGROUP         the score grid — EMPTY IN PRACTICE, confirmed on screen:
                        148,390 leads, all of them in a single "(none)" band

   Anything section B lists that is NOT in that list is a stat the report could
   show today and does not.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION A — the definition

   The one that says what the view reads UPSTREAM, and therefore what exists in
   the source but is not exposed here. If a column you want is missing from
   section B, this is where you find out whether it is one line of DDL away.

   GET_DDL needs more than SELECT on the view. If A1 fails on privileges, A2
   returns the same text from INFORMATION_SCHEMA and is visible to any role that
   can see the view at all.
-------------------------------------------------------------------------------- */

-- A1.
SELECT GET_DDL('VIEW', 'DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS') AS DDL;

-- A2. Fallback.
SELECT TABLE_NAME, VIEW_DEFINITION
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.VIEWS
 WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION'
   AND TABLE_NAME   = 'VW_DIALLER_STATS';


/* -----------------------------------------------------------------------------
   SECTION B — every column

   THIS IS THE SECTION THAT ANSWERS THE QUESTION. Compare it against the seven
   in the header: the difference is the list of candidates.

   Send this back as-is. Column NAMES are enough to decide what is worth
   showing; section C is what decides whether any of them actually hold data.
-------------------------------------------------------------------------------- */

SELECT ORDINAL_POSITION,
       COLUMN_NAME,
       DATA_TYPE,
       IS_NULLABLE,
       CHARACTER_MAXIMUM_LENGTH,
       NUMERIC_PRECISION,
       NUMERIC_SCALE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION'
   AND TABLE_NAME   = 'VW_DIALLER_STATS'
 ORDER BY ORDINAL_POSITION;

-- B2. If that returns nothing, the role cannot see the view and everything
--     below will be empty too. That is a grants problem, not an empty view —
--     Snowflake reports "no privilege" identically to "does not exist".
SELECT CURRENT_ROLE() AS ROLE_IN_USE, CURRENT_WAREHOUSE() AS WAREHOUSE_IN_USE;


/* -----------------------------------------------------------------------------
   SECTION C — does a column actually hold anything?

   THE TRAP THIS CATCHES. A column present in section B looks like a stat. SCORE
   and SCOREGROUP are both present, both typed, and both empty — the report has
   been rendering an Avg score tile and a score-group grid off them for months,
   and the grid shows every lead in one "(none)" row because of it.

   So profile a column BEFORE designing a panel around it.

   C1 profiles the seven known columns. For anything new from section B, paste
   its name into C2 and run that.
-------------------------------------------------------------------------------- */

-- C1. The known seven. Adjust the dates to a window with real activity.
SELECT COUNT(*)                                          AS ROWS_FOUND,
       SUM(LEADS)                                        AS TOTAL_LEADS,

       COUNT_IF(CAMPAIGN_NAME IS NULL)                   AS NULL_CAMPAIGN_NAME,
       COUNT(DISTINCT CAMPAIGN_NAME)                     AS DISTINCT_CAMPAIGNS,

       COUNT_IF(CALL_STATUS IS NULL OR TRIM(CALL_STATUS) = '') AS BLANK_CALL_STATUS,
       COUNT(DISTINCT CALL_STATUS)                       AS DISTINCT_CALL_STATUS,

       COUNT_IF(NVL(SCORE, 0) = 0)                       AS ZERO_OR_NULL_SCORE,
       COUNT(DISTINCT SCORE)                             AS DISTINCT_SCORE,
       MIN(SCORE)                                        AS MIN_SCORE,
       MAX(SCORE)                                        AS MAX_SCORE,

       COUNT_IF(SCOREGROUP IS NULL OR TRIM(SCOREGROUP) = '') AS BLANK_SCOREGROUP,
       COUNT(DISTINCT SCOREGROUP)                        AS DISTINCT_SCOREGROUP,

       COUNT_IF(TIME_BUCKET_30MIN IS NULL)               AS NULL_TIME_BUCKET,
       MIN(CALL_START_TIME)                              AS EARLIEST,
       MAX(CALL_START_TIME)                              AS LATEST
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31';
-- BLANK_SCOREGROUP equal to ROWS_FOUND confirms what the screen already shows.

-- C2. Template for a NEW column. Replace <COLUMN> in all four places.
--     Low DISTINCT_VALUES means it is worth a breakdown; high means it is a
--     measure or an identifier, not a dimension.
/*
SELECT COUNT(*)                       AS ROWS_FOUND,
       COUNT(<COLUMN>)                AS NON_NULL,
       COUNT(DISTINCT <COLUMN>)       AS DISTINCT_VALUES,
       MIN(<COLUMN>)                  AS MIN_VALUE,
       MAX(<COLUMN>)                  AS MAX_VALUE
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31';

SELECT <COLUMN>, COUNT(*) AS ROWS_FOUND, SUM(LEADS) AS LEADS
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31'
 GROUP BY 1
 ORDER BY LEADS DESC NULLS LAST
 LIMIT 50;
*/


/* -----------------------------------------------------------------------------
   SECTION D — what CALL_STATUS actually contains

   THE MEASURES A DIALLER REPORT IS MISSING ALL DEPEND ON THIS. Connect rate,
   contact rate, abandon rate, right-party-contact — every one is a share of
   leads whose status means a particular thing, and nothing in this repo records
   which string means which. It cannot be guessed from the spelling: "ANSWERED"
   might be the switch answering or the person answering, and those give
   different numbers to the same question.

   Send this back with a note on which of these count as a CONNECT and which as
   an ABANDON, and the rates become a small change.
-------------------------------------------------------------------------------- */

SELECT COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(blank)') AS CALL_STATUS,
       COUNT(*)                                           AS ROWS_FOUND,
       SUM(LEADS)                                         AS LEADS,
       ROUND(100 * RATIO_TO_REPORT(SUM(LEADS)) OVER (), 1) AS PCT_OF_LEADS
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31'
 GROUP BY 1
 ORDER BY LEADS DESC NULLS LAST;


/* -----------------------------------------------------------------------------
   SECTION E — the grain

   WHAT CAN BE SAFELY SUMMED FOLLOWS ENTIRELY FROM THIS. The view is
   pre-aggregated, and the report assumes one row per campaign + date +
   half-hour + status. If something else is in the key — an agent, a list, a
   disposition code that section B reveals — then a breakdown on any ONE of
   those dimensions still sums correctly, but a tile that mixes two of them
   double-counts, and nothing in the output would look wrong.

   ROWS_PER_KEY of 1 means the assumed grain is right.
-------------------------------------------------------------------------------- */

SELECT MAX(ROWS_PER_KEY)          AS MAX_ROWS_PER_KEY,
       COUNT_IF(ROWS_PER_KEY > 1) AS KEYS_WITH_MORE_THAN_ONE,
       COUNT(*)                   AS KEYS_CHECKED
  FROM (
        SELECT CAMPAIGN_NAME,
               CALL_START_TIME,
               TIME_BUCKET_30MIN,
               CALL_STATUS,
               COUNT(*) AS ROWS_PER_KEY
          FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
         WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31'
         GROUP BY 1, 2, 3, 4
       );

-- E2. Is CALL_START_TIME day-grain or a timestamp? The Days tile is
--     COUNT(DISTINCT CALL_START_TIME), which is only "days" if the column holds
--     dates. A time component would overstate the day count and understate
--     every Avg / day derived from it.
SELECT COUNT(DISTINCT CALL_START_TIME)                        AS DISTINCT_RAW,
       COUNT(DISTINCT TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD')) AS DISTINCT_DAYS
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
 WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-31';
-- DISTINCT_RAW > DISTINCT_DAYS means the tile is wrong.
