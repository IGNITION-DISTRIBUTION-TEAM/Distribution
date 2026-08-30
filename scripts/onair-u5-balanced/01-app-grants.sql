/* =============================================================================
   EVERY GRANT THE BALANCED POOL NEEDS
   -----------------------------------------------------------------------------
   Symptom this fixes:
     Source: Couldn't read columns for ...VW_V_U5_BALANCED_POOL:
     Table '...VW_V_U5_BALANCED_POOL' does not exist or not authorized.

   Snowflake says "does not exist or not authorized" for both cases and will not
   tell you which, so section 1 settles it before you grant anything. If you ran
   00-drop-and-recreate.sql and only re-ran STEP 3, the view is genuinely gone —
   the drop took it and STEP 4 puts it back.

   Run everything as ACCOUNTADMIN.

   The app's role is SVC_VERCEL_APP_ROLE, confirmed from
   /api/distribution/snowflake-identity — the app's own live connection, not a
   guess. Every grant below is ready to run as written.
============================================================================= */


/* -----------------------------------------------------------------------------
   1. Does the view exist at all?
----------------------------------------------------------------------------- */
SHOW VIEWS LIKE 'VW_V_U5_BALANCED_POOL'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;
-- No rows  -> it was dropped and not recreated. Re-run STEP 4 of
--             onair-u5-balanced.sql as ACCOUNTADMIN, then carry on here.
-- One row  -> it exists; this is purely a grants problem. Note the OWNER column.

SHOW PROCEDURES LIKE 'SP_ONAIR_U5_BALANCED_POOL'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;

SHOW TABLES LIKE 'TM_ONAIR_U5_BALANCED_POOL'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;
-- No rows here is expected until the procedure has completed once.


/* -----------------------------------------------------------------------------
   2. Reaching the database and schema
   Without these nothing else in the file has any effect — an object in a schema
   you cannot USE is invisible however it is granted.
----------------------------------------------------------------------------- */
GRANT USAGE ON DATABASE DATAWAREHOUSE TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   3. Running step 1 of the automation — the procedure
   Argument types are part of a procedure's identity in a GRANT, so all five
   NUMBERs have to be there.
----------------------------------------------------------------------------- */
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
  (NUMBER, NUMBER, NUMBER, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   4. Reading the output — the view
   This is the one the column mapper needs. It is also what step 2 of the
   automation SELECTs from when it writes into HLL, so without it the load fails
   too, not just the mapping.
----------------------------------------------------------------------------- */
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The app never queries the base table directly — the view is enough, because a
-- view runs with its owner's rights against what it reads. Grant this anyway so
-- the verification queries in STEP 7 work from a session using the app's role.
-- Only possible once the procedure has created it; skip until then.
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   5. Writing into HLL — step 2 of the automation
   Almost certainly already in place, since the existing Default automation
   loads into the same table. Included so this file is the whole picture.
----------------------------------------------------------------------------- */
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   5a. The Pool allocation REPORT — Reporting → Distribution
   Symptom without these:
     Object '...TM_U5_BAND_TARGETS' does not exist or not authorized.

   The grants above cover RUNNING the process. The report READS four more
   objects, and reads them as the app rather than as the procedure's owner — so
   the SELECTs granted to SYSADMIN in 00-grants.sql do nothing for it.
----------------------------------------------------------------------------- */

-- The band configuration and the run log.
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_BAND_TARGETS
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_U5_ALLOCATION_RUNS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Both source pools. The report counts what is still available per band, which
-- it cannot get from the allocated table — that only holds what was taken.
-- Granted to SYSADMIN already for the procedure's own use; the app is a
-- different role and needs its own.
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
  TO ROLE SVC_VERCEL_APP_ROLE;

/* Persistence:
     TM_U5_BAND_TARGETS / TM_U5_ALLOCATION_RUNS  CREATE TABLE IF NOT EXISTS —
       never replaced, so these grants are permanent.
     The two pool tables                         CREATE OR REPLACE ... COPY
       GRANTS in the builders, so they survive each nightly rebuild.

   Narrower option, if you would rather the app did not hold SELECT on the raw
   pools: the report only ever counts rows per band, so a counts-only view over
   each pool would serve it and expose no identifiers. Say the word and I will
   move the route onto them — it is a small change and strictly better under
   POPIA, just more objects to keep in step. */


/* -----------------------------------------------------------------------------
   5b. The EXISTING Default automation, while you are here
   Same role, and the original "Unknown user-defined function" on
   SP_ONAIR_NEW_POOL_BR was never confirmed resolved. If it is still failing
   after the (1) argument was added, this is why.
----------------------------------------------------------------------------- */
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_OPTIMIZED_POOL
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Only if a "Top up" automation calls it directly:
-- GRANT USAGE ON PROCEDURE
--   DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIRICUBATION_NEW_POOL_BR(NUMBER)
--   TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   6. Do these survive tomorrow?
   Worth understanding, because two of them nearly did not.

     TM_ONAIR_U5_BALANCED_POOL   YES. The procedure rebuilds it with
                                 CREATE OR REPLACE TABLE ... COPY GRANTS.

     VW_V_U5_BALANCED_POOL       YES, but only since COPY GRANTS was added to
                                 STEP 4. CREATE OR REPLACE VIEW drops every
                                 grant by default. If you are working from an
                                 older copy of the script, take the new one or
                                 you will be back here after the next edit.

     SP_ONAIR_U5_BALANCED_POOL   NO. CREATE OR REPLACE PROCEDURE does not carry
                                 grants and has no COPY GRANTS clause. Re-run
                                 section 3 every time you change the procedure.

   That last one is the trap: editing the procedure silently revokes the app's
   USAGE, and the automation then fails with "Unknown user-defined function" —
   which reads as though the procedure vanished rather than as a lost grant.
----------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   7. Verify, without guessing
----------------------------------------------------------------------------- */
-- As ACCOUNTADMIN: everything the role now holds in this schema.
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;

-- Better: ask the app itself. In the browser, signed in to the portal:
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL
-- "visibleToApp": true means the procedure is reachable from the app's own
-- session, which is the only session whose opinion matters here.

-- Then, in the app: Load columns & map. Expect "8 column(s) mapped".
