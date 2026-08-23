-- Grants for the distribution export (step 4 download / step 5 email).
--
-- Fixes: SQL compilation error ... Object
--   'DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS' does not exist or not
--   authorized.
--
-- Replace SVC_VERCEL_APP_ROLE with the role the app connects as (the
-- SNOWFLAKE_ROLE env var) if it differs. Run as a role that can grant on
-- DATAWAREHOUSE.SILVERSURFER — typically the schema owner, ACCOUNTADMIN, or a
-- role with MANAGE GRANTS.

GRANT USAGE ON DATABASE DATAWAREHOUSE              TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.SILVERSURFER TO ROLE SVC_VERCEL_APP_ROLE;

-- The export reads these two:
GRANT SELECT ON TABLE DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER        TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS TO ROLE SVC_VERCEL_APP_ROLE;

-- If either is a VIEW rather than a TABLE the statements above error with
-- "Object does not exist". Use these instead for whichever is a view:
-- GRANT SELECT ON VIEW DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER        TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON VIEW DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS TO ROLE SVC_VERCEL_APP_ROLE;

-- Check which they are first if unsure:
-- SHOW OBJECTS LIKE 'LEAD_LEADCUSTOMER%' IN SCHEMA DATAWAREHOUSE.SILVERSURFER;


-- ---------------------------------------------------------------------------
-- Verify, as the app's role
-- ---------------------------------------------------------------------------
-- USE ROLE SVC_VERCEL_APP_ROLE;
-- SELECT COUNT(*) FROM DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER        LIMIT 1;
-- SELECT COUNT(*) FROM DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS LIMIT 1;

-- What the role can already see, if a grant appears not to take:
-- SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;
