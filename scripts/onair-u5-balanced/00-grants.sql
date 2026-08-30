/* =============================================================================
   STEP 0 — grants for SP_ONAIR_U5_BALANCED_POOL
   -----------------------------------------------------------------------------
   Symptom:
     Uncaught exception of type 'STATEMENT_ERROR' on line 26 at position 4 :
     SQL access control error: Insufficient privileges to operate on table
     'TM_ONAIR_INCUBATION_SCORE_OTPUT'. This executable runs with owner's rights.
     The owner role SYSADMIN must have SELECT granted on TABLE ...

   Reading it:
     Line 26 is the CREATE OR REPLACE TABLE that reads both pools, so the
     procedure compiled, declared its variables, read the band config and
     evaluated the IF before failing. Only the grant is missing.

     The procedure is EXECUTE AS OWNER and its owner is SYSADMIN, so the rights
     that matter are SYSADMIN's, not yours and not the app's. The pool tables are
     created by the two builder procedures, which run as THEIR owner — a
     different role — so SYSADMIN was never given anything on them.

   Two ways to fix it. Section 2 is the quick one, section 3 is the tidier one.
   Run section 1 first either way.
============================================================================= */


/* -----------------------------------------------------------------------------
   1. Who owns what
----------------------------------------------------------------------------- */
-- The two pool tables. Note the OWNER column — call it <POOL_OWNER> below.
SHOW TABLES LIKE 'TM_ONAIR%SCORE_OTPUT'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;

-- The builder procedures. Their owner is almost certainly the same role, and it
-- is the role section 3 would hand the new procedure to.
SHOW PROCEDURES LIKE 'SP_ONAIR%NEW_POOL_BR'
  IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;

-- Confirm the new procedure really is SYSADMIN's.
SHOW GRANTS ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(NUMBER, NUMBER, NUMBER, NUMBER, NUMBER);
-- Look for the OWNERSHIP row.


/* -----------------------------------------------------------------------------
   2. QUICK FIX — give SYSADMIN what the procedure body needs
   Run as ACCOUNTADMIN, or as <POOL_OWNER> with GRANT rights.
----------------------------------------------------------------------------- */

-- Reading both pools. The incubation table is the one that errored; the default
-- table has the same owner and will fail on the next statement otherwise —
-- Snowflake reports only the first missing privilege it hits.
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_INCUBATION_SCORE_OTPUT
  TO ROLE SYSADMIN;

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_SCORE_OTPUT
  TO ROLE SYSADMIN;

-- Calling the two builders, for when REBUILD_POOLS = 1. Not yet exercised: the
-- run that failed passed 0, so it skipped the CALL block entirely and this gap
-- would only have surfaced on the first real run.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(NUMBER)
  TO ROLE SYSADMIN;

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIRICUBATION_NEW_POOL_BR(NUMBER)
  TO ROLE SYSADMIN;

/* These grants SURVIVE the next pool rebuild.
   Both builders use CREATE OR REPLACE TABLE ... COPY GRANTS, and COPY GRANTS
   carries the privileges from the replaced table onto the new one. Without that
   clause every rebuild would silently revoke the two SELECTs above and this
   procedure would break again tomorrow morning. If anyone ever edits a builder,
   COPY GRANTS has to stay. */


/* -----------------------------------------------------------------------------
   3. TIDIER ALTERNATIVE — make the new procedure a peer of the old ones
   Instead of granting SYSADMIN access to someone else's tables, recreate the
   procedure under the role that already owns them. It then inherits exactly the
   access the existing builders have, and no cross-role grants are needed.
----------------------------------------------------------------------------- */
-- USE ROLE <POOL_OWNER>;          -- from section 1
-- ...then re-run STEP 3 of onair-u5-balanced.sql.
--
-- <POOL_OWNER> must also be able to reach the objects SYSADMIN created in
-- steps 1 and 2, so grant those across first:
--
--   GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE <POOL_OWNER>;
--   GRANT SELECT ON TABLE ...TM_U5_BAND_TARGETS      TO ROLE <POOL_OWNER>;
--   GRANT INSERT ON TABLE ...TM_U5_ALLOCATION_RUNS   TO ROLE <POOL_OWNER>;
--   GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE <POOL_OWNER>;
--
-- Pick section 2 OR section 3, not both. Section 2 is fewer moving parts today;
-- section 3 means the balanced process has the same access story as everything
-- else in this schema, which is worth more in six months.


/* -----------------------------------------------------------------------------
   4. AFTER THE FIRST SUCCESSFUL RUN — let the app read the output
   The allocated table does not exist until the procedure completes once, so
   these cannot be run before then.
----------------------------------------------------------------------------- */
-- Replace <APP_ROLE> with what /api/distribution/snowflake-identity reports.

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_ONAIR_U5_BALANCED_POOL
  TO ROLE <APP_ROLE>;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_BALANCED_POOL
  TO ROLE <APP_ROLE>;

-- The app also has to be able to CALL the procedure from the automation config.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(NUMBER, NUMBER, NUMBER, NUMBER, NUMBER)
  TO ROLE <APP_ROLE>;

/* TM_ONAIR_U5_BALANCED_POOL is also CREATE OR REPLACE ... COPY GRANTS, so the
   app's SELECT survives every re-run. Grant it once. */


/* -----------------------------------------------------------------------------
   5. Retry
----------------------------------------------------------------------------- */
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_U5_BALANCED_POOL(308, 5, 180, 1, 0);

-- Expect a line like:
--   target 277200 | selected 213480 (default 188972, top-up 24508) | short 63720 | bands 18
--
-- Then run STEP 7 of onair-u5-balanced.sql to verify, and the first two columns
-- of STEP 5a to see how much the incubation pool actually contributed — that is
-- the figure nobody has seen yet.
