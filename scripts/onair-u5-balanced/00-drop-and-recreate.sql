/* =============================================================================
   DROP AND RECREATE AS ACCOUNTADMIN
   -----------------------------------------------------------------------------
   Only two objects actually need new ownership. The config tables can stay
   exactly where they are — ACCOUNTADMIN inherits SYSADMIN, so a procedure it
   owns can already read TM_U5_BAND_TARGETS and write TM_U5_ALLOCATION_RUNS.
   Dropping those would cost you the 18 seeded bands and any weights you have
   set since, for nothing.

   ONE THING TO KNOW BEFORE YOU DO THIS
     An EXECUTE AS OWNER procedure owned by ACCOUNTADMIN runs its body with full
     account privileges, and anyone granted USAGE on it can set that body
     running. The body here is fixed and does one job, so the blast radius is
     small — but this is the reason Snowflake's own guidance is to avoid
     ACCOUNTADMIN owning objects. The four grants in 00-grants.sql section 2
     leave the procedure on SYSADMIN and achieve the same thing. Your call;
     this file does what you asked for.
============================================================================= */


USE ROLE ACCOUNTADMIN;


/* -----------------------------------------------------------------------------
   1. Drop
----------------------------------------------------------------------------- */

-- The procedure. The argument types are part of its identity, so the signature
-- has to match — five NUMBERs.
DROP PROCEDURE IF EXISTS
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
  (NUMBER, NUMBER, NUMBER, NUMBER, NUMBER);

-- The view has to move too. The procedure will now create the allocated table
-- as ACCOUNTADMIN, and a SYSADMIN-owned view cannot read an ACCOUNTADMIN-owned
-- table — the view would compile and then fail at query time.
DROP VIEW IF EXISTS
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL;

-- Only exists if a run ever got past the allocation statement. Dropping it
-- makes sure the next run creates it fresh under the new owner rather than
-- replacing a table SYSADMIN owns.
DROP TABLE IF EXISTS
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL;


/* -----------------------------------------------------------------------------
   2. Recreate — still as ACCOUNTADMIN
----------------------------------------------------------------------------- */
-- Re-run STEP 3 (the procedure) and STEP 4 (the view) from
-- onair-u5-balanced.sql, in that order, in this same session.
--
-- Do NOT re-run STEP 1 or STEP 2 unless you want to reset the bands.


/* -----------------------------------------------------------------------------
   3. Confirm the ownership actually changed
----------------------------------------------------------------------------- */
SHOW PROCEDURES LIKE 'SP_ONAIR_U5_BALANCED_POOL'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;
-- The "owner" column should now read ACCOUNTADMIN, not SYSADMIN.

SHOW VIEWS LIKE 'VW_V_U5_BALANCED_POOL'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;


/* -----------------------------------------------------------------------------
   4. Run it
----------------------------------------------------------------------------- */
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 0);

-- Expect:
--   target 277200 | selected NNNNN (default NNNNN, top-up NNNNN) | short NNNNN | bands 18


/* -----------------------------------------------------------------------------
   5. The app still needs its own grants
   Ownership by ACCOUNTADMIN fixes the procedure's access to the pool tables.
   It does nothing for the app, which connects as its own role and is not an
   account admin. Run these AFTER step 4 has created the table.
----------------------------------------------------------------------------- */
-- SVC_VERCEL_APP_ROLE is what /api/distribution/snowflake-identity reports.

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
  (NUMBER, NUMBER, NUMBER, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
  TO ROLE SVC_VERCEL_APP_ROLE;

/* The allocated table is CREATE OR REPLACE ... COPY GRANTS, so that last grant
   survives every re-run. Grant it once. */


/* -----------------------------------------------------------------------------
   6. Full reset, only if you want one
   This throws away the band config and the run history as well. You would then
   re-run STEPS 1 to 4 in order.
----------------------------------------------------------------------------- */
-- DROP TABLE IF EXISTS DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS;
-- DROP TABLE IF EXISTS DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS;
