-- Grants so the app's service role can load the ARPU file into
-- SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES, and read/write its upload audit log in
-- DATAWAREHOUSE.LEADS_DISTRIBUTION.ARPU_DASHBOARD_FEES_UPLOADS.
--
-- The data table is Hevo-managed; the app MERGEs rows on the configured key
-- column(s), so the role needs USAGE on SPOT_DW / SPOT_SFTP and full DML on the
-- table. The audit log lives in a separate schema (LEADS_DISTRIBUTION); the app
-- creates it on first use, so the role needs USAGE + CREATE TABLE there too.
--
-- Run as a role that owns (or has CREATE TABLE on) DATAWAREHOUSE.LEADS_DISTRIBUTION
-- and can issue these grants -- typically the schema owner. SECURITYADMIN alone
-- cannot run the CREATE TABLE below.
-- Replace SVC_VERCEL_APP_ROLE if the app authenticates as a different role.

-- 1) Data table (SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES, Hevo-managed).
GRANT USAGE ON DATABASE SPOT_DW            TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   SPOT_DW.SPOT_SFTP   TO ROLE SVC_VERCEL_APP_ROLE;

-- The table already exists and is NOT owned by the app role, so grant DML on it:
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES
  TO ROLE SVC_VERCEL_APP_ROLE;

-- 2) Upload audit log (DATAWAREHOUSE.LEADS_DISTRIBUTION.ARPU_DASHBOARD_FEES_UPLOADS).
-- The app writes one row per load and reads the last 10 for the "Last 10 files
-- loaded" panel. It creates this table on first use via CREATE TABLE IF NOT
-- EXISTS, but we create it here too so the GRANT below has a target (granting on
-- a not-yet-existing table errors with "does not exist or not authorized").
-- The definition must match ensureHistoryTable() in app/api/spot/arpu-upload/route.ts.
GRANT USAGE ON DATABASE DATAWAREHOUSE                     TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.LEADS_DISTRIBUTION   TO ROLE SVC_VERCEL_APP_ROLE;
GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION TO ROLE SVC_VERCEL_APP_ROLE;

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.ARPU_DASHBOARD_FEES_UPLOADS (
  FILE_NAME    VARCHAR,
  ROWS_PARSED  NUMBER,
  ROWS_MERGED  NUMBER,
  INSERTED     NUMBER,
  UPDATED      NUMBER,
  UPLOADED_BY  VARCHAR,
  UPLOADED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Grant DML in case the table is owned by the role running this script rather
-- than the app role (a table the app role creates itself is already owned):
GRANT SELECT, INSERT
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.ARPU_DASHBOARD_FEES_UPLOADS
  TO ROLE SVC_VERCEL_APP_ROLE;
