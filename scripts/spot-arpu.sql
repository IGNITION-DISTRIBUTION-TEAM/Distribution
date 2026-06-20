-- Grants so the app's service role can load the ARPU file into
-- SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES.
--
-- The app derives the table's columns from the uploaded file's header row and
-- creates the table on first upload if it doesn't exist, then MERGEs rows on
-- the configured key column(s). The role therefore needs USAGE on the database
-- and schema, CREATE TABLE on the schema, and full DML on the table.
--
-- Run as a role that can grant these (e.g. the schema owner / SECURITYADMIN).
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
-- the "Last 10 files loaded" panel. It creates this table on first use; grant
-- DML only if it pre-exists and isn't owned by the app role:
GRANT SELECT, INSERT
  ON TABLE SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES_UPLOADS
  TO ROLE SVC_VERCEL_APP_ROLE;
