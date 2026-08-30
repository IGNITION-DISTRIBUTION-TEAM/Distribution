-- Diagnosing: "Unknown user-defined function
--   DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR"
--   (Snowflake error 002141, sqlState 42601)
--
-- The app ran:  CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR()
-- with NO arguments, because the campaign's SOURCE_OBJECT carries no argument
-- list. Snowflake raises this same error for three different situations and
-- deliberately does not say which, so that a missing grant cannot be used to
-- probe for objects that exist:
--
--   A. Nothing of that name exists at that DATABASE.SCHEMA.
--   B. It exists but takes a different NUMBER OF ARGUMENTS. Snowflake resolves
--      procedures by name + arity, so SP_X(NUMBER) is not callable as SP_X().
--   C. It exists with the right arity, but the role the app connects as has no
--      USAGE on it (or no USAGE on the schema).
--
-- Run sections 1-4 in order. Each one rules out a branch.
-- Run them as a role that can see everything (ACCOUNTADMIN), not as the app's
-- role — the point is to compare what exists against what the app can reach.


-- ============================================================================
-- 1. Does it exist ANYWHERE in the account, and with what signature?
-- ============================================================================
-- The one query that settles A vs B. ARGUMENTS shows the real signature.
SHOW PROCEDURES LIKE 'SP_ONAIR_NEW_POOL_BR' IN ACCOUNT;

-- Nothing back? Widen it — the name may differ slightly, or live elsewhere.
SHOW PROCEDURES LIKE '%ONAIR%' IN ACCOUNT;

-- Same question against the metadata view, which is easier to read and filter.
-- NOTE: this view only lists objects the CURRENT ROLE has privileges on, so
-- running it as the app's role and as ACCOUNTADMIN and comparing is itself the
-- test for branch C.
SELECT PROCEDURE_CATALOG   AS DB,
       PROCEDURE_SCHEMA    AS SCHEMA,
       PROCEDURE_NAME      AS NAME,
       ARGUMENT_SIGNATURE,          -- '()' means callable with no arguments
       DATA_TYPE           AS RETURNS,
       PROCEDURE_OWNER     AS OWNER,
       CREATED
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_NAME ILIKE '%ONAIR%'
ORDER BY PROCEDURE_SCHEMA, PROCEDURE_NAME;

-- How to read section 1:
--   * No rows anywhere              -> branch A. The configured name is wrong,
--                                      or the procedure was never deployed to
--                                      this environment. Fix SOURCE_OBJECT.
--   * A row with ARGUMENT_SIGNATURE
--     other than '()'               -> branch B. See section 3.
--   * A row with '()' that the app
--     still cannot call             -> branch C. See section 4.


-- ============================================================================
-- 2. Is the schema itself right? (cheap sanity check)
-- ============================================================================
-- DISTRIBUTION_DATA_APPLICATION is a real schema — the HLL table lives in it —
-- so this is expected to return rows. If it does not, the app's role cannot see
-- the schema at all and every object in it will fail the same way.
SHOW SCHEMAS LIKE 'DISTRIBUTION_DATA_APPLICATION' IN DATABASE DATAWAREHOUSE;

-- Procedures that DO exist in that schema, for comparison against the name in
-- the config.
SHOW PROCEDURES IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION;


-- ============================================================================
-- 3. Branch B — it takes arguments
-- ============================================================================
-- If section 1 returned e.g. ARGUMENT_SIGNATURE = '(NUMBER)', the app must pass
-- one. It supports that: put the argument list in the config's Source object
-- field, exactly as you would write the CALL.
--
--   Settings -> the campaign's automation config -> Source object
--     from:  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR
--     to:    DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(1)
--
-- Only digits, identifiers, commas and spaces are accepted inside the parens.
-- Verify by hand first, substituting the real argument:
CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(1);

-- What the config currently holds for this campaign (replace the id):
SELECT CAMPAIGNID, SOURCE_KIND, SOURCE_OBJECT, UPLOAD_TARGET_TABLE, IS_ACTIVE
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG
WHERE SOURCE_OBJECT ILIKE '%ONAIR_NEW_POOL%';

-- The newer multi-config table holds the same fields per named config:
SELECT CONFIGID, CAMPAIGNID, SOURCE_KIND, SOURCE_OBJECT, UPLOAD_TARGET_TABLE, IS_ACTIVE
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIGS
WHERE SOURCE_OBJECT ILIKE '%ONAIR_NEW_POOL%';


-- ============================================================================
-- 4. Branch C — it exists but the app's role cannot use it
-- ============================================================================
-- Which role is the app actually connecting as? Run this THROUGH THE APP, not
-- in a worksheet — a worksheet tells you about your own session, not the app's.
-- (Settings -> Snowflake test, or any app query.)
SELECT CURRENT_ROLE() AS APP_ROLE, CURRENT_USER() AS APP_USER, CURRENT_WAREHOUSE() AS WH;

-- Then, as ACCOUNTADMIN, list what is granted on the procedure. Substitute the
-- exact signature that section 1 reported — the argument types are part of the
-- object's identity here, and a wrong signature is itself an error.
SHOW GRANTS ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR();

-- Grant it. Replace <APP_ROLE> with what the app reported above, and the
-- signature with the real one.
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE <APP_ROLE>;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR()
  TO ROLE <APP_ROLE>;

-- A caller's-rights procedure also needs the role to hold every privilege the
-- procedure's body uses. If the CALL now resolves but fails inside the body on
-- some table, that is this — check how it was created:
SELECT GET_DDL('PROCEDURE',
  'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR()');
-- EXECUTE AS CALLER  -> the app's role needs the body's privileges too.
-- EXECUTE AS OWNER   -> only USAGE on the procedure is needed.


-- ============================================================================
-- 5. After fixing — confirm the step end to end
-- ============================================================================
-- The "run procedure" step only fills the staging table; "load into HLL" then
-- reads it. Confirm the procedure actually wrote something before re-running
-- the second step, or you will load an empty batch.
--
-- Substitute the campaign's UPLOAD_TARGET_TABLE from section 3.
SELECT COUNT(*) AS ROWS_STAGED
FROM <UPLOAD_TARGET_TABLE>;
