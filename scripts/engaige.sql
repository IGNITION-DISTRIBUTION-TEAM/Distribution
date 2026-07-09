-- Grants for the EngAIge Integration Manager department, which reads/writes
-- these tables in DATAWAREHOUSE.SS_INTEGRATION and calls execute_config_manually.
--
-- Run as a role that can grant on these objects. Replace SVC_VERCEL_APP_ROLE
-- if the app connects as a different role (SNOWFLAKE_ROLE env var).
--
-- These tables are created/owned by the EngAIge platform, not this app, so the
-- app role needs explicit privileges (no CREATE here).

GRANT USAGE ON DATABASE DATAWAREHOUSE                  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.SS_INTEGRATION    TO ROLE SVC_VERCEL_APP_ROLE;

-- Full DML on the config/mapping/assignment tables the UI manages.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.CAMPAIGN_CONFIGS TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.COLUMN_MAPPINGS TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.TASK_ASSIGNMENTS TO ROLE SVC_VERCEL_APP_ROLE;

-- Read + update (cancel) processing history; read the log/queue tables.
GRANT SELECT, UPDATE
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.PROCESSING_HISTORY TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.API_CALL_LOGS TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT
  ON TABLE DATAWAREHOUSE.SS_INTEGRATION.RETRY_QUEUE TO ROLE SVC_VERCEL_APP_ROLE;

-- The "Run test" / "Run now" buttons call this procedure. Adjust the argument
-- signature if the deployed proc differs (VARCHAR, BOOLEAN assumed).
GRANT USAGE
  ON PROCEDURE DATAWAREHOUSE.SS_INTEGRATION.EXECUTE_CONFIG_MANUALLY(VARCHAR, BOOLEAN)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The create-config flow checks source-table existence via INFORMATION_SCHEMA
-- and reads source columns; the app role must be able to see those tables
-- (already covered if it has USAGE on their schemas + SELECT on the tables).
