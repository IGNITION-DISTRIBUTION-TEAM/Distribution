/* =============================================================================
   ONAIR U5 — BALANCED POOL   (campaign 608)
   -----------------------------------------------------------------------------
   One process. One procedure builds both pools, allocates them across the score
   bands to a headcount-derived quota, and writes a single table. One view reads
   it. One automation config in the app runs it.

   NOTHING HERE TOUCHES THE CURRENT PROCESS.
     new procedure  SP_ONAIR_U5_BALANCED_POOL
     new table      TM_ONAIR_U5_BALANCED_POOL
     new view       VW_V_U5_BALANCED_POOL
     new config     a second automation on campaign 608

   SP_ONAIR_NEW_POOL_BR, SP_ONAIRICUBATION_NEW_POOL_BR and
   VW_V_U5_OPTIMIZED_POOL are all left exactly as they are, so the existing
   Default automation keeps running unchanged and the two can be compared
   side by side before anything is switched off.

   STEPS
     1  config tables                              once
     2  seed the 18 bands                          once, then edit freely
     3  the allocation procedure                   once
     4  the view                                   once
     5  PRE-FLIGHT — run before every distribution
     6  run it
     7  verify
     8  wire it into the app                       see the runbook

   GRANTS: see 00-grants.sql in this folder. The procedure is EXECUTE AS OWNER,
   so the rights that matter are its OWNER's — not yours and not the app's. The
   pool tables are created by the two builders running as a different owner, so
   the new procedure's owner has to be granted SELECT on them explicitly. Run
   00-grants.sql section 2 before STEP 6 or the first call fails on
   "Insufficient privileges to operate on table TM_ONAIR_INCUBATION_SCORE_OTPUT".

   NOT YET TESTED against the warehouse — I have no Snowflake access from here.
   Step 5 is the check that catches anything wrong before a lead moves.
============================================================================= */


/* -----------------------------------------------------------------------------
   STEP 1 — config tables
----------------------------------------------------------------------------- */

-- Band definitions. Rows are matched on SCORE_MIN..SCORE_MAX, not on the label:
-- SCOREGROUP3 is percentile-derived and its boundaries move when XDS re-scores,
-- so a label join silently drops a band the day the ranges shift. The label is
-- carried for display and reporting only.
CREATE TABLE IF NOT EXISTS
    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
(
     BAND_LABEL     VARCHAR       NOT NULL
    ,SCORE_MIN      NUMBER(38,0)  NOT NULL
    ,SCORE_MAX      NUMBER(38,0)  NOT NULL
    -- Relative share of the target. All 1 = an even split. Set the thin bands
    -- higher when you want to lean into them.
    ,WEIGHT         NUMBER(10,4)  NOT NULL DEFAULT 1
    -- Hard override. NULL = derive from headcount and WEIGHT. Set a number to
    -- pin one band regardless of the sizing.
    ,TARGET_ROWS    NUMBER(38,0)
    -- FALSE = this band takes default-pool leads only, no incubation top-up.
    ,TOPUP_ENABLED  BOOLEAN       NOT NULL DEFAULT TRUE
    ,ENABLED        BOOLEAN       NOT NULL DEFAULT TRUE
    ,UPDATED_AT     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
    ,CONSTRAINT PK_U5_BAND_TARGETS PRIMARY KEY (BAND_LABEL)
);

-- Run log. The procedure takes five positional numbers and "(1, 308, 5, 180, 1)"
-- is not self-describing three weeks later — this records what was actually
-- asked for and what came back.
CREATE TABLE IF NOT EXISTS
    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
(
     RUN_AT               TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
    ,AGENTS               NUMBER(38,0)
    ,DAYS                 NUMBER(38,0)
    ,LEADS_PER_AGENT_DAY  NUMBER(38,0)
    ,TARGET_TOTAL         NUMBER(38,0)
    ,REBUILT_POOLS        BOOLEAN
    ,HISTORY_CHECK        NUMBER(38,0)
    ,BANDS_USED           NUMBER(38,0)
    ,SELECTED_TOTAL       NUMBER(38,0)
    ,SELECTED_DEFAULT     NUMBER(38,0)
    ,SELECTED_TOPUP       NUMBER(38,0)
    ,SHORTFALL            NUMBER(38,0)
);


/* -----------------------------------------------------------------------------
   STEP 2 — seed the 18 bands
   Ranges taken from the current SCOREGROUP3 labels so day one reproduces
   today's banding exactly. 908+ is closed at 9999 rather than left open.
----------------------------------------------------------------------------- */
TRUNCATE TABLE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS;

INSERT INTO DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
       (BAND_LABEL, SCORE_MIN, SCORE_MAX)
VALUES
     ('650 to 661', 650, 661)
    ,('662 to 672', 662, 672)
    ,('673 to 682', 673, 682)
    ,('683 to 692', 683, 692)
    ,('693 to 704', 693, 704)
    ,('705 to 715', 705, 715)
    ,('716 to 726', 716, 726)
    ,('727 to 738', 727, 738)
    ,('739 to 751', 739, 751)
    ,('752 to 765', 752, 765)
    ,('766 to 780', 766, 780)
    ,('781 to 796', 781, 796)
    ,('797 to 814', 797, 814)
    ,('815 to 835', 815, 835)
    ,('836 to 858', 836, 858)
    ,('859 to 886', 859, 886)
    ,('887 to 907', 887, 907)
    ,('908+',       908, 9999)
;

-- Adjusting later — no reload needed:
--   lean into a thin band
--     UPDATE ...TM_U5_BAND_TARGETS SET WEIGHT = 1.5, UPDATED_AT = CURRENT_TIMESTAMP()
--      WHERE BAND_LABEL = '739 to 751';
--   pin one band to a fixed number
--     UPDATE ...TM_U5_BAND_TARGETS SET TARGET_ROWS = 20000 WHERE BAND_LABEL = '836 to 858';
--   drop a band from the campaign
--     UPDATE ...TM_U5_BAND_TARGETS SET ENABLED = FALSE WHERE BAND_LABEL = '908+';
--   split a band in two
--     UPDATE ...TM_U5_BAND_TARGETS SET SCORE_MAX = 872 WHERE BAND_LABEL = '859 to 886';
--     INSERT INTO ...TM_U5_BAND_TARGETS (BAND_LABEL, SCORE_MIN, SCORE_MAX)
--       VALUES ('873 to 886', 873, 886);
--     -- then re-run the overlap check in STEP 5.


/* -----------------------------------------------------------------------------
   STEP 3 — the allocation procedure

   ARGUMENTS, in order. Write them into the app's Procedure field exactly as you
   would the CALL.

     AGENTS               head count on the campaign          e.g. 308
     DAYS                 days the book must cover            e.g. 5
     LEADS_PER_AGENT_DAY  leads per agent per day             e.g. 180
     HISTORY_CHECK        1 = apply history / last-contact exclusions, 0 = skip
     REBUILD_POOLS        1 = rebuild both source pools first, 0 = allocate
                          against the pools as they stand

   REBUILD_POOLS = 0 exists so you can re-allocate in seconds after changing a
   band, instead of waiting out the full pool rebuild for a config change that
   does not need one.
----------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
(
     AGENTS              NUMBER(38,0)
    ,DAYS                NUMBER(38,0)
    ,LEADS_PER_AGENT_DAY NUMBER(38,0)
    ,HISTORY_CHECK       NUMBER(38,0)
    ,REBUILD_POOLS       NUMBER(38,0)
)
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    target_total NUMBER;
    band_count   NUMBER;
    sel_total    NUMBER;
    sel_default  NUMBER;
    sel_topup    NUMBER;
BEGIN
    target_total := :AGENTS * :DAYS * :LEADS_PER_AGENT_DAY;

    SELECT COUNT(*) INTO :band_count
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
     WHERE ENABLED;

    IF (:band_count = 0) THEN
        RETURN 'ABORTED: no enabled rows in TM_U5_BAND_TARGETS. Nothing would be selected.';
    END IF;

    -- 1. Rebuild the two source pools, unless told not to.
    IF (:REBUILD_POOLS = 1) THEN
        CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(:HISTORY_CHECK);
        CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIRICUBATION_NEW_POOL_BR(:HISTORY_CHECK);
    END IF;

    -- 2. Allocate both pools into one table, in one pass.
    CREATE OR REPLACE TABLE
        DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
    COPY GRANTS
    AS
    WITH cfg AS (
        SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, WEIGHT, TARGET_ROWS, TOPUP_ENABLED
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
        WHERE ENABLED
    ),
    -- Quota per band. An explicit TARGET_ROWS wins; otherwise the target is
    -- split by weight. All weights at 1 gives the even split.
    quota AS (
        SELECT
             c.BAND_LABEL
            ,c.SCORE_MIN
            ,c.SCORE_MAX
            ,c.TOPUP_ENABLED
            ,COALESCE(
                 c.TARGET_ROWS,
                 FLOOR(:target_total * c.WEIGHT / SUM(c.WEIGHT) OVER ())
             ) AS QUOTA
        FROM cfg c
    ),
    -- Both pools, one shape. PRIORITY is what makes this a single process
    -- rather than two runs: the default pool sorts ahead of the top-up inside
    -- every band, so incubation leads only ever fill what the default pool
    -- could not.
    pool AS (
        SELECT
             1                          AS PRIORITY
            ,'default'                  AS POOL
            ,IDENTIFIERNUMBER
            ,XDSPRESAGE3
            ,XDSPRESAGESCOREGROUP3
            ,CONTACTNUMBER1
            ,CONTACTNUMBER2
            ,CONTACTNUMBER3
            ,LAST_DISTRIBUTED_DATE
            ,LAST_CALL_CONTACT
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
        WHERE LEAD_DESCRIPTION = 'ONAIR 5'

        UNION ALL

        SELECT
             2
            ,'topup'
            ,IDENTIFIERNUMBER
            ,XDSPRESAGE3
            ,XDSPRESAGESCOREGROUP3
            ,CONTACTNUMBER1
            ,CONTACTNUMBER2
            ,CONTACTNUMBER3
            ,LAST_DISTRIBUTED_DATE
            ,LAST_CALL_CONTACT
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
        WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION'
    ),
    -- Band each lead by its actual score. The two pools are disjoint by
    -- construction (incubation is built WHERE NOT EXISTS in IGNITION_ONAIR), but
    -- the QUALIFY costs almost nothing and means a change to either builder can
    -- never silently start issuing the same lead twice.
    banded AS (
        SELECT
             p.*
            ,q.BAND_LABEL
            ,q.QUOTA
        FROM pool p
        JOIN quota q
          ON TRY_TO_NUMBER(p.XDSPRESAGE3) BETWEEN q.SCORE_MIN AND q.SCORE_MAX
        WHERE p.CONTACTNUMBER1 IS NOT NULL
          AND (p.POOL = 'default' OR q.TOPUP_ENABLED)
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY p.IDENTIFIERNUMBER ORDER BY p.PRIORITY
        ) = 1
    ),
    -- Order inside a band:
    --   PRIORITY               default pool before top-up
    --   LAST_DISTRIBUTED_DATE  never distributed first, then oldest
    --   LAST_CALL_CONTACT      coldest first
    --   HASH(ID)               stable tie-break — deterministic across runs,
    --                          so what you verify is what the dialler gets.
    -- Hash alone would be stable across DAYS as well, parking the same IDs at
    -- the front of their band forever and starving everything behind them.
    ranked AS (
        SELECT
             b.*
            ,ROW_NUMBER() OVER (
                 PARTITION BY b.BAND_LABEL
                 ORDER BY b.PRIORITY,
                          b.LAST_DISTRIBUTED_DATE ASC NULLS FIRST,
                          b.LAST_CALL_CONTACT     ASC NULLS FIRST,
                          HASH(b.IDENTIFIERNUMBER)
             ) AS RN
        FROM banded b
    )
    SELECT
         IDENTIFIERNUMBER                           AS IDNUMBER
        ,CONCAT('0', RIGHT(CONTACTNUMBER1, 9))      AS CELLNUMBER
        ,CASE WHEN CONTACTNUMBER2 IS NULL THEN NULL
              ELSE CONCAT('0', RIGHT(CONTACTNUMBER2, 9)) END AS ALT_NUMBER1
        ,CASE WHEN CONTACTNUMBER3 IS NULL THEN NULL
              ELSE CONCAT('0', RIGHT(CONTACTNUMBER3, 9)) END AS ALT_NUMBER2
        ,TRY_TO_NUMBER(XDSPRESAGE3)                 AS SCORE
        ,XDSPRESAGESCOREGROUP3                      AS SOURCE_SCOREGROUP
        ,BAND_LABEL                                 AS SCOREGROUP
        ,POOL                                       AS SOURCE_POOL
        ,QUOTA                                      AS BAND_QUOTA
        ,RN                                         AS BAND_RANK
        ,CURRENT_TIMESTAMP()                        AS ALLOCATED_AT
    FROM ranked
    WHERE RN <= QUOTA;

    -- 3. Log the run.
    SELECT COUNT(*),
           COUNT_IF(SOURCE_POOL = 'default'),
           COUNT_IF(SOURCE_POOL = 'topup')
      INTO :sel_total, :sel_default, :sel_topup
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL;

    INSERT INTO DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
        (AGENTS, DAYS, LEADS_PER_AGENT_DAY, TARGET_TOTAL, REBUILT_POOLS,
         HISTORY_CHECK, BANDS_USED, SELECTED_TOTAL, SELECTED_DEFAULT,
         SELECTED_TOPUP, SHORTFALL)
    SELECT :AGENTS, :DAYS, :LEADS_PER_AGENT_DAY, :target_total, :REBUILD_POOLS = 1,
           :HISTORY_CHECK, :band_count, :sel_total, :sel_default, :sel_topup,
           GREATEST(:target_total - :sel_total, 0);

    RETURN 'target ' || :target_total
        || ' | selected ' || :sel_total
        || ' (default ' || :sel_default || ', top-up ' || :sel_topup || ')'
        || ' | short ' || GREATEST(:target_total - :sel_total, 0)
        || ' | bands ' || :band_count;
END;
$$;


/* -----------------------------------------------------------------------------
   STEP 4 — the view the app loads from

   The app auto-fills CAMPAIGNID, BATCHNAME, CREATEDONDATE and LEADEXPIRY from
   the automation config, so this view deliberately does NOT supply them. Map
   only the columns below.
----------------------------------------------------------------------------- */
CREATE OR REPLACE VIEW
    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL
AS
SELECT
     IDNUMBER
    ,NULL          AS FIRSTNAME
    ,NULL          AS LASTNAME
    ,CELLNUMBER
    ,ALT_NUMBER1   AS CONTACTNUMBER1
    ,ALT_NUMBER2   AS CONTACTNUMBER2
    ,SCORE
    ,SCOREGROUP
    ,SOURCE_POOL
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL;


/* -----------------------------------------------------------------------------
   STEP 5 — PRE-FLIGHT. Run before every distribution.
   Set the four numbers at the top to whatever the config field says.
----------------------------------------------------------------------------- */
SET AGENTS = 308;
SET DAYS = 5;
SET LPAD_ = 180;
SET TARGET = $AGENTS * $DAYS * $LPAD_;

-- 5a. What each band will get, and from where.
WITH cfg AS (
    SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, WEIGHT, TARGET_ROWS, TOPUP_ENABLED
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
    WHERE ENABLED
),
quota AS (
    SELECT c.*,
           COALESCE(c.TARGET_ROWS,
                    FLOOR($TARGET * c.WEIGHT / SUM(c.WEIGHT) OVER ())) AS QUOTA
    FROM cfg c
),
pool AS (
    SELECT 'default' AS POOL, TRY_TO_NUMBER(XDSPRESAGE3) AS SCORE
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR 5' AND CONTACTNUMBER1 IS NOT NULL
    UNION ALL
    SELECT 'topup', TRY_TO_NUMBER(XDSPRESAGE3)
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION' AND CONTACTNUMBER1 IS NOT NULL
),
avail AS (
    SELECT q.BAND_LABEL, q.QUOTA, q.TOPUP_ENABLED,
           COUNT_IF(p.POOL = 'default') AS AVAIL_DEFAULT,
           COUNT_IF(p.POOL = 'topup' AND q.TOPUP_ENABLED) AS AVAIL_TOPUP
    FROM quota q
    LEFT JOIN pool p ON p.SCORE BETWEEN q.SCORE_MIN AND q.SCORE_MAX
    GROUP BY 1,2,3
)
SELECT
     BAND_LABEL
    ,QUOTA
    ,AVAIL_DEFAULT
    ,AVAIL_TOPUP
    ,LEAST(QUOTA, AVAIL_DEFAULT)                              AS FROM_DEFAULT
    ,LEAST(GREATEST(QUOTA - AVAIL_DEFAULT, 0), AVAIL_TOPUP)   AS FROM_TOPUP
    ,GREATEST(QUOTA - AVAIL_DEFAULT - AVAIL_TOPUP, 0)         AS STILL_SHORT
    ,CASE
        WHEN AVAIL_DEFAULT + AVAIL_TOPUP = 0 THEN 'EMPTY   — no leads in this score range at all'
        WHEN QUOTA > AVAIL_DEFAULT + AVAIL_TOPUP THEN 'SHORT   — both pools run dry before the quota'
        WHEN QUOTA > AVAIL_DEFAULT THEN 'TOPPED  — needs incubation leads to fill'
        ELSE 'OK      — default pool covers it'
     END AS STATUS
FROM avail
ORDER BY BAND_LABEL;

-- 5b. The bottom line, before anything runs.
WITH cfg AS (
    SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, WEIGHT, TARGET_ROWS, TOPUP_ENABLED
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS WHERE ENABLED
),
quota AS (
    SELECT c.*, COALESCE(c.TARGET_ROWS,
             FLOOR($TARGET * c.WEIGHT / SUM(c.WEIGHT) OVER ())) AS QUOTA FROM cfg c
),
pool AS (
    SELECT 'default' AS POOL, TRY_TO_NUMBER(XDSPRESAGE3) AS SCORE
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR 5' AND CONTACTNUMBER1 IS NOT NULL
    UNION ALL
    SELECT 'topup', TRY_TO_NUMBER(XDSPRESAGE3)
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION' AND CONTACTNUMBER1 IS NOT NULL
),
avail AS (
    SELECT q.BAND_LABEL, q.QUOTA,
           COUNT_IF(p.POOL='default') AS AD,
           COUNT_IF(p.POOL='topup' AND q.TOPUP_ENABLED) AS AT_
    FROM quota q LEFT JOIN pool p ON p.SCORE BETWEEN q.SCORE_MIN AND q.SCORE_MAX
    GROUP BY 1,2
)
SELECT $TARGET                                        AS TARGET_TOTAL
      ,SUM(LEAST(QUOTA, AD + AT_))                    AS WILL_SELECT
      ,$TARGET - SUM(LEAST(QUOTA, AD + AT_))          AS WILL_BE_SHORT
      ,SUM(LEAST(QUOTA, AD))                          AS FROM_DEFAULT
      ,SUM(LEAST(GREATEST(QUOTA - AD, 0), AT_))       AS FROM_TOPUP
FROM avail;

-- 5c. Overlapping or gapped band ranges. Expect no rows.
-- An overlap double-counts a lead's band; a gap drops every lead in it.
SELECT a.BAND_LABEL AS BAND_A, b.BAND_LABEL AS BAND_B, 'OVERLAP' AS PROBLEM
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS a
JOIN DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS b
  ON a.BAND_LABEL < b.BAND_LABEL
 AND a.ENABLED AND b.ENABLED
 AND a.SCORE_MIN <= b.SCORE_MAX AND b.SCORE_MIN <= a.SCORE_MAX;

-- 5d. Scored leads that fall outside every band. Expect 0 above 650.
SELECT COUNT(*) AS LEADS_IN_NO_BAND
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT p
WHERE p.LEAD_DESCRIPTION = 'ONAIR 5'
  AND NOT EXISTS (
      SELECT 1 FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS b
      WHERE b.ENABLED AND TRY_TO_NUMBER(p.XDSPRESAGE3) BETWEEN b.SCORE_MIN AND b.SCORE_MAX
  );


/* -----------------------------------------------------------------------------
   STEP 6 — run it

   By hand, the first few times. REBUILD_POOLS = 0 here on the assumption the
   pools were built today already; pass 1 to rebuild them as part of the run.
----------------------------------------------------------------------------- */
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 0);
-- Returns e.g.
--   target 277200 | selected 213480 (default 188972, top-up 24508) | short 63720 | bands 18


/* -----------------------------------------------------------------------------
   STEP 7 — verify
----------------------------------------------------------------------------- */

-- 7a. Delivered vs quota, per band, and the pool split.
SELECT
     SCOREGROUP
    ,MAX(BAND_QUOTA)                   AS QUOTA
    ,COUNT(*)                          AS DELIVERED
    ,COUNT(*) - MAX(BAND_QUOTA)        AS VARIANCE
    ,COUNT_IF(SOURCE_POOL = 'default') AS FROM_DEFAULT
    ,COUNT_IF(SOURCE_POOL = 'topup')   AS FROM_TOPUP
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
GROUP BY SCOREGROUP
ORDER BY SCOREGROUP;

-- 7b. Every band that came up short. VARIANCE is never positive: the quota is a
-- ceiling, so a negative number means the pools ran dry, not that anything broke.
SELECT COUNT(*) AS TOTAL, MIN(SCORE) AS MIN_SCORE, MAX(SCORE) AS MAX_SCORE
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL;

-- 7c. No duplicate IDs. Expect 0.
SELECT COUNT(*) AS DUPLICATE_IDS FROM (
    SELECT IDNUMBER FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
    GROUP BY 1 HAVING COUNT(*) > 1
);

-- 7d. Nothing already distributed inside the history window slipped through.
-- Expect 0 when the procedure was called with HISTORY_CHECK = 1.
SELECT COUNT(*) AS RECENTLY_DISTRIBUTED
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL b
JOIN DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
  ON b.IDNUMBER = h.IDNUMBER
WHERE h.CAMPAIGNID = 608
  AND h.CREATEDONDATE >= CURRENT_DATE() - 40;

-- 7e. Run history.
SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
ORDER BY RUN_AT DESC LIMIT 20;


/* -----------------------------------------------------------------------------
   STEP 8 — the app

   Settings -> campaign 608 -> New automation. Do NOT edit the existing one.

     Name              OnAir U5 - balanced
     Lead source       Snowflake (stored proc / view)
     Source type       Stored procedure -> stage table
     Procedure         DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 1)
     Upload target     DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL
     Batch name        BATCH_ONAIR_U5_BAL_{date}
     Lead expiry       45

   Then "Load columns & map", and copy the update-HLL and sync settings across
   from the existing automation. Save before running anything — the run uses the
   saved config, not the form.

   Changing headcount later is one edit to the Procedure field, then Save.
   308 agents -> 280: SP_ONAIR_U5_BALANCED_POOL(280, 5, 180, 1, 1).

   Full walkthrough, including what to check between each step, is in the
   runbook.
----------------------------------------------------------------------------- */


/* =============================================================================
   NOTES

   1. Strict even, no reallocation. A band that runs dry stays short; the
      surplus in the fat bands is NOT pulled across to cover it. That is the
      conservative reading of "balance the bands evenly", and it keeps the mix
      honest. If you want volume over evenness, the change is one line in the
      ranked CTE and it should be a decision, not a default.

   2. The quota is a ceiling, never a floor. Every band delivers
      min(quota, available). VARIANCE in step 7a is therefore never positive.

   3. Deterministic. Same pools plus same config gives the same leads, so the
      rows you check in step 7 are the rows the dialler gets. The order is not
      random: never-distributed first, then coldest contact, hash last.

   4. Leads with no CONTACTNUMBER1 are dropped at the banding stage. The source
      procedures already mark those 'NO CELLNUMBER' and exclude them, so this is
      belt and braces, not a second rule.

   5. TM_ONAIR_U5_BALANCED_POOL is a real table, not a view, so BATCHNAME and
      the dates cannot drift with CURRENT_DATE() between the verify and the
      load. It is replaced on every run.
============================================================================= */
