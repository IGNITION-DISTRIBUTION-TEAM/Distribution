/* =============================================================================
   SETTLE ONE UNVERIFIED QUESTION: how does Snowflake combine day-of-month and
   day-of-week in USING CRON when BOTH are restricted?
   -----------------------------------------------------------------------------
   Unix cron ORs them — the job runs on the 1st of the month OR on any Monday.
   Quartz refuses the combination outright. I could not confirm which Snowflake
   does: docs.snowflake.com is unreachable from the environment the app was
   written in, and nothing in the repository pins it.

   Until it is settled, lib/cron-schedule.ts REFUSES any expression that
   restricts both fields. That is not caution for its own sake: the app shows
   the next five run times, and to render them it would have to pick AND or OR
   — so one of the two readings would be presented to the operator as fact.

   Run this as a role that can create and resume a task, then set
   DOM_DOW_COMBINATION in lib/cron-schedule.ts to "and" or "or". One constant,
   one place; `dayMatches` already reads it.

   The probe task does SELECT 1. It costs one warehouse resume.
============================================================================= */

/* 1 September 2026 is a Tuesday, so "the 1st" and "a Monday" are different days
   and the answer is unambiguous:
     next run on the 1st of a month  -> AND
     next run on the coming Monday   -> OR                                     */

CREATE OR REPLACE TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE
    WAREHOUSE = SPOT_WH
    SCHEDULE  = 'USING CRON 0 6 1 * 1 Africa/Johannesburg'
AS
    SELECT 1;

/* If CREATE fails outright, that is itself the answer: Snowflake rejects the
   combination the way Quartz does, and the app's refusal matches Snowflake's.
   Record that and stop here. */

ALTER TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE RESUME;

/* A suspended task has no next scheduled time, which is why it is resumed
   above. Read the answer from whichever of these your account exposes — I have
   not verified that TASK_HISTORY surfaces FUTURE scheduled rows, so try both
   and use the one that returns something. */

SHOW TASKS LIKE 'TSK_CRON_PROBE' IN SCHEMA SPOT_DW.SPOT_SFTP;
-- Look for a scheduled-time column in the output.

SELECT NAME, STATE, SCHEDULED_TIME, QUERY_START_TIME
  FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
       TASK_NAME => 'TSK_CRON_PROBE',
       SCHEDULED_TIME_RANGE_START => CURRENT_TIMESTAMP()))
 ORDER BY SCHEDULED_TIME;

/* Clean up — do not leave a probe task resumed on a warehouse. */
ALTER TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE SUSPEND;
DROP TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE;

/* -----------------------------------------------------------------------------
   WHILE YOU ARE HERE — the four schedules the app has been offering since it
   was written have never been confirmed against Snowflake either. Range-with-
   step is the least universal construct of the set. Each of these should
   create without error; if one does not, narrow the grammar in
   lib/cron-schedule.ts to match and the app will stop offering it.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE
    WAREHOUSE = SPOT_WH SCHEDULE = 'USING CRON 0 6-18/2 * * * Africa/Johannesburg'
AS SELECT 1;

CREATE OR REPLACE TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE
    WAREHOUSE = SPOT_WH SCHEDULE = 'USING CRON 0 7,19 * * * Africa/Johannesburg'
AS SELECT 1;

CREATE OR REPLACE TASK SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE
    WAREHOUSE = SPOT_WH SCHEDULE = 'USING CRON 30 5 * * 1-5 Africa/Johannesburg'
AS SELECT 1;

DROP TASK IF EXISTS SPOT_DW.SPOT_SFTP.TSK_CRON_PROBE;
