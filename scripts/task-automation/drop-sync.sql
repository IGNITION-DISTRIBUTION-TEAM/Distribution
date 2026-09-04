/* =============================================================================
   REMOVE A SYNC FROM SNOWFLAKE — task, procedure, staging table, stage
   -----------------------------------------------------------------------------
   "Remove" in Current jobs deletes ONE row: the app's registry entry in
   DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_CONFIGS. That is deliberate —
   an app should not drop a table holding loaded data because someone pressed a
   bin icon — but it means the job disappears from the list while everything it
   built carries on existing, and the TASK CARRIES ON RUNNING.

   THIS SCRIPT DOES NOT DROP THE TARGET TABLE. That is the loaded data and the
   reason the sync existed; section 5 shows how if you ever want to, and is
   commented out.

   Careful about the word "table": a sync builds TWO. STG_<NAME> is the
   transient staging buffer, truncated at the start of every run, and section 3
   drops it. The target table is a different object with an unrelated name and
   nothing here touches it.

   SET THE THREE VARIABLES BELOW AND NOTHING ELSE. Section 0 then prints the
   exact statements for that sync, ready to copy — so the name is typed once
   rather than pasted into ten DROPs, which on a destructive script is where the
   wrong object gets dropped.

   Run as a role that owns the objects, or ACCOUNTADMIN.

   WHAT A REMOVED JOB LEAVES BEHIND, in the order it matters:

     1. TSK_SFTP_SYNC_<NAME>    the task. STILL SCHEDULED. Suspend it first.
     2. SP_SFTP_SYNC_<NAME>     the procedure.
     3. STG_<NAME>              the transient staging table.
     4. STG_SFTP_<NAME>         the internal stage, and any files still in it.
     5. the TARGET table        the loaded data. NOT dropped here.
     6. SFTP_SYNC_CONTROL row   the change-detection watermark. See section 6 —
                                this is the one that bites later.
     7. TSK_SFTP_SYNC_RUNS rows the run history. Harmless; kept on purpose.
============================================================================= */

SET SYNC   = 'ARPU_DASHBOARD_FEES4';   -- the sync name, exactly as the job list shows it
SET DB     = 'SPOT_DW';
SET SCHEMA = 'SPOT_SFTP';


/* -----------------------------------------------------------------------------
   0a — WHAT IS ACTUALLY THERE

   Run this first. Snowflake reports "does not exist" and "not authorized" the
   same way, so an empty result means one or the other, not necessarily that the
   object is already gone.
-------------------------------------------------------------------------------- */

/* INFORMATION_SCHEMA, not SHOW: `SHOW ... LIKE` takes a string LITERAL, so a
   session variable cannot be concatenated into the pattern. These are plain
   SELECTs, where $SYNC works. Tasks have no INFORMATION_SCHEMA view at all, so
   the SHOW TASKS you need is generated as copy-paste text in section 0b.

   These list only what your role has privileges on, so an empty result means
   absent OR invisible — the same ambiguity Snowflake reports at run time. */

SELECT 'procedure' AS KIND, PROCEDURE_NAME AS NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.PROCEDURES')
 WHERE PROCEDURE_SCHEMA = $SCHEMA AND PROCEDURE_NAME = 'SP_SFTP_SYNC_' || $SYNC
UNION ALL
SELECT 'staging table', TABLE_NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.TABLES')
 WHERE TABLE_SCHEMA = $SCHEMA AND TABLE_NAME = 'STG_' || $SYNC
UNION ALL
SELECT 'stage', STAGE_NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.STAGES')
 WHERE STAGE_SCHEMA = $SCHEMA AND STAGE_NAME = 'STG_SFTP_' || $SYNC;

/* Read the target table out of the registry BEFORE you remove the job — the
   sync name and the target table name are independent, and at least one of
   these was built with ARPU_DASHBOARD_FEES4 pointing at ARPU_DASHBOARD_FEES3.
   Once the registry row is gone, so is the record of where the data went. */

SELECT SYNC_NAME, TARGET_DB, TARGET_SCHEMA, TARGET_TABLE, CREATE_TABLE,
       SCHEDULE_CRON, DEPLOYED_AT, DEPLOYED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_CONFIGS
 WHERE SYNC_NAME = $SYNC;

SELECT * FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL WHERE SOURCE_NAME = $SYNC;


/* -----------------------------------------------------------------------------
   0b — THE STATEMENTS, BUILT FOR YOU

   Run this and copy the seven lines it returns. They are the same statements
   described in sections 1-4, with the names already filled in.
-------------------------------------------------------------------------------- */

WITH q AS (SELECT $DB || '.' || $SCHEMA AS S, $SYNC AS N)
SELECT 0 AS STEP, 'SHOW TASKS LIKE ''TSK_SFTP_SYNC_' || N || ''' IN SCHEMA ' || S || ';' AS RUN_THIS FROM q
UNION ALL SELECT 1, 'ALTER TASK IF EXISTS '     || S || '.TSK_SFTP_SYNC_' || N || ' SUSPEND;' FROM q
UNION ALL SELECT 2, 'DROP TASK IF EXISTS '      || S || '.TSK_SFTP_SYNC_' || N || ';'         FROM q
UNION ALL SELECT 3, 'DROP PROCEDURE IF EXISTS ' || S || '.SP_SFTP_SYNC_'  || N || '();'       FROM q
UNION ALL SELECT 4, 'LIST @'                    || S || '.STG_SFTP_'      || N || ';'         FROM q
UNION ALL SELECT 5, 'DROP TABLE IF EXISTS '     || S || '.STG_'           || N || ';'         FROM q
UNION ALL SELECT 6, 'DROP STAGE IF EXISTS '     || S || '.STG_SFTP_'      || N || ';'         FROM q
 ORDER BY STEP;

/* Step 0 is the one to run first and read: it is the only way to see the task,
   because Snowflake has no INFORMATION_SCHEMA view for tasks. If it returns
   nothing, either the task is already gone or the sync name is wrong — and a
   wrong name makes every DROP below succeed against nothing at all. */


/* -----------------------------------------------------------------------------
   1 — STOP THE SCHEDULE FIRST

   Do this before anything else. A task whose procedure has been dropped still
   fires; it just fails every time, quietly, at whatever hour it was set to.
-------------------------------------------------------------------------------- */

-- Steps 1 and 2 from section 0b.
--   ALTER TASK IF EXISTS <db>.<schema>.TSK_SFTP_SYNC_<name> SUSPEND;
--   DROP  TASK IF EXISTS <db>.<schema>.TSK_SFTP_SYNC_<name>;


/* -----------------------------------------------------------------------------
   2 — THE PROCEDURE

   The signature is () — it takes no arguments — and DROP needs it.
-------------------------------------------------------------------------------- */

-- Step 3 from section 0b. The signature is () — it takes no arguments, and
-- DROP PROCEDURE needs it.


/* -----------------------------------------------------------------------------
   3 — THE STAGING TABLE

   Transient, truncated at the start of every run, holds nothing you want.
-------------------------------------------------------------------------------- */

-- Step 5 from section 0b. This is STG_<name>, the staging buffer — NOT the
-- target table, which is a different object and is not dropped by this script.


/* -----------------------------------------------------------------------------
   4 — THE STAGE, AND ANYTHING STILL SITTING IN IT

   The generated procedure copies with PURGE = TRUE, so a normal run leaves the
   stage empty. A TEST LOAD copies with PURGE = FALSE on purpose — so the real
   first run still had a file to fetch — which means a sync that was tested but
   never ran can still be holding downloaded data here. Look before you drop.
-------------------------------------------------------------------------------- */

-- Steps 4 and 6 from section 0b. LIST first: the stage can still hold files.


/* -----------------------------------------------------------------------------
   5 — THE TARGET TABLE  (deliberately not dropped)

   This is the loaded data — the reason the sync existed. Nothing above touches
   it. Check what is in it, and only then decide.

   Note it may not be named after the sync: the sync name and the target table
   name are independent, and several of these were built with one pointing at
   another. Read TARGET_DB / TARGET_SCHEMA / TARGET_TABLE from section 7 below
   BEFORE you remove the registry row, or you lose the record of where it went.
-------------------------------------------------------------------------------- */

-- Take TARGET_DB / TARGET_SCHEMA / TARGET_TABLE from the registry query in
-- section 0a — the target is NOT named after the sync.
--
--   SELECT COUNT(*) FROM <target_db>.<target_schema>.<target_table>;
--   DROP TABLE       <target_db>.<target_schema>.<target_table>;


/* -----------------------------------------------------------------------------
   6 — THE CONTROL ROW.  THE ONE THAT BITES LATER.

   DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL keeps one row per sync holding
   LAST_MODIFIED — the mtime of the newest file successfully ingested. The app
   has SELECT, INSERT and UPDATE on that table but deliberately NO DELETE, so
   removing a job cannot touch it.

   Which means: RECREATE A SYNC WITH THE SAME NAME AND IT INHERITS THE OLD
   WATERMARK. The generated control-row statement is INSERT ... WHERE NOT
   EXISTS, so it will not reset an existing row — and the new sync reports
   NO_CHANGE for every file it already loaded, looking like it works while
   loading nothing.

   Delete the row if the name may be reused and you want a clean baseline.
   Leave it if you are only pausing and will want the change detection intact.
-------------------------------------------------------------------------------- */

-- DELETE FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL WHERE SOURCE_NAME = $SYNC;

/* Or keep the row and just rewind it, which is the same thing without losing
   the record that the sync ever existed:

   UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
      SET LAST_MODIFIED = '1970-01-01'::TIMESTAMP_NTZ, STATUS = 'BASELINE_SET'
    WHERE SOURCE_NAME = $SYNC;                                                 */


/* -----------------------------------------------------------------------------
   7 — THE RUN HISTORY

   Kept on purpose: it is the record of what the sync moved, it costs nothing,
   and it is the only place rows-per-run was ever written down.
-------------------------------------------------------------------------------- */

SELECT STARTED_AT, STATUS, FILES, ROWS_LOADED, MESSAGE
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_RUNS
 WHERE SYNC_NAME = $SYNC
 ORDER BY STARTED_AT DESC;

-- DELETE FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_RUNS
--  WHERE SYNC_NAME = $SYNC;


/* -----------------------------------------------------------------------------
   8 — CONFIRM IT WORKED

   All four SHOWs should return no rows, and the target table should still be
   there with its data. "It ran without erroring" is not the same as "the task
   is gone" — DROP ... IF EXISTS succeeds happily against a name that never
   existed, which is exactly what a typo in the sync name looks like.
-------------------------------------------------------------------------------- */

/* Re-run the section 0a query — it should now return no rows at all. */

SELECT 'procedure' AS KIND, PROCEDURE_NAME AS NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.PROCEDURES')
 WHERE PROCEDURE_SCHEMA = $SCHEMA AND PROCEDURE_NAME = 'SP_SFTP_SYNC_' || $SYNC
UNION ALL
SELECT 'staging table', TABLE_NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.TABLES')
 WHERE TABLE_SCHEMA = $SCHEMA AND TABLE_NAME = 'STG_' || $SYNC
UNION ALL
SELECT 'stage', STAGE_NAME
  FROM IDENTIFIER($DB || '.INFORMATION_SCHEMA.STAGES')
 WHERE STAGE_SCHEMA = $SCHEMA AND STAGE_NAME = 'STG_SFTP_' || $SYNC;

/* Then re-run step 0 from section 0b for the task. */

/* And the data is still where it was — substitute the target from section 0a:

   SELECT COUNT(*) FROM <target_db>.<target_schema>.<target_table>;            */
