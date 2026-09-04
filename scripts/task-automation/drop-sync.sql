/* =============================================================================
   REMOVE A SYNC FROM SNOWFLAKE
   -----------------------------------------------------------------------------
   "Remove" in Current jobs deletes ONE row: the app's registry entry in
   DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_CONFIGS. That is deliberate —
   an app should not drop a table holding loaded data because someone pressed a
   bin icon — but it means the job disappears from the list while everything it
   built carries on existing, and the TASK CARRIES ON RUNNING.

   Replace <<NAME>> with the sync name and <<DB>>.<<SCHEMA>> with where it was
   created (SPOT_DW.SPOT_SFTP unless you changed it), then work down. Run as a
   role that owns the objects, or ACCOUNTADMIN.

   WHAT IS LEFT BEHIND, in the order it matters:

     1. TSK_SFTP_SYNC_<<NAME>>   the task. STILL SCHEDULED. Suspend it first.
     2. SP_SFTP_SYNC_<<NAME>>    the procedure.
     3. STG_<<NAME>>             the transient staging table.
     4. STG_SFTP_<<NAME>>        the internal stage, and any files still in it.
     5. the TARGET table          holds the loaded data. Not dropped below.
     6. SFTP_SYNC_CONTROL row     the change-detection watermark. See section 6 —
                                  this is the one that bites later.
     7. TSK_SFTP_SYNC_RUNS rows   the run history. Harmless; kept on purpose.
============================================================================= */


/* -----------------------------------------------------------------------------
   0 — WHAT IS ACTUALLY THERE

   Run this first. Snowflake reports "does not exist" and "not authorized" the
   same way, so an empty result here means one or the other, not necessarily
   that the object is gone.
-------------------------------------------------------------------------------- */

SHOW TASKS      LIKE 'TSK_SFTP_SYNC_<<NAME>>' IN SCHEMA <<DB>>.<<SCHEMA>>;
SHOW PROCEDURES LIKE 'SP_SFTP_SYNC_<<NAME>>'  IN SCHEMA <<DB>>.<<SCHEMA>>;
SHOW TABLES     LIKE 'STG_<<NAME>>'           IN SCHEMA <<DB>>.<<SCHEMA>>;
SHOW STAGES     LIKE 'STG_SFTP_<<NAME>>'      IN SCHEMA <<DB>>.<<SCHEMA>>;

SELECT * FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL WHERE SOURCE_NAME = '<<NAME>>';


/* -----------------------------------------------------------------------------
   1 — STOP THE SCHEDULE FIRST

   Do this before anything else. A task whose procedure has been dropped still
   fires; it just fails every time, quietly, at whatever hour it was set to.
-------------------------------------------------------------------------------- */

ALTER TASK IF EXISTS <<DB>>.<<SCHEMA>>.TSK_SFTP_SYNC_<<NAME>> SUSPEND;
DROP  TASK IF EXISTS <<DB>>.<<SCHEMA>>.TSK_SFTP_SYNC_<<NAME>>;


/* -----------------------------------------------------------------------------
   2 — THE PROCEDURE

   The signature is () — it takes no arguments — and DROP needs it.
-------------------------------------------------------------------------------- */

DROP PROCEDURE IF EXISTS <<DB>>.<<SCHEMA>>.SP_SFTP_SYNC_<<NAME>>();


/* -----------------------------------------------------------------------------
   3 — THE STAGING TABLE

   Transient, truncated at the start of every run, holds nothing you want.
-------------------------------------------------------------------------------- */

DROP TABLE IF EXISTS <<DB>>.<<SCHEMA>>.STG_<<NAME>>;


/* -----------------------------------------------------------------------------
   4 — THE STAGE, AND ANYTHING STILL SITTING IN IT

   The generated procedure copies with PURGE = TRUE, so a normal run leaves the
   stage empty. A TEST LOAD copies with PURGE = FALSE on purpose — so the real
   first run still had a file to fetch — which means a sync that was tested but
   never ran can still be holding downloaded data here. Look before you drop.
-------------------------------------------------------------------------------- */

LIST @<<DB>>.<<SCHEMA>>.STG_SFTP_<<NAME>>;
DROP STAGE IF EXISTS <<DB>>.<<SCHEMA>>.STG_SFTP_<<NAME>>;


/* -----------------------------------------------------------------------------
   5 — THE TARGET TABLE  (deliberately not dropped)

   This is the loaded data — the reason the sync existed. Nothing above touches
   it. Check what is in it, and only then decide.

   Note it may not be named after the sync: the sync name and the target table
   name are independent, and several of these were built with one pointing at
   another. Read TARGET_DB / TARGET_SCHEMA / TARGET_TABLE from section 7 below
   BEFORE you remove the registry row, or you lose the record of where it went.
-------------------------------------------------------------------------------- */

-- SELECT COUNT(*) FROM <<DB>>.<<SCHEMA>>.<<TARGET_TABLE>>;
-- DROP TABLE <<DB>>.<<SCHEMA>>.<<TARGET_TABLE>>;


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

-- DELETE FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL WHERE SOURCE_NAME = '<<NAME>>';

/* Or keep the row and just rewind it, which is the same thing without losing
   the record that the sync ever existed:

   UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
      SET LAST_MODIFIED = '1970-01-01'::TIMESTAMP_NTZ, STATUS = 'BASELINE_SET'
    WHERE SOURCE_NAME = '<<NAME>>';                                            */


/* -----------------------------------------------------------------------------
   7 — WHAT THE APP STILL KNOWS

   The registry row is what "Remove" deleted, so this returns nothing for a
   removed job. Run it BEFORE removing one if you want its target table and the
   exact SQL that built it — DEPLOYED_SQL holds every statement.

   The run history is kept on purpose: it is the record of what the sync moved,
   and it costs nothing.
-------------------------------------------------------------------------------- */

SELECT SYNC_NAME, TARGET_DB, TARGET_SCHEMA, TARGET_TABLE, CREATE_TABLE,
       SCHEDULE_CRON, DEPLOYED_AT, DEPLOYED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_CONFIGS
 WHERE SYNC_NAME = '<<NAME>>';

SELECT STARTED_AT, STATUS, FILES, ROWS_LOADED, MESSAGE
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_RUNS
 WHERE SYNC_NAME = '<<NAME>>'
 ORDER BY STARTED_AT DESC;

-- DELETE FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_RUNS
--  WHERE SYNC_NAME = '<<NAME>>';
