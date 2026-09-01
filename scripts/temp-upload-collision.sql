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
