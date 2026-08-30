-- PHASE 0 — the measurements the band-balancing plan depends on.
-- Nothing here changes anything. Run all four, send the output back.


-- ============================================================================
-- 1. Incubation (top-up) pool availability per band  ** THE BLOCKER **
-- ============================================================================
-- The default pool holds 221,334 against a target of 277,200, so the top-up
-- pool has to supply at least 55,866 for volume alone, and 88,228 to also even
-- the bands out. Whether that is possible is entirely down to this query.
SELECT
     XDSPRESAGESCOREGROUP3        AS SCOREGROUP
    ,COUNT(*)                     AS AVAILABLE
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION'
  AND XDSPRESAGESCOREGROUP3 IS NOT NULL
GROUP BY 1
ORDER BY 1;


-- ============================================================================
-- 2. Confirm the default-pool figures were taken WITH the filter on
-- ============================================================================
-- Your draft's comments list availability per band. If those came off the
-- unfiltered table, every ceiling in the plan is overstated. This returns the
-- filtered figures — they should match the comments in your draft.
SELECT
     XDSPRESAGESCOREGROUP3        AS SCOREGROUP
    ,COUNT(*)                     AS AVAILABLE
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
WHERE LEAD_DESCRIPTION = 'ONAIR 5'
  AND XDSPRESAGESCOREGROUP3 IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- Expected total from your draft's comments: 221,334.
SELECT COUNT(*) AS TOTAL_ONAIR_5
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
WHERE LEAD_DESCRIPTION = 'ONAIR 5';


-- ============================================================================
-- 3. Both pools side by side — what "even" can actually reach
-- ============================================================================
-- Combined ceiling per band. Any band whose COMBINED figure is below the quota
-- cannot be filled by any allocation rule, and the plan's mode question (strict
-- even vs reallocate) is decided by how many bands land here.
WITH d AS (
    SELECT XDSPRESAGESCOREGROUP3 AS sg, COUNT(*) AS n
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR 5' AND XDSPRESAGESCOREGROUP3 IS NOT NULL
    GROUP BY 1
),
t AS (
    SELECT XDSPRESAGESCOREGROUP3 AS sg, COUNT(*) AS n
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
    WHERE LEAD_DESCRIPTION = 'ONAIR INCUBATION' AND XDSPRESAGESCOREGROUP3 IS NOT NULL
    GROUP BY 1
)
SELECT
     COALESCE(d.sg, t.sg)                          AS SCOREGROUP
    ,COALESCE(d.n, 0)                              AS DEFAULT_POOL
    ,COALESCE(t.n, 0)                              AS TOPUP_POOL
    ,COALESCE(d.n, 0) + COALESCE(t.n, 0)           AS COMBINED
    ,15400                                         AS QUOTA
    ,GREATEST(15400 - (COALESCE(d.n,0) + COALESCE(t.n,0)), 0) AS STILL_SHORT
FROM d FULL OUTER JOIN t ON d.sg = t.sg
ORDER BY 1;


-- ============================================================================
-- 4. Leads that fall through BOTH pools
-- ============================================================================
-- The default pool inner-joins ACCOUNT_DATA_MODEL_OUTPUT; the incubation pool
-- only takes IDs absent from IGNITION_ONAIR. Anything in IGNITION_ONAIR without
-- an account-model row is in neither. With the book 55,866 short, it is worth
-- knowing whether that gap is hiding usable supply.
SELECT COUNT(*) AS IN_ONAIR_BUT_NO_ACCOUNT_MODEL
FROM DATAWAREHOUSE.IGNITION_DISTRIBUTION.IGNITION_ONAIR a
WHERE NOT EXISTS (
    SELECT 1 FROM DATAWAREHOUSE.DW_XDS.ACCOUNT_DATA_MODEL_OUTPUT b
    WHERE a.IDENTIFIERNUMBER = b.IDNO
);

-- And how many of those would have scored 650+ anyway:
SELECT COUNT(*) AS UNREACHABLE_650_PLUS
FROM DATAWAREHOUSE.IGNITION_DISTRIBUTION.IGNITION_ONAIR a
JOIN DATAWAREHOUSE.DW_XDS.CREDITRISK c ON a.IDENTIFIERNUMBER = c.IDNO
WHERE NOT EXISTS (
    SELECT 1 FROM DATAWAREHOUSE.DW_XDS.ACCOUNT_DATA_MODEL_OUTPUT b
    WHERE a.IDENTIFIERNUMBER = b.IDNO
)
AND TRY_TO_NUMBER(c.SCORE3) >= 650;


-- ============================================================================
-- 5. Confirm the two pools really are disjoint
-- ============================================================================
-- The plan relies on this: the incubation table is built WHERE NOT EXISTS in
-- IGNITION_ONAIR and the default table is built FROM it, so no ID should appear
-- in both. Expect 0. Anything else means the top-up run can re-issue a lead the
-- base run already sent, and the design needs an explicit dedupe.
SELECT COUNT(*) AS IDS_IN_BOTH_POOLS
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT d
JOIN DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT t
  ON d.IDENTIFIERNUMBER = t.IDENTIFIERNUMBER;
