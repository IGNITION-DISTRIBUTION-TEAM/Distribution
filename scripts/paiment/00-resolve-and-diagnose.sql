/* =============================================================================
   Billing product mapping — resolve the table, then find out why the overrides
   are not applying
   -----------------------------------------------------------------------------
   Three test sales still report ON AIR FIBRE after the override columns were
   added and the full-history table rebuilt:

     MY-THEO-FIBRE1  DSTV Explora Ultra Standalone With R5000 Life Cover +
                     Decoder Protection R239 PM x24 Months
     MY-THEO-FIBRE2  ... @ R289 PM x24 Months
     MY-THEO-FIBRE3  DSTV Explora Ultra Installed ... @ R279 PM x24 Months

   ALL THREE ARE IN THE 41-PRODUCT WORKBOOK as exact strings, all DISTRIBUTION /
   ONAIR. The sheet has 41 rows, one channel, one brand and no duplicates. So
   the source list is not the problem and the fault is downstream of it.

   ONE HYPOTHESIS IS ALREADY RULED OUT BY THE EVIDENCE. If the override columns
   held '' rather than NULL, coalesce(pg.brand_override, cc.brand) would return
   '' and the brand would render BLANK. It renders ON AIR FIBRE, so the override
   really is NULL for those rows — either no PG row matched, or the 41 were
   never loaded.

   What is left, in the order to test:

     §2  the full-history TABLE is stale — the view is right and the table was
         rebuilt BEFORE the three test sales were placed. START HERE: it costs
         one query and it is the most likely answer given the timeline.
     §3  the 41 overrides were never written
     §4  the join misses on characters that trim(upper()) does not normalise

   Sections 1-5 are READ-ONLY. Nothing here writes.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — what is actually underneath the view?

   The app writes to the TABLE, not the view, and the table's name is a
   documented assumption in lib/billing-mappings.ts until this section confirms
   it. Whatever comes back here goes into PRODUCT_MAPPING.table and
   PRODUCT_MAPPING.cols.
-------------------------------------------------------------------------------- */

SELECT GET_DDL('VIEW', 'DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS') AS VIEW_DDL;

-- 1b. The same question answered structurally, in case the DDL is long.
SELECT REFERENCED_DATABASE || '.' || REFERENCED_SCHEMA || '.' || REFERENCED_OBJECT_NAME
         AS BASE_OBJECT,
       REFERENCED_OBJECT_DOMAIN AS KIND
  FROM SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES
 WHERE REFERENCING_SCHEMA = 'BI'
   AND REFERENCING_OBJECT_NAME = 'VW_BI_BILLING_PRODUCTGROUPS';

/* ACCOUNT_USAGE LAGS BY UP TO THREE HOURS and needs a role that can read it.
   If 1b is empty or refused, 1a is authoritative — read the FROM clause. */

-- 1c. The real column names on whatever 1a/1b named. The view exposes the name
--     column as PRODUCT; the workbook calls it PRODUCTNAME. The base table may
--     use either, and the app needs the base table's spelling.
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'BI'
   AND TABLE_NAME ILIKE '%PRODUCTGROUP%'
 ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- 1d. Is the base object a TABLE (writable) or another VIEW (not)? If it is a
--     view all the way down, the app cannot write here and the decision to
--     write into BI has to be revisited.
SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT, BYTES, LAST_ALTERED
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = 'BI'
   AND TABLE_NAME ILIKE '%PRODUCTGROUP%';

/* LAST_ALTERED IS WORTH READING. If it moves every day at the same time, this
   table is reloaded from a file — which is the known risk of the app writing
   here directly, and the reason every write is mirrored to an audit log in the
   app's own schema. Section 5 detects the damage if it happens. */


/* -----------------------------------------------------------------------------
   SECTION 2 — RUN THIS FIRST. Is the full-history TABLE just stale?

   BI_SANCTION_BILLINGDATA_FULL_HISTORY is a TABLE built from
   VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY. The thread's timeline is: override
   columns added -> table rebuilt -> THEN the three test sales were placed. A
   row that arrived after the rebuild is not in the table yet.

   If the view says DISTRIBUTION/ONAIR and the table says ON AIR FIBRE, THERE IS
   NO LOGIC BUG. The mapping works and the table needs rebuilding. Stop here.
-------------------------------------------------------------------------------- */

SELECT 'view (live logic)' AS SOURCE, ORDERREFERENCE, PRODUCTNAME, CAMPAIGNNAME, CHANNEL, BRAND
  FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY
 WHERE ORDERREFERENCE IN ('MY-THEO-FIBRE1', 'MY-THEO-FIBRE2', 'MY-THEO-FIBRE3')
UNION ALL
SELECT 'table (what reporting reads)', ORDERREFERENCE, PRODUCTNAME, CAMPAIGNNAME, CHANNEL, BRAND
  FROM DATAWAREHOUSE.BI_SANCTION.BI_SANCTION_BILLINGDATA_FULL_HISTORY
 WHERE ORDERREFERENCE IN ('MY-THEO-FIBRE1', 'MY-THEO-FIBRE2', 'MY-THEO-FIBRE3')
 ORDER BY ORDERREFERENCE, SOURCE;

/* HOW TO READ IT

   view DISTRIBUTION/ONAIR + table ON AIR FIBRE  -> stale table. Rebuild it.
   view ON AIR FIBRE                             -> the override is not being
                                                    picked up. Go to §3.
   no rows from the view at all                  -> the sale is not in the
                                                    source yet; nothing to fix
                                                    here, wait for the feed.

   If ORDERREFERENCE is not a column on these objects, substitute whatever the
   policy number is called — the point is to fetch the same three sales twice. */


/* -----------------------------------------------------------------------------
   SECTION 3 — were the 41 overrides ever written?

   Straight at the mapping. NULL in both override columns is hypothesis 2
   confirmed, and 02-load-41-products.sql is the fix.
-------------------------------------------------------------------------------- */

SELECT PRODUCT,
       CHANNEL_OVERRIDE,
       BRAND_OVERRIDE,
       CASE
         WHEN CHANNEL_OVERRIDE IS NULL THEN 'NULL - falls back to campaign'
         WHEN TRIM(CHANNEL_OVERRIDE) = '' THEN 'EMPTY STRING - reports blank, worse than null'
         ELSE 'set'
       END AS CHANNEL_STATE
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS
 WHERE UPPER(PRODUCT) LIKE '%EXPLORA ULTRA%'
 ORDER BY PRODUCT;

-- 3b. Across the whole mapping: how many rows carry an override at all?
SELECT COUNT(*)                                                        AS PRODUCTS,
       COUNT_IF(CHANNEL_OVERRIDE IS NOT NULL)                          AS WITH_CHANNEL_OVERRIDE,
       COUNT_IF(BRAND_OVERRIDE IS NOT NULL)                            AS WITH_BRAND_OVERRIDE,
       COUNT_IF(TRIM(IFNULL(CHANNEL_OVERRIDE, 'x')) = '')              AS CHANNEL_EMPTY_STRING,
       COUNT_IF(TRIM(IFNULL(BRAND_OVERRIDE, 'x')) = '')                AS BRAND_EMPTY_STRING
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS;

/* WITH_BRAND_OVERRIDE of 0 means the 41 never landed.
   Any *_EMPTY_STRING above 0 is its own bug: coalesce treats '' as a value, so
   those products report a BLANK brand rather than falling back to the campaign.
   The app writes NULL for a cleared override precisely to avoid that. */


/* -----------------------------------------------------------------------------
   SECTION 4 — does the join actually match?

   trim(upper()) normalises case and OUTER whitespace only. An internal double
   space, a non-breaking space or a missing "@" all fail silently, and the
   workbook does contain one such row ("... x24 Months  (1Click)", two spaces).
-------------------------------------------------------------------------------- */

WITH SOLD AS (
    SELECT DISTINCT PRODUCTNAME
      FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY
     WHERE ORDERREFERENCE IN ('MY-THEO-FIBRE1', 'MY-THEO-FIBRE2', 'MY-THEO-FIBRE3')
)
SELECT s.PRODUCTNAME                                       AS SOLD_AS,
       p.PRODUCT                                           AS MAPPED_AS,
       IFF(p.PRODUCT IS NULL, 'NO MATCH', 'matched')       AS VERDICT,
       LENGTH(s.PRODUCTNAME)                               AS SOLD_LEN,
       LENGTH(p.PRODUCT)                                   AS MAPPED_LEN
  FROM SOLD s
  LEFT JOIN DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS p
    ON TRIM(UPPER(p.PRODUCT)) = TRIM(UPPER(s.PRODUCTNAME));

/* VERDICT 'NO MATCH' with a MAPPED_LEN you can see elsewhere means the two
   strings differ by characters trim/upper cannot reconcile. Different lengths
   for what looks like the same name is the tell. */

-- 4b. Near misses for anything that failed: same first 40 characters, different
--     string. This is where a missing "@" or a doubled space shows up.
WITH SOLD AS (
    SELECT DISTINCT PRODUCTNAME
      FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY
     WHERE ORDERREFERENCE IN ('MY-THEO-FIBRE1', 'MY-THEO-FIBRE2', 'MY-THEO-FIBRE3')
)
SELECT s.PRODUCTNAME AS SOLD_AS, p.PRODUCT AS NEAR_MISS_IN_MAPPING
  FROM SOLD s
  JOIN DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS p
    ON UPPER(LEFT(p.PRODUCT, 40)) = UPPER(LEFT(s.PRODUCTNAME, 40))
 WHERE TRIM(UPPER(p.PRODUCT)) <> TRIM(UPPER(s.PRODUCTNAME));

-- 4c. Mapping rows that can never join, whatever is sold: internal double
--     spaces or invisible characters. The app refuses to save these; this
--     finds the ones already there.
SELECT PRODUCT,
       LENGTH(PRODUCT)                                     AS CHARS,
       IFF(PRODUCT LIKE '%  %', 'double space', '')        AS DOUBLE_SPACE,
       IFF(PRODUCT <> TRIM(PRODUCT), 'outer space', '')    AS OUTER_SPACE,
       IFF(CONTAINS(PRODUCT, CHAR(160)), 'nbsp', '')       AS NBSP
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS
 WHERE PRODUCT LIKE '%  %'
    OR PRODUCT <> TRIM(PRODUCT)
    OR CONTAINS(PRODUCT, CHAR(160))
 ORDER BY PRODUCT;

-- 4d. THE REVENUE ONE. Two mapping rows for one product name double that
--     product's billing rows, because the fact table LEFT JOINs to this. Empty
--     is the answer you want.
SELECT TRIM(UPPER(PRODUCT)) AS PRODUCT_KEY,
       COUNT(*)             AS ROWS_FOUND,
       LISTAGG(DISTINCT IFNULL(BRAND_OVERRIDE, '(none)'), ' | ') AS BRAND_OVERRIDES
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS
 GROUP BY 1 HAVING COUNT(*) > 1
 ORDER BY ROWS_FOUND DESC;


/* -----------------------------------------------------------------------------
   SECTION 5 — has anything overwritten what the app saved?

   The app writes into the BI table directly and mirrors every change to
   TSK_BILLING_MAPPING_AUDIT in its own schema, which a BI reload cannot touch.
   This compares the two. Rows returned mean something outside the app changed
   the mapping since the app last wrote it.

   Empty until the app has been used, and empty is the healthy state.
-------------------------------------------------------------------------------- */

WITH LAST AS (
    SELECT PRODUCT_NAME, ACTION, AFTER_JSON,
           ROW_NUMBER() OVER (PARTITION BY TRIM(UPPER(PRODUCT_NAME))
                              ORDER BY CHANGED_AT DESC, AUDIT_ID DESC) AS RN
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_BILLING_MAPPING_AUDIT
)
SELECT l.PRODUCT_NAME,
       PARSE_JSON(l.AFTER_JSON):channelOverride::VARCHAR AS EXPECTED_CHANNEL,
       p.CHANNEL_OVERRIDE                                AS ACTUAL_CHANNEL,
       PARSE_JSON(l.AFTER_JSON):brandOverride::VARCHAR   AS EXPECTED_BRAND,
       p.BRAND_OVERRIDE                                  AS ACTUAL_BRAND
  FROM LAST l
  LEFT JOIN DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS p
    ON TRIM(UPPER(p.PRODUCT)) = TRIM(UPPER(l.PRODUCT_NAME))
 WHERE l.RN = 1
   AND l.ACTION <> 'delete'
   AND (IFNULL(PARSE_JSON(l.AFTER_JSON):channelOverride::VARCHAR, '~') <> IFNULL(p.CHANNEL_OVERRIDE, '~')
     OR IFNULL(PARSE_JSON(l.AFTER_JSON):brandOverride::VARCHAR, '~')   <> IFNULL(p.BRAND_OVERRIDE, '~'))
 ORDER BY l.PRODUCT_NAME;

/* Anything here is replayable: AFTER_JSON holds the full intended row, so the
   mapping can be restored from the log rather than re-keyed from a spreadsheet.
   The Paiment screen shows the same count as a banner. */


/* -----------------------------------------------------------------------------
   SECTION 6 — the wider question this all points at

   Only two things in the whole workbook: DISTRIBUTION and ONAIR, across 41
   products. If that stays true, a per-product override list will keep growing
   by hand forever and every new DSTV deal will be wrong until someone notices.

   The durable fix is upstream, and the thread already says so: campaigns
   structured so that one campaign does not need different channels depending on
   the product. This mapping is the workaround, not the answer. Worth revisiting
   once the immediate reporting issue is closed.

   Meanwhile — products sold recently that have NO mapping row at all. These are
   the next ones to be wrong.
-------------------------------------------------------------------------------- */

SELECT fs.PRODUCTNAME,
       COUNT(*) AS SALES,
       MAX(fs.CAMPAIGNNAME) AS AN_EXAMPLE_CAMPAIGN
  FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY fs
  LEFT JOIN DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS p
    ON TRIM(UPPER(p.PRODUCT)) = TRIM(UPPER(fs.PRODUCTNAME))
 WHERE p.PRODUCT IS NULL
   AND fs.PRODUCTNAME IS NOT NULL
 GROUP BY fs.PRODUCTNAME
 ORDER BY SALES DESC
 LIMIT 100;
