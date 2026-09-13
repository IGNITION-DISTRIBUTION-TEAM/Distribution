-- The queries behind the Dialler report (Reporting → Distribution → Dialler).
--
-- Source of every figure on that page:
--   DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
--
-- Two things about this view drive everything below:
--
--   * It is PRE-AGGREGATED. LEADS is a measure, not a row count — so every
--     figure is SUM(LEADS), never COUNT(*). The "ROWS" tile is COUNT(*) and is
--     deliberately a different number: it counts view rows, not leads.
--   * Intraday lives in TIME_BUCKET_30MIN, separate from CALL_START_TIME. The
--     single-day views bucket on that column, shifted +2 hours for SAST; the
--     multi-day views bucket on CALL_START_TIME as a date.
--
-- CAMPAIGNS COME THROUGH THE MAPPING, NOT BY NAME. This used to say the report
-- passed the SilverSurfer titles from its picker straight into CAMPAIGN_NAME,
-- which is a YAXXA name — so it matched only where the two systems happened to
-- spell a campaign identically. That was fixed: the picker now sends
-- SilverSurfer campaign IDS, and the route translates them through
-- DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP into Yaxxa names.
-- Section 0 is that translation. No campaign selected sends no predicate at
-- all, so the whole book is returned.
--
-- Replace the WHERE below to match what the report sends. The route builds it
-- as:
--     WHERE [TRIM(UPPER(CAMPAIGN_NAME)) IN (...) AND]
--       CALL_START_TIME BETWEEN '<start>' AND '<end>'
--       [AND CALL_STATUS IN (...)]
-- with the campaign and status predicates omitted entirely when nothing is
-- selected. The comparison is trimmed and upper-cased on both sides, because
-- nothing guarantees this view spells a name the way CAMPAIGN_MASTER does.
--
-- Credit scores are NOT in this file — they cannot be joined to a view with no
-- id on it. See scripts/dialler/02-credit-scores.sql.


-- ============================================================================
-- 0. Selected campaigns → the Yaxxa names the filter uses
--    What the route runs before anything else, given the ids from the picker.
-- ============================================================================
WITH SEL AS (SELECT * FROM VALUES ('608'), ('11204') AS v(SS_CAMPAIGNID))
SELECT s.SS_CAMPAIGNID,
       m.YAXXA_CAMPAIGNID,
       IFNULL(NULLIF(TRIM(y.CAMP_NAME), ''), m.YAXXA_NAME) AS YAXXA_NAME
  FROM SEL s
  LEFT JOIN DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP m
         ON m.SS_CAMPAIGNID = s.SS_CAMPAIGNID
  LEFT JOIN DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER y
         ON CAST(y.CAMP_ID AS VARCHAR) = m.YAXXA_CAMPAIGNID
 ORDER BY s.SS_CAMPAIGNID, YAXXA_NAME;
-- A row with a NULL YAXXA_CAMPAIGNID is a campaign nobody has mapped. Its
-- activity is absent from every figure below, and the report says so.


-- ============================================================================
-- 1. The stat tiles
-- ============================================================================
SELECT
    SUM(LEADS)                        AS TOTAL_LEADS,
    COUNT(*)                          AS TOTAL_ROWS,
    COUNT(DISTINCT CALL_START_TIME)   AS DISTINCT_DAYS,
    COUNT(DISTINCT CAMPAIGN_NAME)     AS DISTINCT_CAMPAIGNS,
    -- ZERO IS THE UNSCORED SENTINEL, not a score of nought. This was a bare
    -- AVG(SCORE), which averaged every unscored lead in as a zero and
    -- understated the tile. The count comes back so the exclusion is visible.
    AVG(IFF(SCORE > 0, SCORE, NULL))  AS AVG_SCORE,
    COUNT_IF(NVL(SCORE, 0) = 0)       AS UNSCORED_ROWS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21';


-- ============================================================================
-- 2. The time chart — MULTI-DAY range
-- ============================================================================
SELECT
    TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS BUCKET,
    SUM(LEADS)                             AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21'
GROUP BY 1
ORDER BY 1;


-- ============================================================================
-- 2b. The time chart — SINGLE DAY (30-minute slots, +2h for SAST)
-- ============================================================================
SELECT
    TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS BUCKET,
    SUM(LEADS)                                              AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-21' AND '2026-08-21'
GROUP BY 1
ORDER BY 1;


-- ============================================================================
-- 3. Call status breakdown
-- ============================================================================
SELECT
    COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(none)') AS CALL_STATUS,
    SUM(LEADS)                                        AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21'
GROUP BY 1
ORDER BY LEADS DESC NULLS LAST;


-- ============================================================================
-- 4. By campaign
-- ============================================================================
SELECT
    CAMPAIGN_NAME,
    SUM(LEADS) AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21'
GROUP BY 1
ORDER BY LEADS DESC NULLS LAST;


-- ============================================================================
-- 5. The score group heatgrid — MULTI-DAY
-- ============================================================================
SELECT
    COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
    TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD')           AS DAY,
    SUM(LEADS)                                       AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21'
GROUP BY 1, 2
ORDER BY 1, 2;


-- ============================================================================
-- 5b. The score group heatgrid — SINGLE DAY (30-minute slots)
-- ============================================================================
SELECT
    COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)')        AS SCOREGROUP,
    TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS DAY,
    SUM(LEADS)                                              AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-21' AND '2026-08-21'
GROUP BY 1, 2
ORDER BY 1, 2;


-- ============================================================================
-- 6. Checks worth running before trusting the tiles
-- ============================================================================

-- 6a. Is CALL_START_TIME day-grain or a timestamp?
--     The DISTINCT_DAYS tile is COUNT(DISTINCT CALL_START_TIME). That is only
--     "days" if the column holds dates. If it carries a time component, the tile
--     counts distinct timestamps and overstates the day count — which would also
--     understate AVG / DAY everywhere it is derived. The presence of a separate
--     TIME_BUCKET_30MIN column suggests day-grain, but confirm it.
SELECT
    COUNT(DISTINCT CALL_START_TIME)                        AS DISTINCT_RAW,
    COUNT(DISTINCT TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD')) AS DISTINCT_DAYS,
    MIN(CALL_START_TIME)                                   AS EARLIEST,
    MAX(CALL_START_TIME)                                   AS LATEST
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21';
-- DISTINCT_RAW > DISTINCT_DAYS means the tile is wrong.

-- 6b. Is SCOREGROUP populated here? It is empty in the leads-loaded table, where
--     the Distributed report now derives a band from SCORE instead. If this
--     returns mostly '(none)', the Dialler heatgrid needs the same treatment.
SELECT
    COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
    COUNT(*)   AS N_ROWS,
    SUM(LEADS) AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-01' AND '2026-08-21'
GROUP BY 1
ORDER BY LEADS DESC NULLS LAST;

-- 6c. Does the +2h SAST shift land the busy hours where you expect? If the view
--     is already local time, this shift is double-counting and the intraday
--     chart is offset by two hours.
SELECT
    TO_CHAR(TIME_BUCKET_30MIN, 'HH24:MI')                   AS RAW_SLOT,
    TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS SHIFTED_SLOT,
    SUM(LEADS)                                              AS LEADS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS
WHERE CALL_START_TIME BETWEEN '2026-08-21' AND '2026-08-21'
GROUP BY 1, 2
ORDER BY LEADS DESC NULLS LAST
LIMIT 10;
