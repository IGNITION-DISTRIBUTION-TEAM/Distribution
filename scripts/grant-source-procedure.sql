-- Grants for SP_ONAIR_NEW_POOL_BR.
--
-- Why this is now the answer: the app submitted
--
--   CALL DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(1)
--
-- byte for byte the statement that succeeds in a worksheet, and it still failed.
-- The SQL is therefore not the variable — the SESSION is. The app connects as
-- SNOWFLAKE_ROLE (falling back to ACCOUNTADMIN when unset), which is not the
-- role a worksheet uses.
--
-- Snowflake reports a procedure the role cannot USE as "Unknown user-defined
-- function", identical to one that does not exist, so that a missing grant
-- cannot be used to probe for objects. That is why the error never changed.
--
-- Run everything below as ACCOUNTADMIN.


-- ============================================================================
-- 1. Which role is the app actually using?
-- ============================================================================
-- Do NOT answer this from a worksheet — it would describe your session, not the
-- app's. Open this in the browser while signed in to the portal:
--
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR
--
-- It runs CURRENT_ROLE() through the app's own connection and then does the
-- SHOW below as that role. "visibleToApp": false with the object present in
-- section 2 is the grants case, confirmed.


-- ============================================================================
-- 2. Confirm the object and its exact signature
-- ============================================================================
-- The argument types are part of a procedure's identity in a GRANT, so take the
-- signature from here rather than assuming (NUMBER).
SHOW PROCEDURES LIKE 'SP_ONAIR_NEW_POOL_BR' IN ACCOUNT;
-- Read the "arguments" column, e.g. "SP_ONAIR_NEW_POOL_BR(NUMBER) RETURN VARCHAR".
-- The part in brackets is what section 3 needs.


-- ============================================================================
-- 3. The grants
-- ============================================================================
-- Replace <APP_ROLE> with what section 1 reported, and (NUMBER) with the real
-- signature from section 2.
--
-- USAGE on the database and schema is required as well: without it the schema
-- is invisible and everything inside it fails the same way.

GRANT USAGE ON DATABASE DATAWAREHOUSE TO ROLE <APP_ROLE>;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE <APP_ROLE>;

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(NUMBER)
  TO ROLE <APP_ROLE>;

-- The step after this one reads the upload target, so grant that too or "load
-- into HLL" fails next.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_V_U5_OPTIMIZED_POOL
  TO ROLE <APP_ROLE>;


-- ============================================================================
-- 4. Caller's rights — the failure that comes AFTER the CALL resolves
-- ============================================================================
-- If the procedure runs as CALLER, the app's role also needs every privilege
-- the body uses. The symptom changes: the CALL resolves, then fails inside on
-- some table. Check which it is before deciding you are done.
SELECT GET_DDL('PROCEDURE',
  'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(NUMBER)');
-- EXECUTE AS OWNER  -> USAGE on the procedure is enough; it runs with the
--                     owner's rights and the body's grants do not matter.
-- EXECUTE AS CALLER -> grant the body's reads and writes to <APP_ROLE> as well.


-- ============================================================================
-- 5. Verify
-- ============================================================================
-- As ACCOUNTADMIN, confirm the grant landed:
SHOW GRANTS ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(NUMBER);

-- Then re-open the identity endpoint from section 1. "visibleToApp" should now
-- be true. Only then re-run the step — there is no point retrying before the
-- app can see it.
