-- Grants for the Temp Upload → Remove duplicates tab.
-- Run as ACCOUNTADMIN. The app connects as SVC_VERCEL_APP_ROLE.

-- The staging table the scan writes into and the tab reads back.
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD_DUPES
  TO ROLE SVC_VERCEL_APP_ROLE;

-- TRUNCATE is not covered by INSERT — it needs OWNERSHIP, or DELETE plus the
-- app switching to DELETE FROM. Simplest is to let the role own the table:
GRANT OWNERSHIP ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD_DUPES
  TO ROLE SVC_VERCEL_APP_ROLE COPY CURRENT GRANTS;
-- If you would rather not transfer ownership, say so and the route can use
-- DELETE FROM instead of TRUNCATE — same effect here, and DELETE is grantable.

-- The bridge procedure. Take the real signature from SHOW if this errors;
-- four VARCHARs is the shape the calls use.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_FROM_SQLSERVER(VARCHAR, VARCHAR, VARCHAR, VARCHAR)
  TO ROLE SVC_VERCEL_APP_ROLE;

SHOW PROCEDURES LIKE 'SP_SYNC_FROM_SQLSERVER'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;
-- Read the "arguments" column and use that signature if it differs.

-- Verify from the app's own session rather than a worksheet:
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_FROM_SQLSERVER
