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
-- Campaigns are matched BY NAME (CAMPAIGN_NAME), not by id. The report passes
-- the campaign titles it shows in the picker. No campaign selected sends no
-- predicate at all, so the whole book is returned.
--
-- Replace the WHERE below to match what the report sends. The report builds it
-- as:
--     WHERE [CAMPAIGN_NAME IN (...) AND]
--       CALL_START_TIME BETWEEN '<start>' AND '<end>'
--       [AND CALL_STATUS IN (...)]
-- with the campaign and status predicates omitted entirely when nothing is
-- selected.


-- ============================================================================
-- 1. The stat tiles
-- ============================================================================
SELECT
    SUM(LEADS)                        AS TOTAL_LEADS,
    COUNT(*)                          AS TOTAL_ROWS,
    COUNT(DISTINCT CALL_START_TIME)   AS DISTINCT_DAYS,
    COUNT(DISTINCT CAMPAIGN_NAME)     AS DISTINCT_CAMPAIGNS,
    AVG(SCORE)                        AS AVG_SCORE
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
