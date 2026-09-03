/* =============================================================================
   THE ANSWER: the app has no USAGE on the procedure.
   -----------------------------------------------------------------------------
   Two facts, from two different sessions, and together they settle it:

     as ACCOUNTADMIN   SHOW PROCEDURES LIKE 'SP_VCD_VCCVM_PREP' IN ACCOUNT
                       returns one row — DATAWAREHOUSE, DISTRIBUTION_AUTOMATION,
                       min_num_arguments 3, max_num_arguments 3.

     as the app        it can see the schema DATAWAREHOUSE.DISTRIBUTION_AUTOMATION,
                       and no procedure of that name inside it.

   The procedure exists. The schema is reachable. So the only thing left is
   procedure-level USAGE, which the app does not hold.

   THIS ALSO EXPLAINS SP_SYNC_FROM_SQLSERVER. The app already reads and writes
   TEMP_UPLOAD_DUPES in that same schema — the Remove-duplicates scan truncates
   it — so it plainly has schema USAGE and table privileges there. What it has
   never been granted is USAGE on a PROCEDURE in that schema, and both procedures
   it cannot call live there. One missing grant, two broken features.

   Run as ACCOUNTADMIN.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — confirm the role first

   Everything below grants to SVC_VERCEL_APP_ROLE. If the app connects as
   something else, every statement succeeds and nothing changes — which is the
   most wasteful way for this to fail, so check before running them.

     /api/distribution/snowflake-identity      → session.role

   That endpoint reports CURRENT_ROLE() from the app's own connection. Whatever
   it names is the role to use below. (The app cannot be running as ACCOUNTADMIN,
   the configured fallback, or none of this would have been hidden from it.)
-------------------------------------------------------------------------------- */

SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 2 — get the exact signature

   The signature is part of a procedure's identity, so the GRANT has to name the
   argument types as Snowflake records them. Read them from the ARGUMENTS column
   here — do not assume, because if the text does not match, the GRANT fails with
   "does not exist or not authorized" and looks like the very problem it is
   meant to fix.
-------------------------------------------------------------------------------- */

SHOW PROCEDURES LIKE 'SP_VCD_VCCVM_PREP' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;
SHOW PROCEDURES LIKE 'SP_SYNC_FROM_SQLSERVER' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;

-- Same thing, easier to read, and it gives ARGUMENT_SIGNATURE in the exact form
-- the GRANT wants.
SELECT PROCEDURE_NAME, ARGUMENT_SIGNATURE, DATA_TYPE AS RETURNS, PROCEDURE_OWNER
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
 WHERE PROCEDURE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
   AND PROCEDURE_NAME IN ('SP_VCD_VCCVM_PREP', 'SP_SYNC_FROM_SQLSERVER');


/* -----------------------------------------------------------------------------
   SECTION 2b — WHAT SECTION 2 ACTUALLY RETURNED, AND THE SECOND FAULT

   Section 2 was run and reported:

     SP_SYNC_FROM_SQLSERVER  (SQL_SERVER_TABLE VARCHAR, SNOWFLAKE_TARGET VARCHAR,
                              FILTERS_JSON VARCHAR, ENDPOINT_TYPE VARCHAR)
     SP_VCD_VCCVM_PREP       (HISTORY_CAMPAIGNS VARCHAR, HISTORY_DAYS NUMBER,
                              COMMITMENT_MONTHS NUMBER)

   The sync procedure matches what the app sends. SP_VCD_VCCVM_PREP DOES NOT.

   What exists is the FIRST version of sp-vcd-vccvm-prep.sql, whose first
   parameter was a VARCHAR list of campaign ids — note the plural name,
   HISTORY_CAMPAIGNS. That parameter was changed to a NUMBER precisely because
   the config field cannot express a quoted argument, and the procedure was
   created before that change. So the app sends (11058, 90, 6) — three numbers —
   at a procedure whose first parameter is a string.

   THERE ARE THEREFORE TWO FAULTS, and the earlier reading of SHOW PROCEDURES
   found only one. min_num_arguments and max_num_arguments both said 3, which
   matched, and the ARGUMENT column that would have shown the types was cut off
   in the results grid.

   Granting alone will not fix this. The signature has to match as well, and
   section 3 now does both — in the right order, because of the trap below.

   CREATE OR REPLACE DOES NOT REPLACE A DIFFERENT SIGNATURE. Snowflake
   identifies a procedure by name AND argument types, so creating the
   (NUMBER, NUMBER, NUMBER) version leaves the (VARCHAR, NUMBER, NUMBER) one
   sitting there beside it. Two procedures, one name, and a call that matches
   neither if the config is ever wrong again. Drop the old one explicitly.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — drop the wrong signature, create the right one, then grant

   Run in this order. The grant must come last: CREATE OR REPLACE PROCEDURE
   carries no grants, so granting before creating achieves nothing.
-------------------------------------------------------------------------------- */

-- 3a. The stale VARCHAR-first version. Types only — no parameter names.
DROP PROCEDURE IF EXISTS
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(VARCHAR, NUMBER, NUMBER);

-- 3b. Re-run section 1 of sp-vcd-vccvm-prep.sql, which declares
--     HISTORY_CAMPAIGN NUMBER(38,0) and matches the call the app makes.
--     Confirm afterwards that exactly one signature remains:
SHOW PROCEDURES LIKE 'SP_VCD_VCCVM_PREP' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;

-- 3c. Then the grants.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(NUMBER, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_FROM_SQLSERVER(VARCHAR, VARCHAR, VARCHAR, VARCHAR)
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 4 — confirm the grant landed

   Both procedures should appear. An empty result means section 3 did not do what
   it looked like it did — almost always the wrong role or the wrong signature.
-------------------------------------------------------------------------------- */

SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;
-- Filter that to just the procedures:
SELECT "privilege", "granted_on", "name"
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
 WHERE "granted_on" = 'PROCEDURE';

-- Then, from the app's own session — the only test that counts:
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP
--   → visibleToApp: true
--
-- Then run the step from Manual → step 3.


/* -----------------------------------------------------------------------------
   SECTION 5 — so this does not come back

   CREATE OR REPLACE PROCEDURE DROPS ITS GRANTS, and unlike tables and views
   there is no COPY GRANTS clause for procedures. Every edit to
   SP_VCD_VCCVM_PREP therefore breaks the app again in exactly this way, with
   exactly this error, and section 3 has to be re-run each time. Keep the two
   together: replace the procedure, then re-grant, in the same worksheet.

   The durable alternative is a future grant on the schema, which applies to
   procedures created there from then on and removes the manual step entirely:

     GRANT USAGE ON FUTURE PROCEDURES IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION
       TO ROLE SVC_VERCEL_APP_ROLE;

   Be deliberate about that one. It means every procedure anybody creates in that
   schema from now on is callable by the app, without review. For a schema that
   exists to hold this app's automation procedures that is reasonable and saves a
   recurring outage; for a shared schema it is broader than you want. It also
   does NOT cover the two that already exist, so section 3 is still needed today.
-------------------------------------------------------------------------------- */
