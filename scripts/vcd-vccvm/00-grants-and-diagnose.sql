/* =============================================================================
   "Unknown user-defined function
      DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP"
   (Snowflake 002141 / 42601, after CALL ...SP_VCD_VCCVM_PREP(11058, 90, 6))
   -----------------------------------------------------------------------------
   Snowflake raises that one error for three different situations and refuses to
   say which, so that a missing grant cannot be used to probe for objects that
   exist:

     A. Nothing of that name exists there — the CREATE in
        sp-vcd-vccvm-prep.sql section 1 has not been run yet.
     B. It exists with a different arity. Procedures resolve on name AND number
        of arguments, so a 3-argument procedure is not callable with 2.
     C. It exists, right arity, but the app's role cannot see it — no USAGE on
        the procedure, or no USAGE on the schema holding it.

   START WITH C, BECAUSE YOU HAVE SEEN THIS EXACT ERROR ON THIS EXACT SCHEMA
   BEFORE. When the Remove-duplicates tab first ran it failed with

     "Unknown user-defined function
        DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_FROM_SQLSERVER"

   — same error, same schema, different object. That is what a missing USAGE ON
   SCHEMA looks like: it hides EVERY object inside, so each new one you point the
   app at fails identically, and fixing them one at a time never ends.
   temp-upload-duplicates-grants.sql was written for that and is on your
   outstanding list, so it may well never have been run. If so, this is the same
   cause and section 2 fixes both at once — along with VW_VCD_VCCVM_HLL_LOAD,
   which lives in that schema too and would have been the next thing to fail.

   Sections 1 and 2 are the whole job: find out which, then fix it.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — which of the three is it?

   Run as ACCOUNTADMIN. The point is to compare what EXISTS against what the APP
   can reach, so it has to be a role that can see everything.
-------------------------------------------------------------------------------- */

-- 1a. Does it exist at all, and with what signature? This settles A vs B.
--     ARGUMENTS shows the real arity: expect (NUMBER, NUMBER, NUMBER).
SHOW PROCEDURES LIKE 'SP_VCD_VCCVM_PREP' IN ACCOUNT;

-- Nothing back at all → branch A. Run sp-vcd-vccvm-prep.sql section 1 and stop;
-- the rest of this file is then only needed for the grants in section 2.

-- 1b. Does the schema itself exist, and does the app's role hold USAGE on it?
--     An empty second result with a non-empty first is branch C, and is the
--     answer if SP_SYNC_FROM_SQLSERVER is also listed as unreachable.
SHOW SCHEMAS LIKE 'DISTRIBUTION_AUTOMATION' IN DATABASE DATAWAREHOUSE;
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;

-- 1c. Everything the app is expected to reach in that schema, in one list.
--     Any row missing here is a row that will fail the same way.
SELECT 'procedure' AS KIND, PROCEDURE_NAME AS NAME, ARGUMENT_SIGNATURE AS SIG
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
 WHERE PROCEDURE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
   AND PROCEDURE_NAME IN ('SP_VCD_VCCVM_PREP', 'SP_SYNC_FROM_SQLSERVER')
UNION ALL
SELECT 'view', TABLE_NAME, NULL
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.VIEWS
 WHERE TABLE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
   AND TABLE_NAME = 'VW_VCD_VCCVM_HLL_LOAD';

/* THE DEFINITIVE TEST IS NOT A WORKSHEET.
   INFORMATION_SCHEMA lists only what the CURRENT role can see, so run 1c as
   ACCOUNTADMIN and it tells you what exists — not what the app can reach. To
   ask the app about its own session, use its endpoint, which runs SHOW
   PROCEDURES as the app's role and reports visibleToApp:

     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP

   That, and only that, distinguishes C from A. */


/* -----------------------------------------------------------------------------
   SECTION 2 — the grants for the whole VC CVM chain

   Run as ACCOUNTADMIN. Safe to re-run.

   USAGE ON SCHEMA comes first and matters most: without it every object inside
   is invisible however it is granted, and the error is identical to the object
   not existing. That is the trap this whole file is about.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                        TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION             TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION
                                                             TO ROLE SVC_VERCEL_APP_ROLE;

-- The prep procedure. The signature is part of its identity, and
-- CREATE OR REPLACE PROCEDURE carries no grants and has no COPY GRANTS clause —
-- so this line has to be re-run every single time the procedure is replaced.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(NUMBER, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The load view, and the table under it. A non-secure view does not launder
-- access: the app reads it as itself and needs SELECT on both.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_VCD_VCCVM_HLL_LOAD
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT, DELETE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The HLL target.
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The same schema's sync procedure, which failed this way earlier. Included
-- because if the schema USAGE above was the cause, this was broken too.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_FROM_SQLSERVER(VARCHAR, VARCHAR, VARCHAR, VARCHAR)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 3 — confirm, in the right order

   1. Section 1a returns a row with ARGUMENTS (NUMBER, NUMBER, NUMBER).
      If not, run sp-vcd-vccvm-prep.sql section 1 first.

   2. Section 2 has been run since the last CREATE OR REPLACE PROCEDURE.

   3. The app agrees, from its own session:
        /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP
      → visibleToApp: true

   4. Then the step, on its own, from Manual → step 3.

   IF IT STILL SAYS UNKNOWN AFTER ALL FOUR, it is branch B and the arity is the
   thing to look at. The app passes exactly what is in the config's brackets,
   verbatim — (11058, 90, 6) is three arguments, so the procedure must take
   three. This will do it, run as ACCOUNTADMIN:

     SHOW PROCEDURES LIKE 'SP_VCD_VCCVM_PREP' IN ACCOUNT;

   and compare the ARGUMENTS column against the brackets in Settings. An older
   copy left behind from an earlier signature is the usual reason — a
   3-argument procedure and a 4-argument procedure of the same name can both
   exist at once, and the app's call picks neither if it matches neither.
-------------------------------------------------------------------------------- */
