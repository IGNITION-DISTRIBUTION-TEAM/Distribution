/* =============================================================================
   Why TEMP_UPLOAD has three columns in a worksheet and eleven-plus in the app
   -----------------------------------------------------------------------------
   The app renders whatever SELECT * returned, from that response's own column
   metadata — it has no fixed column list. So the two reads saw two different
   shapes, which means the table is being REPLACED, not just filled.

   The columns the app showed (ACCOUNTFIRSTNAME, ACCOUNTNUMBER, AFFORDABILITY,
   ALLOCATEDATE, ALLOCATEUSER, AVGSPEND, BANK, BANKACCOUNTTYPE ...) are the CXM
   lead-upload shape — the same column set as the sync's column list. The three
   the worksheet showed (BATCHNAME, SYSTEMMESSAGE, COUNT) are what
   SP_SYNC_BATCH_COUNTS_TODAY produces.

   So two processes appear to own one table name, each recreating it in its own
   shape. Whoever ran last decides what the other one sees.
============================================================================= */


-- 1. What shape is it in right now, and when was it last created?
--    CREATED far more recent than the schema's other tables = something is
--    doing CREATE OR REPLACE rather than INSERT.
SHOW TABLES LIKE 'TEMP_UPLOAD' IN SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION;

SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
  AND TABLE_NAME = 'TEMP_UPLOAD'
ORDER BY ORDINAL_POSITION;


-- 2. Is there more than one TEMP_UPLOAD? A second one in another schema would
--    explain it without any collision at all — but only if something is
--    resolving the name unqualified.
SHOW TABLES LIKE '%TEMP_UPLOAD%' IN ACCOUNT;


-- 3. What does the batch-counts procedure actually do to it?
--    CREATE OR REPLACE TABLE in here is the confirmation.
SELECT GET_DDL('PROCEDURE',
  'DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_BATCH_COUNTS_TODAY()');


-- 4. Who else writes to it? Any procedure whose body mentions the name.
SELECT PROCEDURE_SCHEMA, PROCEDURE_NAME, ARGUMENT_SIGNATURE
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_DEFINITION ILIKE '%TEMP_UPLOAD%'
ORDER BY 1, 2;

-- Same for views built on it.
SELECT TABLE_SCHEMA, TABLE_NAME
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.VIEWS
WHERE VIEW_DEFINITION ILIKE '%TEMP_UPLOAD%';


-- 5. The history — who last wrote to it, and with what statement.
--    This is the decisive one: it names the queries and the roles behind them.
SELECT START_TIME, USER_NAME, ROLE_NAME, QUERY_TYPE,
       LEFT(QUERY_TEXT, 200) AS QUERY
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE QUERY_TEXT ILIKE '%DISTRIBUTION_AUTOMATION.TEMP_UPLOAD%'
  AND START_TIME > DATEADD(day, -7, CURRENT_TIMESTAMP())
  AND QUERY_TYPE IN ('CREATE_TABLE_AS_SELECT','CREATE_TABLE','INSERT','TRUNCATE_TABLE','DELETE')
ORDER BY START_TIME DESC
LIMIT 50;
-- ACCOUNT_USAGE lags up to ~45 minutes. For the last few minutes use:
-- SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())
--  WHERE QUERY_TEXT ILIKE '%TEMP_UPLOAD%' ORDER BY START_TIME DESC LIMIT 50;


/* -----------------------------------------------------------------------------
   If section 4 or 5 shows a second writer, the Temp Upload page's TRUNCATE can
   wipe rows that process is about to push — it empties the table with no
   confirmation, by design, on the assumption this process owns it. That
   assumption is what these queries are testing.

   The fix, if confirmed, is to stop sharing the name: point
   SP_SYNC_BATCH_COUNTS_TODAY at its own table (TM_BATCH_COUNTS_TODAY, say) and
   the app with it. One line in the app, one in the procedure.
----------------------------------------------------------------------------- */


/* =============================================================================
   WHERE THE AGGREGATED DATA GOES
   -----------------------------------------------------------------------------
   /aggregate-data returns {"data": [[0, {...}], [1, {...}], ...]} — the Snowflake
   EXTERNAL FUNCTION envelope. So it does not "go" anywhere on its own: it is a
   return value. Whatever Snowflake statement calls the external function decides
   where it lands.

   The endpoint's own docstring gives the example:

       "select_columns": ["COUNT(1) AS count", "BATCHNAME", "SYSTEMMESSAGE"],
       "group_by":       ["BATCHNAME", "SYSTEMMESSAGE"]

   which is exactly the three columns the worksheet found in TEMP_UPLOAD. That
   is strong evidence the chain is:

       SP_SYNC_BATCH_COUNTS_TODAY()
         -> external function  -> POST /aggregate-data?table=Upload.TempUpload
         -> writes the result into DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TEMP_UPLOAD

   And the CXM-shaped rows the app showed are the OTHER endpoint — /query-data,
   which does SELECT * against the same SQL Server table and returns every lead
   column — landing in the same Snowflake table from a different caller.

   Sections 6 to 8 confirm or refute that.
============================================================================= */


-- 6. The external functions, and which API integration they use.
SHOW EXTERNAL FUNCTIONS IN ACCOUNT;

-- Their definitions include the endpoint path, so this shows which one is
-- pointed at /aggregate-data and which at /query-data.
SELECT FUNCTION_SCHEMA, FUNCTION_NAME, ARGUMENT_SIGNATURE, DATA_TYPE
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.FUNCTIONS
WHERE IS_EXTERNAL = 'YES'
ORDER BY 1, 2;

-- 7. Which procedures call an external function AND write TEMP_UPLOAD.
SELECT PROCEDURE_SCHEMA, PROCEDURE_NAME, ARGUMENT_SIGNATURE
FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_DEFINITION ILIKE '%TEMP_UPLOAD%'
   OR PROCEDURE_DEFINITION ILIKE '%aggregate-data%'
   OR PROCEDURE_DEFINITION ILIKE '%query-data%'
ORDER BY 1, 2;

-- 8. The decisive one — the actual statements that wrote the table, newest
--    first. A CREATE_TABLE_AS_SELECT here naming an external function tells you
--    which endpoint produced the shape currently in the table.
SELECT START_TIME, USER_NAME, ROLE_NAME, QUERY_TYPE,
       LEFT(QUERY_TEXT, 400) AS QUERY
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE QUERY_TEXT ILIKE '%DISTRIBUTION_AUTOMATION.TEMP_UPLOAD%'
  AND START_TIME > DATEADD(day, -7, CURRENT_TIMESTAMP())
ORDER BY START_TIME DESC
LIMIT 100;
