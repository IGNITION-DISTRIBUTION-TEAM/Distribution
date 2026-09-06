-- Grants for the source_load step's read object.
--
-- Fixes: SQL compilation error ... Object
--   'DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_REACTIVE_DATA' does not
--   exist or not authorized.
--
-- The failing statement is the step 3 load, built in lib/distribution-steps.ts:
--   INSERT INTO DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED (...)
--   SELECT ... FROM <the campaign's "Load from" / "View">
--
-- The object name is NOT hardcoded in the app — it comes from the campaign's
-- config (SOURCE_LOAD_FROM, falling back to SOURCE_OBJECT). So the app read
-- exactly what it was configured to read, and this is a grants or a naming
-- problem rather than a bug.
--
-- WHY A VIEW SLIPPED THROUGH. scripts/temp-upload-counts-grants.sql already
-- grants USAGE on this schema and SELECT ON FUTURE TABLES in it. In Snowflake
-- FUTURE TABLES and FUTURE VIEWS are separate grant targets, so a view in the
-- same schema is not covered — which fits the symptom exactly: the app clearly
-- reaches the schema (it reads TEMP_UPLOAD and calls procs there), and only
-- this one object is invisible.
--
-- Snowflake says "does not exist or not authorized" for both causes on
-- purpose — telling them apart would leak the existence of objects you cannot
-- see. Part 1 below is what tells them apart.
--
-- Replace SVC_VERCEL_APP_ROLE with the role the app connects as (the
-- SNOWFLAKE_ROLE env var) if it differs. Run parts 1-3 as a role that can
-- grant on DATAWAREHOUSE.DISTRIBUTION_AUTOMATION — the schema owner,
-- ACCOUNTADMIN, or a role with MANAGE GRANTS.


-- ---------------------------------------------------------------------------
-- 1. Which problem is it? Run this FIRST.
-- ---------------------------------------------------------------------------
SHOW VIEWS  LIKE 'VW_SPOT_REACTIVE_DATA' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;
SHOW TABLES LIKE 'VW_SPOT_REACTIVE_DATA' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;

--   A row from SHOW VIEWS   -> it exists; this is a grant problem. Run part 2.
--   A row from SHOW TABLES  -> it exists but is a TABLE, not a view. Run part 2
--                              with the TABLE form and skip part 3.
--   Nothing from either     -> the object is not there. This is NOT a grants
--                              problem: the name in the campaign's config is
--                              wrong, or the view was never created / was
--                              dropped. Fix it in Distribution -> Settings ->
--                              the campaign -> "Load from" (or "View"), and do
--                              not grant anything.


-- ---------------------------------------------------------------------------
-- 2. The grant
-- ---------------------------------------------------------------------------
-- Already in place if temp-upload-counts-grants.sql has been run; harmless to
-- repeat, and included so this script stands alone.
GRANT USAGE ON DATABASE DATAWAREHOUSE                          TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.DISTRIBUTION_AUTOMATION  TO ROLE SVC_VERCEL_APP_ROLE;

-- The object itself. Use whichever form part 1 said it is.
GRANT SELECT
  ON VIEW DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_REACTIVE_DATA
  TO ROLE SVC_VERCEL_APP_ROLE;

-- If part 1 said TABLE, use this instead of the statement above:
-- GRANT SELECT
--   ON TABLE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_REACTIVE_DATA
--   TO ROLE SVC_VERCEL_APP_ROLE;


-- ---------------------------------------------------------------------------
-- 3. Optional: stop the next view repeating this
-- ---------------------------------------------------------------------------
-- A DELIBERATE WIDENING, worth a conscious decision rather than running on
-- autopilot. It lets the app SELECT from every view in this schema, including
-- ones that do not exist yet — so a new campaign pointed at a new view just
-- works instead of failing the way this one did.
--
-- The narrower alternative is to grant each view as it is adopted, which is
-- safer and guarantees this recurs. temp-upload-counts-grants.sql already made
-- the equivalent call for TABLES in this schema, so granting views too is
-- consistent with what is there rather than a new exposure of a different kind.
--
-- ALL VIEWS covers what exists now; FUTURE VIEWS covers what comes later. Both
-- are needed: neither implies the other, and a view that is recreated by a
-- procedure (CREATE OR REPLACE without COPY GRANTS) loses its individual grant
-- and is picked up again only by the FUTURE grant.

GRANT SELECT ON ALL VIEWS    IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION
  TO ROLE SVC_VERCEL_APP_ROLE;


-- ---------------------------------------------------------------------------
-- 4. Verify AS THE APP'S ROLE — the only check that proves it
-- ---------------------------------------------------------------------------
-- Granting and then querying as ACCOUNTADMIN proves nothing: that role could
-- always see it. Switch roles.
--
-- USE ROLE SVC_VERCEL_APP_ROLE;
-- SELECT COUNT(*) FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_REACTIVE_DATA;

-- What the role can see, if a grant appears not to have taken:
-- SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;
-- SHOW GRANTS ON VIEW DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_REACTIVE_DATA;

-- A view runs with the privileges of ITS OWNER over the tables underneath, so
-- SELECT on the view is normally enough. If this still fails after the grant
-- with an error naming a table the view reads, the view's owner has lost
-- access to its own source and that is a separate problem in that schema.
