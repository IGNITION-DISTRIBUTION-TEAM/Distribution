-- Grants so the app's service role can load the ARPU file into
-- SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES.
--
-- The app derives the table's columns from the uploaded file's header row and
-- creates the table on first upload if it doesn't exist, then MERGEs rows on
-- the configured key column(s). The role therefore needs USAGE on the database
-- and schema, CREATE TABLE on the schema, and full DML on the table.
--
-- Run as a role that owns (or has CREATE TABLE on) SPOT_DW.SPOT_SFTP and can
-- issue these grants -- typically the schema owner. SECURITYADMIN alone cannot
-- run the CREATE TABLE below.
-- Replace SVC_VERCEL_APP_ROLE if the app authenticates as a different role.

GRANT USAGE ON DATABASE SPOT_DW                  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   SPOT_DW.SPOT_SFTP         TO ROLE SVC_VERCEL_APP_ROLE;
GRANT CREATE TABLE ON SCHEMA SPOT_DW.SPOT_SFTP    TO ROLE SVC_VERCEL_APP_ROLE;

-- If the table already exists and is NOT owned by the app role, also grant DML
-- on it (a table the role creates itself is already fully owned):
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The app also writes an upload audit row per load and reads the last 10 for
-- the "Last 10 files loaded" panel. The app creates this table on first use via
-- CREATE TABLE IF NOT EXISTS, but we create it here too so the GRANT below has a
-- target (granting on a not-yet-existing table errors with "does not exist or
-- not authorized"). The definition must match ensureHistoryTable() in
-- app/api/spot/arpu-upload/route.ts.
CREATE TABLE IF NOT EXISTS SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES_UPLOADS (
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
  ON TABLE SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES_UPLOADS
  TO ROLE SVC_VERCEL_APP_ROLE;
