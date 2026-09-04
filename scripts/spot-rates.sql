-- Grants so the app's service role can load the Rates and Airtime Rates files
-- into SPOT_DW.SPOT_SFTP.RATES and SPOT_DW.SPOT_SFTP.AIRTIME_RATES, and
-- read/write their upload audit logs in DATAWAREHOUSE.LEADS_DISTRIBUTION.
--
-- Sibling of scripts/spot-arpu.sql. The difference that matters: the ARPU
-- upload MERGEs, these two REPLACE — they DELETE every row and reload — so
-- DELETE is not optional here, it is the whole mechanism.
--
-- Why DELETE and not TRUNCATE: Snowflake has no grantable TRUNCATE privilege.
-- TRUNCATE TABLE requires OWNERSHIP, and these tables are Hevo-managed, so the
-- app role can never truncate them however this script is run. The route
-- issues DELETE FROM for exactly that reason (the same conclusion
-- app/api/upload/load/route.ts:103-136 already reached).
--
-- Run as a role that owns (or has CREATE TABLE on)
-- DATAWAREHOUSE.LEADS_DISTRIBUTION and can issue these grants -- typically the
-- schema owner. SECURITYADMIN alone cannot run the CREATE TABLEs below.
-- Replace SVC_VERCEL_APP_ROLE if the app authenticates as a different role.

-- ---------------------------------------------------------------------------
-- 0) Confirm both targets exist and have the columns the app expects.
-- The app REFUSES to create these tables (unlike the ARPU route, which would
-- silently create a phantom all-VARCHAR table on a typo), so if either of
-- these returns nothing, fix that before going further.
-- ---------------------------------------------------------------------------
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
  FROM SPOT_DW.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'SPOT_SFTP'
   AND TABLE_NAME IN ('RATES', 'AIRTIME_RATES')
 ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- The app writes RATES.(TYPE, RATE, FLAT) and AIRTIME_RATES.(RECIPIENT_NAME,
-- AIRTIME_RATE), plus a synthesized __HEVO_ID. Every other column is left
-- NULL, so any of them marked IS_NULLABLE = 'NO' above will fail the insert.
-- Check that before the first load rather than after:
SELECT TABLE_NAME, COLUMN_NAME
  FROM SPOT_DW.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'SPOT_SFTP'
   AND TABLE_NAME IN ('RATES', 'AIRTIME_RATES')
   AND IS_NULLABLE = 'NO'
   AND COLUMN_NAME NOT IN ('TYPE', 'RATE', 'FLAT', 'RECIPIENT_NAME', 'AIRTIME_RATE', '__HEVO_ID')
 ORDER BY TABLE_NAME, COLUMN_NAME;

-- ---------------------------------------------------------------------------
-- 1) Data tables (Hevo-managed, not owned by the app role).
-- ---------------------------------------------------------------------------
GRANT USAGE ON DATABASE SPOT_DW           TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   SPOT_DW.SPOT_SFTP  TO ROLE SVC_VERCEL_APP_ROLE;

-- DELETE is load-bearing: without it the replace cannot run at all.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE SPOT_DW.SPOT_SFTP.RATES
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE SPOT_DW.SPOT_SFTP.AIRTIME_RATES
  TO ROLE SVC_VERCEL_APP_ROLE;

-- ---------------------------------------------------------------------------
-- 2) Upload audit logs, one per process.
-- The app creates these on first use via CREATE TABLE IF NOT EXISTS, but they
-- are created here too so the GRANTs below have a target (granting on a
-- not-yet-existing table errors with "does not exist or not authorized").
-- These definitions must match ensureHistoryTable() in
-- app/api/spot/upload/[process]/route.ts.
-- ---------------------------------------------------------------------------
GRANT USAGE ON DATABASE DATAWAREHOUSE                        TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.LEADS_DISTRIBUTION      TO ROLE SVC_VERCEL_APP_ROLE;
GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION TO ROLE SVC_VERCEL_APP_ROLE;

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.RATES_UPLOADS (
  FILE_NAME     VARCHAR,
  ROWS_PARSED   NUMBER,
  ROWS_LOADED   NUMBER,
  ROWS_REPLACED NUMBER,
  UPLOADED_BY   VARCHAR,
  UPLOADED_AT   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.AIRTIME_RATES_UPLOADS (
  FILE_NAME     VARCHAR,
  ROWS_PARSED   NUMBER,
  ROWS_LOADED   NUMBER,
  ROWS_REPLACED NUMBER,
  UPLOADED_BY   VARCHAR,
  UPLOADED_AT   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- ROWS_REPLACED is the row count the target held BEFORE the load. On a
-- destructive replace it is the only record of what was there, so it is worth
-- keeping even though nothing in the UI needs it to load a file.
GRANT SELECT, INSERT
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.RATES_UPLOADS
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.AIRTIME_RATES_UPLOADS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- ---------------------------------------------------------------------------
-- 3) Confirm, from the app's own role rather than this worksheet.
-- A worksheet describes YOUR access, not the app's. Check
-- /api/distribution/snowflake-identity and confirm session.role is
-- SVC_VERCEL_APP_ROLE -- lib/snowflake.ts falls back to ACCOUNTADMIN when
-- SNOWFLAKE_ROLE is unset, which would make everything above moot.
-- ---------------------------------------------------------------------------
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;
