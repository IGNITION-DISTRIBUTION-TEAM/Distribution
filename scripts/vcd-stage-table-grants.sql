-- Grants for the file upload into
--   DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
--
-- The table exists — you confirmed that — so this is the other half of the
-- message Snowflake refuses to distinguish: the app's role cannot see it.
--
-- Note the SCHEMA. This is DATAWAREHOUSE.DISTRIBUTION, which is NOT the schema
-- the app has been working in all along (DISTRIBUTION_DATA_APPLICATION and
-- DISTRIBUTION_AUTOMATION). Objects in DISTRIBUTION are read by stored
-- procedures running as their own owner, so the app has never needed access to
-- it directly and most likely has none at all.
--
-- Run as ACCOUNTADMIN.


-- 1. Confirm which it is. As ACCOUNTADMIN this will find the table if it exists;
--    if this returns nothing, the name is wrong rather than the grant missing.
SHOW TABLES LIKE 'TM_VCD_VCCVMDISTRIBUTION' IN DATABASE DATAWAREHOUSE;

-- What the app can currently reach in that schema — expect little or nothing.
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;


-- 2. The grants.
--    USAGE on the schema first: without it every object inside is invisible
--    however it is granted, and the error looks identical to a missing table.
GRANT USAGE ON DATABASE DATAWAREHOUSE TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION TO ROLE SVC_VERCEL_APP_ROLE;

-- Read for the column mapping and the preview; INSERT for the load itself;
-- DELETE because the load empties the table before refilling it.
GRANT SELECT, INSERT, DELETE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
  TO ROLE SVC_VERCEL_APP_ROLE;


/* WHY DELETE AND NOT TRUNCATE
   Snowflake has no TRUNCATE privilege — TRUNCATE TABLE requires OWNERSHIP. A
   staging table owned by another role can therefore never be truncated by this
   app, no matter how many grants it holds. The upload now tries TRUNCATE first
   and falls back to DELETE when it is refused, so DELETE is enough and
   ownership does not have to move. The outcome is the same: the table is
   emptied and refilled from the file.

   If you would rather it truncate — cheaper on a large table, and it resets the
   clustering metadata — hand over ownership instead and the fallback never
   fires:

     GRANT OWNERSHIP ON TABLE
       DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       TO ROLE SVC_VERCEL_APP_ROLE COPY CURRENT GRANTS;
*/


-- 3. Verify from the app's own session, not a worksheet — a worksheet describes
--    your access, not the app's:
--
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
--
-- Then retry the upload. It should go straight from preview to column mapping.


-- 4. Worth checking while you are here: any OTHER campaign whose staging table
--    lives in a schema the app may not reach. Same failure waiting to happen.
SELECT DISTINCT
       SPLIT_PART(UPLOAD_TARGET_TABLE, '.', 1) AS DB,
       SPLIT_PART(UPLOAD_TARGET_TABLE, '.', 2) AS SCHEMA_NAME,
       COUNT(*)                                AS CONFIGS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIGS
WHERE UPLOAD_TARGET_TABLE IS NOT NULL AND UPLOAD_TARGET_TABLE <> ''
GROUP BY 1, 2
ORDER BY 1, 2;
