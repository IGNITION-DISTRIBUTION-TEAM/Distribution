-- Why do batches show 0 in SilverSurfer when their leads are demonstrably there?
--
-- Distribution -> Batch upload check compares each HLL batch's row count against
-- SilverSurfer's count for the same BATCHNAME. On real data that comparison is
-- not usable, and these queries are to find out why before anything acts on it.
--
-- THE CONTRADICTION. One run showed, for a single batch:
--
--     In HLL           13,227
--     In SilverSurfer       0      <- joined on BATCHNAME
--     Missing by ID     2,627      <- NOT EXISTS on IDNUMBER
--
-- Those cannot both be true. If SilverSurfer really held none of that batch,
-- all 13,227 would be missing; matching on ID number finds 10,600 of them
-- already present. So THE LEADS ARRIVED AND THE BATCH NAME DID NOT. Eleven of
-- twelve short batches showed the same shape.
--
-- WHY IT MATTERS. The intended behaviour is "a batch is missing -> reload the
-- batch". If "SilverSurfer count = 0" fires on batches that actually loaded,
-- reloading them whole would push roughly 29,000 leads of which about 23,900
-- are already in the CRM.
--
-- All three queries are READ-ONLY. Run as the app's role where you can, so the
-- answer reflects what the app can see:
--   USE ROLE SVC_VERCEL_APP_ROLE;


-- ---------------------------------------------------------------------------
-- 1. THE ONE THAT ANSWERS IT
-- ---------------------------------------------------------------------------
-- Take leads from one HLL batch, find them in SilverSurfer BY ID, and ask what
-- batch name SilverSurfer holds for them. Substitute any batch showing 0.
WITH hll AS (
  SELECT IDNUMBER, BATCHNAME
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
   WHERE BATCHNAME = 'EX20261003ONAIR_COLLECTIONS20260903B1'
     AND ESTATUS IS NULL
)
SELECT h.BATCHNAME AS hll_batch,
       d.BATCHNAME AS ss_batch,
       COUNT(*)    AS leads
  FROM hll h
  JOIN DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER s
    ON s.IDNUMBER = h.IDNUMBER
  LEFT JOIN DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS d
    ON d.LEADCUSTOMERID = s.LEADCUSTOMERID
 GROUP BY 1, 2
 ORDER BY leads DESC;

-- Reading the ss_batch column:
--
--   NULL             the detail row is absent, or its batch is never populated.
--                    Then the comparison must count from LEAD_LEADCUSTOMER and
--                    the detail join is itself the bug.
--
--   a DIFFERENT      SilverSurfer transforms the name, or assigns its own. Note
--   string           the transform — once the two can be mapped, batch-level
--                    matching becomes accurate and will catch a genuinely
--                    failed batch that ID matching cannot.
--
--   the SAME string  the data is fine and the summary query's join is wrong.
--                    The cheapest and best outcome.


-- ---------------------------------------------------------------------------
-- 2. Is the detail join one-to-one?
-- ---------------------------------------------------------------------------
-- The comparison already uses COUNT(DISTINCT LEADCUSTOMERID) to survive a
-- fan-out, but if many leads have NO detail row then a batch-name join through
-- that table can never see them, whatever the names say.
SELECT COUNT(*)                                                   AS joined_rows,
       COUNT(DISTINCT s.LEADCUSTOMERID)                           AS distinct_leads,
       SUM(CASE WHEN d.LEADCUSTOMERID IS NULL THEN 1 ELSE 0 END)  AS leads_with_no_detail
  FROM DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER s
  LEFT JOIN DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS d
    ON d.LEADCUSTOMERID = s.LEADCUSTOMERID
 WHERE s.CREATEDONDATE >= DATE_TRUNC('MONTH', CURRENT_DATE());

-- joined_rows > distinct_leads      the join fans out; a plain COUNT(*) would
--                                   have over-counted and made short batches
--                                   read as complete.
-- leads_with_no_detail large        the detail table is not where batch lives.


-- ---------------------------------------------------------------------------
-- 3. What do SilverSurfer's batch names look like at all?
-- ---------------------------------------------------------------------------
-- Worth running even if query 1 settles it. The app pushes BatchName as one of
-- the 39 columns it sends, so leads loaded BY THIS APP should carry the HLL
-- name verbatim. If nothing in this list resembles an HLL batch name, then no
-- batch name has ever round-tripped, which is a larger finding than one screen.
SELECT BATCHNAME, COUNT(*) AS leads
  FROM DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS
 WHERE BATCHNAME IS NOT NULL
   AND BATCHNAME <> ''
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 50;

-- And the same question from the other side, for comparison:
-- SELECT BATCHNAME, COUNT(*) AS leads
--   FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
--  WHERE CAST(CREATEDONDATE AS DATE) >= DATE_TRUNC('MONTH', CURRENT_DATE())
--  GROUP BY 1 ORDER BY 2 DESC LIMIT 50;


-- ---------------------------------------------------------------------------
-- 4. Also worth asking, and not answerable here
-- ---------------------------------------------------------------------------
-- Reloading a batch whole re-sends leads that are already in the CRM — that is
-- inherent to batch-level reloading, not a defect in it. Whether that creates
-- duplicates depends on what drains Upload.TempUpload on the SQL Server side,
-- which is not in this repository. Ask whoever owns the SilverSurfer import
-- whether it de-duplicates before the first real reload.
