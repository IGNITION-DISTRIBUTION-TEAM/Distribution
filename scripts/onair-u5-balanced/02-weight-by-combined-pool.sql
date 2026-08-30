/* =============================================================================
   WEIGHT THE QUOTA BY THE COMBINED POOL
   -----------------------------------------------------------------------------
   The problem this fixes, in your own numbers.

   An even split gives every band the same absolute quota regardless of what it
   holds, so the depletion rate is wildly uneven. At a 188,972 target against
   the base pool:

     752 to 765   5,343 in pool  ->  takes 5,343   100% drained
     739 to 751   5,650          ->  takes 5,650   100% drained
     727 to 738   5,951          ->  takes 5,951   100% drained
     ...
     859 to 886  30,494          ->  takes 10,498   34% touched
     836 to 858  30,023          ->  takes 10,498   35% touched

   Eight of eighteen bands are emptied outright while the two fattest give up a
   third of their stock. Tomorrow the thin bands have nothing left, and the day
   after they are still empty — that is the over-depletion.

   Weighting by the combined pool instead depletes every band at the SAME RATE:

     every band  ->  85.4% of whatever it holds

   Sourcing does not change. Base pool first, top-up only for the remainder, in
   every band. What changes is how big the band's quota is in the first place:
   it is now a share of the total combined pool, not a flat slice of the target.

   ---------------------------------------------------------------------------
   WHAT THIS COSTS, STATED PLAINLY

   Proportional allocation reproduces the pool's own shape. The book stops being
   even by construction:

     share of the book from the three fattest (high-score) bands
       even split          19.8%
       pool-proportional   35.5%

   That is the concentration the original brief set out to correct. Both cannot
   be had at once from these pools — evenness drains the thin bands, and
   protecting the thin bands re-concentrates the book.

   Hence the third option below: even, but with a ceiling on how much of any
   band you may take. That keeps the mix flat where the pool can support it and
   refuses to drain a band past the ceiling. Set MAX_DEPLETION_PCT to 60 and no
   band gives up more than 60% of its stock, whichever mode you run.
============================================================================= */


/* -----------------------------------------------------------------------------
   1. New column — the depletion ceiling
   NULL means uncapped, so nothing changes until you set one.
----------------------------------------------------------------------------- */
ALTER TABLE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
  ADD COLUMN IF NOT EXISTS MAX_DEPLETION_PCT NUMBER(5,2);

-- A ceiling on every band at once:
-- UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
--    SET MAX_DEPLETION_PCT = 60, UPDATED_AT = CURRENT_TIMESTAMP();
--
-- Or protect only the thin ones:
-- UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
--    SET MAX_DEPLETION_PCT = 50, UPDATED_AT = CURRENT_TIMESTAMP()
--  WHERE BAND_LABEL IN ('705 to 715','716 to 726','727 to 738','739 to 751',
--                       '752 to 765','766 to 780','781 to 796','908+');


/* -----------------------------------------------------------------------------
   2. Drop the five-argument procedure

   NOT optional. Snowflake resolves procedures by name AND argument count, so
   creating a six-argument version leaves the old one sitting there, and the
   automation — which still calls five — would keep running the old even-split
   logic while you watched the new one work in a worksheet.
----------------------------------------------------------------------------- */
DROP PROCEDURE IF EXISTS
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
  (NUMBER, NUMBER, NUMBER, NUMBER, NUMBER);


/* -----------------------------------------------------------------------------
   3. The procedure

     AGENTS               head count                          e.g. 308
     DAYS                 days the book must cover            e.g. 5
     LEADS_PER_AGENT_DAY  leads per agent per day             e.g. 180
     HISTORY_CHECK        1 = apply history / last-contact exclusions
     REBUILD_POOLS        1 = rebuild both source pools first
     ALLOC_MODE           0 = even split
                          1 = weighted by the combined pool   <- the new default
----------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
(
     AGENTS              NUMBER(38,0)
    ,DAYS                NUMBER(38,0)
    ,LEADS_PER_AGENT_DAY NUMBER(38,0)
    ,HISTORY_CHECK       NUMBER(38,0)
    ,REBUILD_POOLS       NUMBER(38,0)
    ,ALLOC_MODE          NUMBER(38,0)
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

    IF (:REBUILD_POOLS = 1) THEN
        CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(:HISTORY_CHECK);
        CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIRICUBATION_NEW_POOL_BR(:HISTORY_CHECK);
    END IF;

    CREATE OR REPLACE TABLE
        DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
    COPY GRANTS
    AS
    WITH cfg AS (
        SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, WEIGHT, TARGET_ROWS,
               TOPUP_ENABLED, MAX_DEPLETION_PCT
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
        WHERE ENABLED
    ),
    pool AS (
        SELECT 1 AS PRIORITY, 'default' AS POOL, IDENTIFIERNUMBER, XDSPRESAGE3,
               XDSPRESAGESCOREGROUP3, CONTACTNUMBER1, CONTACTNUMBER2, CONTACTNUMBER3,
               LAST_DISTRIBUTED_DATE, LAST_CALL_CONTACT
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
        WHERE LEAD_DESCRIPTION = 'ONAIR 5'
        UNION ALL
        SELECT 2, 'topup', IDENTIFIERNUMBER, XDSPRESAGE3,
               XDSPRESAGESCOREGROUP3, CONTACTNUMBER1, CONTACTNUMBER2, CONTACTNUMBER3,
               LAST_DISTRIBUTED_DATE, LAST_CALL_CONTACT
        FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
        WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION'
    ),
    -- Every lead that is eligible for a band, from either pool. This is now
    -- computed BEFORE the quota, because the quota depends on how deep it is.
    banded AS (
        SELECT p.*, c.BAND_LABEL, c.WEIGHT, c.TARGET_ROWS, c.MAX_DEPLETION_PCT
        FROM pool p
        JOIN cfg c
          ON p.XDSPRESAGE3::INT BETWEEN c.SCORE_MIN AND c.SCORE_MAX
        WHERE p.CONTACTNUMBER1 IS NOT NULL
          AND (p.POOL = 'default' OR c.TOPUP_ENABLED)
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY p.IDENTIFIERNUMBER ORDER BY p.PRIORITY
        ) = 1
    ),
    -- COMBINED counts both pools together, which is the whole point: a band's
    -- claim on the target is its share of what the two bases hold between them,
    -- so every band gives up the same PROPORTION rather than the same NUMBER.
    avail AS (
        SELECT BAND_LABEL,
               COUNT(*)                     AS COMBINED,
               ANY_VALUE(WEIGHT)            AS WEIGHT,
               ANY_VALUE(TARGET_ROWS)       AS TARGET_ROWS,
               ANY_VALUE(MAX_DEPLETION_PCT) AS MAX_DEPLETION_PCT
        FROM banded
        GROUP BY BAND_LABEL
    ),
    quota AS (
        SELECT
             BAND_LABEL
            ,COMBINED
            ,LEAST(
                 COALESCE(
                     TARGET_ROWS,
                     CASE WHEN :ALLOC_MODE = 1
                          -- Share of the combined pool, weighted.
                          THEN FLOOR(:target_total * COMBINED * WEIGHT
                                     / NULLIF(SUM(COMBINED * WEIGHT) OVER (), 0))
                          -- Flat slice of the target, weighted.
                          ELSE FLOOR(:target_total * WEIGHT
                                     / NULLIF(SUM(WEIGHT) OVER (), 0))
                     END
                 )
                 -- The ceiling applies in both modes. NULL means uncapped, and
                 -- COMBINED is itself the natural cap, so this never raises a
                 -- quota — only lowers it.
                ,COALESCE(FLOOR(COMBINED * MAX_DEPLETION_PCT / 100), COMBINED)
             ) AS QUOTA
        FROM avail
    ),
    -- Sourcing is unchanged: PRIORITY first, so the base pool fills the band and
    -- the top-up only ever takes what is left.
    ranked AS (
        SELECT
             b.*
            ,q.QUOTA
            ,ROW_NUMBER() OVER (
                 PARTITION BY b.BAND_LABEL
                 ORDER BY b.PRIORITY,
                          b.LAST_DISTRIBUTED_DATE ASC NULLS FIRST,
                          b.LAST_CALL_CONTACT     ASC NULLS FIRST,
                          HASH(b.IDENTIFIERNUMBER)
             ) AS RN
        FROM banded b
        JOIN quota q ON q.BAND_LABEL = b.BAND_LABEL
    )
    SELECT
         IDENTIFIERNUMBER                           AS IDNUMBER
        ,CONCAT('0', RIGHT(CONTACTNUMBER1, 9))      AS CELLNUMBER
        ,CASE WHEN CONTACTNUMBER2 IS NULL THEN NULL
              ELSE CONCAT('0', RIGHT(CONTACTNUMBER2, 9)) END AS ALT_NUMBER1
        ,CASE WHEN CONTACTNUMBER3 IS NULL THEN NULL
              ELSE CONCAT('0', RIGHT(CONTACTNUMBER3, 9)) END AS ALT_NUMBER2
        ,XDSPRESAGE3::INT                           AS SCORE
        ,XDSPRESAGESCOREGROUP3                      AS SOURCE_SCOREGROUP
        ,BAND_LABEL                                 AS SCOREGROUP
        ,POOL                                       AS SOURCE_POOL
        ,QUOTA                                      AS BAND_QUOTA
        ,RN                                         AS BAND_RANK
        ,CURRENT_TIMESTAMP()                        AS ALLOCATED_AT
    FROM ranked
    WHERE RN <= QUOTA;

    SELECT COUNT(*),
           COUNT_IF(SOURCE_POOL = 'default'),
           COUNT_IF(SOURCE_POOL = 'topup')
      INTO :sel_total, :sel_default, :sel_topup
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL;

    INSERT INTO DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
        (AGENTS, DAYS, LEADS_PER_AGENT_DAY, TARGET_TOTAL, REBUILT_POOLS,
         HISTORY_CHECK, BANDS_USED, SELECTED_TOTAL, SELECTED_DEFAULT,
         SELECTED_TOPUP, SHORTFALL, ALLOC_MODE)
    SELECT :AGENTS, :DAYS, :LEADS_PER_AGENT_DAY, :target_total, :REBUILD_POOLS = 1,
           :HISTORY_CHECK, :band_count, :sel_total, :sel_default, :sel_topup,
           GREATEST(:target_total - :sel_total, 0), :ALLOC_MODE;

    RETURN 'mode ' || CASE WHEN :ALLOC_MODE = 1 THEN 'pool-weighted' ELSE 'even' END
        || ' | target ' || :target_total
        || ' | selected ' || :sel_total
        || ' (default ' || :sel_default || ', top-up ' || :sel_topup || ')'
        || ' | short ' || GREATEST(:target_total - :sel_total, 0)
        || ' | bands ' || :band_count;
END;
$$;


/* -----------------------------------------------------------------------------
   4. Run log gets the mode, so history stays self-describing
   Run this BEFORE the procedure above if the INSERT complains about ALLOC_MODE.
----------------------------------------------------------------------------- */
ALTER TABLE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
  ADD COLUMN IF NOT EXISTS ALLOC_MODE NUMBER(38,0);


/* -----------------------------------------------------------------------------
   5. Re-grant

   CREATE OR REPLACE PROCEDURE carries no grants, and this is a new signature
   besides — six arguments, not five. Without this the automation fails with
   "Unknown user-defined function", which reads as a missing procedure.
----------------------------------------------------------------------------- */
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
  (NUMBER, NUMBER, NUMBER, NUMBER, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   6. Compare the two modes before you commit to one
----------------------------------------------------------------------------- */
-- Even split, as it ran before:
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 0, 0);
SELECT SCOREGROUP, MAX(BAND_QUOTA) AS QUOTA, COUNT(*) AS DELIVERED,
       COUNT_IF(SOURCE_POOL='default') AS BASE, COUNT_IF(SOURCE_POOL='topup') AS TOPUP
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
GROUP BY 1 ORDER BY 1;

-- Weighted by the combined pool:
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 0, 1);
SELECT SCOREGROUP, MAX(BAND_QUOTA) AS QUOTA, COUNT(*) AS DELIVERED,
       COUNT_IF(SOURCE_POOL='default') AS BASE, COUNT_IF(SOURCE_POOL='topup') AS TOPUP
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
GROUP BY 1 ORDER BY 1;

-- The number that matters — what fraction of each band you took:
WITH cfg AS (
    SELECT BAND_LABEL, SCORE_MIN, SCORE_MAX, TOPUP_ENABLED
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS WHERE ENABLED
),
pool AS (
    SELECT 'default' AS POOL, XDSPRESAGE3::INT AS SCORE
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR 5' AND CONTACTNUMBER1 IS NOT NULL
    UNION ALL
    SELECT 'topup', XDSPRESAGE3::INT
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION' AND CONTACTNUMBER1 IS NOT NULL
),
combined AS (
    SELECT c.BAND_LABEL,
           COUNT_IF(p.POOL = 'default' OR c.TOPUP_ENABLED) AS COMBINED
    FROM cfg c LEFT JOIN pool p ON p.SCORE BETWEEN c.SCORE_MIN AND c.SCORE_MAX
    GROUP BY 1
),
taken AS (
    SELECT SCOREGROUP AS BAND_LABEL, COUNT(*) AS DELIVERED
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
    GROUP BY 1
)
SELECT c.BAND_LABEL, c.COMBINED, COALESCE(t.DELIVERED,0) AS DELIVERED,
       ROUND(100.0 * COALESCE(t.DELIVERED,0) / NULLIF(c.COMBINED,0), 1) AS DEPLETION_PCT
FROM combined c LEFT JOIN taken t ON t.BAND_LABEL = c.BAND_LABEL
ORDER BY DEPLETION_PCT DESC;
-- Even mode: expect a spread from roughly 34% to 100%.
-- Pool-weighted: expect every band on the same figure.


/* -----------------------------------------------------------------------------
   7. Point the automation at the six-argument version
----------------------------------------------------------------------------- */
-- Settings -> campaign 608 -> "OnAir U5 - balanced" -> Procedure field:
--
--   DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 1, 1)
--                                                                                          ^
--                                                                        the mode: 1 = pool-weighted
--
-- Save. The old five-argument call now fails, which is the point — the drop in
-- section 2 makes the switch explicit instead of leaving the old logic running
-- unnoticed.
