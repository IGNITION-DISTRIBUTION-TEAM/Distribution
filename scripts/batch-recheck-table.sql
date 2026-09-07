-- Staging table for Batch upload check's re-push.
--
-- Distribution -> Batch upload check compares each batch's HLL row count
-- against what reached SilverSurfer, and re-pushes the missing leads through
-- SP_SYNC_TO_SQLSERVER_LARGE. That procedure reads from a Snowflake object, so
-- the push stages the rows it wants here and points the procedure at this
-- table — exactly what Extend Expired Leads already does with TM_EXTEND_LEADS.
--
-- WHY ITS OWN TABLE. The push sequence is TRUNCATE, then INSERT, then CALL.
-- Sharing TM_EXTEND_LEADS would mean a re-push and an in-flight Extend Expired
-- Leads run can each truncate the other's staged rows — silently, with both
-- reporting success and one of them sending nothing.
--
-- WHY "LIKE". The INSERT carries no column list, so it writes POSITIONALLY, and
-- the procedure is separately handed a comma-joined string naming the 39 SQL
-- Server columns. Three orders have to agree: this table's columns, the
-- INSERT's SELECT list, and that string. CREATE TABLE LIKE copies the column
-- names, types and order from TM_EXTEND_LEADS, so this table cannot drift from
-- the one the working extend path already uses. Do not hand-write the columns.
--
-- THE TABLE CREATES ITSELF. The app runs the CREATE TABLE IF NOT EXISTS … LIKE
-- below on its first push (ensureStagingTable in lib/silversurfer-push.ts),
-- because LEADS_DISTRIBUTION is app-owned and every TSK_ table in it is created
-- the same way. Making someone run a script for a table the app can create was
-- friction with no safety benefit.
--
-- SO THIS SCRIPT IS FOR THE GRANTS, which the app cannot give itself. Run it if
-- a push reports a permission failure rather than a missing table. Part 1 is
-- kept only as a manual fallback for when the app's role turns out not to hold
-- CREATE TABLE in that schema.
--
-- Run as a role that owns or can create in DATAWAREHOUSE.LEADS_DISTRIBUTION.
-- Replace SVC_VERCEL_APP_ROLE with the role the app connects as (the
-- SNOWFLAKE_ROLE env var) if it differs.


-- ---------------------------------------------------------------------------
-- 1. Create it from its sibling — normally unnecessary, see above
-- ---------------------------------------------------------------------------
-- LIKE copies the column names, types and ORDER, which is the point: the INSERT
-- writes positionally and the procedure takes a separate column-name string, so
-- a hand-written column list would be a third thing to keep in step. Do not
-- replace this with an explicit column list.
CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_BATCH_RECHECK_LEADS
  LIKE DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS;


-- ---------------------------------------------------------------------------
-- 2. Grants — the part that actually needs a human
-- ---------------------------------------------------------------------------
-- The app truncates, inserts and reads it. TRUNCATE is grantable here because
-- the table is app-owned — unlike the Hevo-managed Spot targets, where it
-- needs OWNERSHIP and DELETE has to be used instead.
GRANT SELECT, INSERT, TRUNCATE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_BATCH_RECHECK_LEADS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The reconciliation reads the SilverSurfer side. Already granted by
-- scripts/distribution-export-grants.sql, repeated so this script stands alone.
GRANT USAGE  ON SCHEMA DATAWAREHOUSE.SILVERSURFER TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE  DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER        TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE  DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMERDETAILS TO ROLE SVC_VERCEL_APP_ROLE;
-- If either is a VIEW rather than a TABLE, use ON VIEW for that one. Check with:
--   SHOW OBJECTS LIKE 'LEAD_LEADCUSTOMER%' IN SCHEMA DATAWAREHOUSE.SILVERSURFER;


-- ---------------------------------------------------------------------------
-- 3. Verify AS THE APP'S ROLE
-- ---------------------------------------------------------------------------
-- USE ROLE SVC_VERCEL_APP_ROLE;
-- SELECT COUNT(*) FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_BATCH_RECHECK_LEADS;
-- SELECT COUNT(*) FROM DATAWAREHOUSE.SILVERSURFER.LEAD_LEADCUSTOMER;

-- Confirm the column order matches its sibling. These two must return the same
-- ordered list — if they ever differ, the push writes leads into the wrong
-- fields and nothing will error.
-- SELECT COLUMN_NAME, ORDINAL_POSITION
--   FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
--  WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION'
--    AND TABLE_NAME IN ('TM_EXTEND_LEADS', 'TM_BATCH_RECHECK_LEADS')
--  ORDER BY TABLE_NAME, ORDINAL_POSITION;
