-- Grants for the Distribution dashboard's Silver Surfer tab, which runs:
--   TRUNCATE TABLE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD;
--   CALL DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_BATCH_COUNTS_TODAY();
--   SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD;
--
-- Run as a role that can grant on these objects. Replace SVC_VERCEL_APP_ROLE
-- if the app connects as a different role (SNOWFLAKE_ROLE env var).
--
-- NOTE: if SP_SYNC_BATCH_COUNTS_TODAY is an EXECUTE AS CALLER procedure, the
-- app role additionally needs every privilege the procedure body uses
-- (INSERT on TEMP_UPLOAD, SELECT on its source tables). Owner's-rights
-- procedures (the default) need only the grants below.

GRANT USAGE ON DATABASE DATAWAREHOUSE                         TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.DISTRIBUTION_AUTOMATION  TO ROLE SVC_VERCEL_APP_ROLE;

-- SELECT to read the results; DELETE is the privilege that permits TRUNCATE.
GRANT SELECT, DELETE
  ON TABLE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD
  TO ROLE SVC_VERCEL_APP_ROLE;

-- USAGE on the procedure allows CALLing it (grant must match the signature).
GRANT USAGE
  ON PROCEDURE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_BATCH_COUNTS_TODAY()
  TO ROLE SVC_VERCEL_APP_ROLE;
