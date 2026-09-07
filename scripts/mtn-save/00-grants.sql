/* =============================================================================
   MTN SAVE (campaign 11204) — grants, and size every defect before you fix one
   -----------------------------------------------------------------------------
   RUN THIS FILE FIRST. Sections 1-6a change nothing; they measure what your
   current runbook is actually doing, so that when the corrected version reports
   different numbers you know which fixes moved them and by how much. Section 7
   is the grants, and section 8 is the order of the rest of the folder.

   Thirteen defects, found reading the runbook line by line and then watching
   the first real upload. Two stop it compiling; NINE ARE SILENT — they run,
   report success, and do nothing. Section by section below, worst first. The
   SQL fixes live in the other files in this folder; nothing here writes.

     §1  DNC may never have been applied            silent, and a legal problem
     §2  every labelled lead loaded into HLL twice  silent, doubles volumes
     §3  three phone enrichments never fire         silent
     §4  UDM17 means two things, breaking credit    silent, half the rows
     §5  RECOMMENDATION_1..6 never populated        silent — FIXED, see below
     §6  the CTAS revokes the app's own access      silent until the next upload
     §7  two statements will not compile            loud
     §8  drop column "row" before it exists         loud on a clean run
     §9  replace(EXTRADATA,'') missing an argument   loud
     §10 the dialler view reads three empty columns  silent
     §11 cte2..cte5 built, joined, never read        harmless, but unfinished
     §12 the emailed file uses the WRONG layout      silent, and it is not SQL
     §13 ID numbers loaded as '6.31008E+12'          silent, and unrepairable

   TWO OF THE THIRTEEN ARE NOT SQL FIXES, so they are not in the sections below:

   DEFECT 12 — with no export layout saved for 11204, the app's Email data step
   emails a file built to SPOT CONNECT 1's layout, which puts a save offer in a
   column headed "Address". Six edits in Settings, written up in
   sp-mtn-save-dialler.sql section 6. Do it before the first email, not after.

   DEFECT 13 — the first upload put the string '6.31008E+12' into ID_NUMBER for
   every row. The upload was handing Snowflake Excel's on-screen rendering
   rather than the underlying value, and Excel's General format switches to
   scientific notation at 12 digits — which is why an 11-digit MSISDN survived
   and a 13-digit ID did not. Nothing errored; the column is VARCHAR, so the
   text was stored as given, and every join on the ID number silently matched
   nothing: all five XDS enrichments, the credit-risk join via UDM17, and the
   INVALID ID check. SIX OF THE THIRTEEN DIGITS SURVIVE, so no SQL can rebuild
   them — an affected batch can only be re-uploaded. Fixed in the app
   (lib/upload-cell-text.ts); section 6a is the check that it stayed fixed.

   Run as ACCOUNTADMIN. INFORMATION_SCHEMA shows only what the current role can
   see, so a worksheet run as anything narrower will under-report.

   SECTIONS 3, 4 AND 5 READ COLUMNS THAT SP_MTN_SAVE_PREP CREATES — ESTATUS,
   RECOMMENDATION_1..6 and ROWNUMB. On a table that has never been through the
   procedure they fail with "invalid identifier", which is an answer rather than
   a problem: it means the ALTER ADDs have not been run either. Deploy
   sp-mtn-save-prep.sql, upload a file, run the procedure once, then come back.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — HAS DNC EVER BEEN APPLIED TO THIS CAMPAIGN? (defect 1)

   Your DNC statement filters

       and createdondate = current_date()          -- bare equality

   while every other statement in the runbook that touches the same column casts
   it first: the credit-score update uses
   `cast(a.CREATEDONDATE as date) = cast(current_date() as date)`, the ranking
   view uses `>= CURRENT_DATE()`. The INSERT writes the column with `getdate()`,
   which is a TIMESTAMP. If the column is a timestamp then `= current_date()`
   compares an instant against midnight and matches NOTHING — no error, zero
   rows, and a clean-looking run.

   1a settles what the column actually is. 1b is the finding.
-------------------------------------------------------------------------------- */

-- 1a. The column's declared type. TIMESTAMP_* here means the bare equality in
--     your DNC statement can only ever match a row loaded at exactly midnight.
SELECT COLUMN_NAME, DATA_TYPE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'DISTRIBUTION_DATA_APPLICATION'
   AND TABLE_NAME   = 'TM_HLL_HISTORYLEADSLOADED'
   AND COLUMN_NAME IN ('CREATEDONDATE', 'LEADEXPIRY', 'HLL_ID', 'UDM17', 'UDM30');

-- 1b. Has a single lead on 11204 ever been marked DNC? ZERO IS THE FINDING.
--     Not scoped to today, deliberately: the question is whether it has EVER
--     worked, not whether it worked this morning.
SELECT COUNT(*)                                        AS DNC_MARKED_EVER,
       MIN(CAST(CREATEDONDATE AS DATE))                AS FIRST_DAY,
       MAX(CAST(CREATEDONDATE AS DATE))                AS LAST_DAY
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND ESTATUS = 'DNC';

-- 1c. And how many SHOULD have been, on the most recent load day. If 1b is zero
--     and this is not, that is the number of leads dialled off a do-not-call
--     list — per load.
WITH LOADED AS (
    SELECT CELLNUMBER
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
     WHERE CAMPAIGNID = 11204
       AND CAST(CREATEDONDATE AS DATE) = (
             SELECT MAX(CAST(CREATEDONDATE AS DATE))
               FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
              WHERE CAMPAIGNID = 11204)
), DNC AS (
    SELECT RIGHT(PHONENUMBER, 9) AS TAIL
      FROM DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC
     WHERE CLUSTER = 'CL1'
       AND (CAMPAIGN = 'GLOBAL' OR CAMPAIGN ILIKE '%MTN%')
    UNION
    SELECT DISTINCT RIGHT(PHONENUMBER, 9)
      FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
     WHERE CAMPAIGN_NAME ILIKE '%MTN%'
       AND LEN(PHONENUMBER) = 9
)
SELECT COUNT(*) AS SHOULD_HAVE_BEEN_DNC
  FROM LOADED
 WHERE RIGHT(CELLNUMBER, 9) IN (SELECT TAIL FROM DNC);

/* NOTE ON THE UNION. Your original uses UNION ALL across the two DNC sources,
   which is correct for an IN (...) — duplicates cost time, not correctness. The
   count above uses UNION so the number is not inflated by a phone number that
   appears on both lists. SP_MTN_SAVE_POST_LOAD keeps UNION ALL, byte-for-byte
   as you wrote it, because there it feeds an IN and the result is identical. */


/* -----------------------------------------------------------------------------
   SECTION 2 — THE DOUBLE LOAD (defect 2)

   Your two INSERTs overlap. The first reads cte1, which is `"row" = 1` with no
   ESTATUS condition. The second reads `WHERE ESTATUS IS NOT NULL` with no row
   condition. A row-1 lead labelled 'INVALID ID' or 'Incorrect Cell Number'
   satisfies both and lands twice — with DIFFERENT IDNUMBERs, because the two
   INSERTs disagree about which column that is (defect 4).

   This counts the damage in what is already loaded.
-------------------------------------------------------------------------------- */

SELECT CAST(CREATEDONDATE AS DATE)                          AS LOAD_DAY,
       COUNT(*)                                             AS ROWS_LOADED,
       COUNT(DISTINCT IDNUMBER)                             AS DISTINCT_IDS,
       COUNT(*) - COUNT(DISTINCT IDNUMBER)                  AS EXCESS,
       COUNT_IF(ESTATUS IS NOT NULL)                        AS LABELLED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
 GROUP BY 1
 ORDER BY LOAD_DAY DESC
 LIMIT 20;

/* EXCESS is not proof on its own — one person can legitimately appear on two
   accounts. But if EXCESS tracks LABELLED closely, that is the double load.
   The corrected pipeline is ONE unfiltered view, so ROWS_LOADED will equal the
   staging row count exactly and EXCESS will drop by roughly LABELLED. */


/* -----------------------------------------------------------------------------
   SECTION 3 — THE THREE DEAD PHONE ENRICHMENTS (defect 3)

       where HOME_PHONE_NO = null          -- three occurrences

   `x = null` is UNKNOWN, never TRUE, so the two XDS HOME_PHONE_NO enrichments
   and the HOME_PHONE_NO = work_phone_no fallback have never updated a row. This
   is how many rows they would have filled, on the data currently in staging.

   Run it AFTER an upload and BEFORE running the prep procedure, or it measures
   yesterday's file.
-------------------------------------------------------------------------------- */

SELECT COUNT(*) AS HOME_PHONE_NO_NULL,
       COUNT_IF(EXISTS (
           SELECT 1 FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
            WHERE b.IDENTIFIERNUMBER = a.ID_NUMBER
              AND b.HOME1 IS NOT NULL))               AS COULD_GET_HOME1,
       COUNT_IF(WORK_PHONE_NO IS NOT NULL)            AS COULD_GET_WORK_PHONE
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
 WHERE HOME_PHONE_NO IS NULL;


/* -----------------------------------------------------------------------------
   SECTION 4 — UDM17 MEANS TWO THINGS (defect 4)

   The first INSERT writes `a.ID_NUMBER as UDM17`; the second writes
   `a.ACCOUNT_NO as UDM17`. The credit-risk update then joins
   `a.UDM17 = S.idno` — an ID number — so it can only ever score the rows that
   came from the first INSERT. Rows from the second get no SCORE and no
   SCOREGROUP, and SCORE is what the dialler view orders its dedupe by.
-------------------------------------------------------------------------------- */

SELECT CAST(CREATEDONDATE AS DATE)              AS LOAD_DAY,
       COUNT(*)                                 AS ROWS_LOADED,
       COUNT_IF(SCORE IS NULL)                  AS NO_CREDIT_SCORE,
       COUNT_IF(SCOREGROUP IS NULL)             AS NO_SCOREGROUP,
       -- UDM17 that does not look like an ID number at all:
       COUNT_IF(UDM17 IS NOT NULL AND LEN(UDM17) <> 13) AS UDM17_NOT_AN_ID
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
 GROUP BY 1
 ORDER BY LOAD_DAY DESC
 LIMIT 20;


/* -----------------------------------------------------------------------------
   SECTION 5 — RECOMMENDATION_1..6 (defect 5) — RESOLVED, VERIFY IT

   The cause was the column ORDER, not a missing split. Your CREATE TABLE
   declares 24 columns and the seven ALTER ADDs for ESTATUS and
   RECOMMENDATION_1..6 run AFTER the load — so the columns did not exist when
   the file was read. The file's recommendation columns had nowhere to land, and
   nothing afterwards ever filled them. The six comma-strip UPDATEs at the top
   of the runbook were operating on columns empty on every row, and UDM5-8,
   UDM14-16 and UDM18-20 reached the dialler blank.

   The file does carry the six. 01-staging-table.sql declares them up front, so
   they load with everything else.

   5a confirms it on the staging table after an upload; 5b confirms it reached
   the HLL. On a table that has never been through the fixed path both come back
   zero, which is the old behaviour rather than a new fault.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                     AS ROWS_IN_STAGING,
       COUNT_IF(RECOMMENDATION   IS NOT NULL
                AND TRIM(RECOMMENDATION) <> '')     AS HAS_RECOMMENDATION,
       COUNT_IF(RECOMMENDATION_1 IS NOT NULL)       AS HAS_REC_1,
       COUNT_IF(RECOMMENDATION_2 IS NOT NULL)       AS HAS_REC_2,
       COUNT_IF(RECOMMENDATION_3 IS NOT NULL)       AS HAS_REC_3,
       COUNT_IF(RECOMMENDATION_4 IS NOT NULL)       AS HAS_REC_4,
       COUNT_IF(RECOMMENDATION_5 IS NOT NULL)       AS HAS_REC_5,
       COUNT_IF(RECOMMENDATION_6 IS NOT NULL)       AS HAS_REC_6
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;

-- 5b. And what reached the dialler. Every column here at zero on a load run
--     through the fixed path means the six are not being mapped — check the
--     upload's mapping step, which lists each file header and its target.
SELECT CAST(CREATEDONDATE AS DATE)         AS LOAD_DAY,
       COUNT(*)                            AS ROWS_LOADED,
       COUNT_IF(UDM5  IS NOT NULL AND TRIM(UDM5)  <> '') AS UDM5_SET,
       COUNT_IF(UDM14 IS NOT NULL AND TRIM(UDM14) <> '') AS UDM14_SET,
       COUNT_IF(UDM18 IS NOT NULL AND TRIM(UDM18) <> '') AS UDM18_SET
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
 GROUP BY 1
 ORDER BY LOAD_DAY DESC
 LIMIT 10;

/* IF HAS_RECOMMENDATION IS ALSO HIGH, the file carries the singular column as
   well as the six and nothing is discarding it — 01-staging-table.sql keeps it
   for exactly that reason. Nothing reads it downstream; worth knowing whether
   it duplicates RECOMMENDATION_1 or holds something else:

     SELECT LEFT(RECOMMENDATION, 120)   AS SINGULAR,
            LEFT(RECOMMENDATION_1, 120) AS FIRST_NUMBERED,
            COUNT(*)                    AS ROWS_LIKE_THIS
       FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
      GROUP BY 1, 2 ORDER BY ROWS_LIKE_THIS DESC LIMIT 20; */


/* -----------------------------------------------------------------------------
   SECTION 6 — THE CTAS REVOKES THE APP'S OWN ACCESS (defect 6)

   Your duplicate-check step is

       create or replace table ...TM_MU2_MTNSAVESOUTBOUND as
       select a.*, ROW_NUMBER() ... as "row" from ...TM_MU2_MTNSAVESOUTBOUND a;

   with no COPY GRANTS — unlike the CREATE TABLE at the top of the runbook,
   which has it. CREATE OR REPLACE TABLE without COPY GRANTS drops every grant
   on the table, including the SELECT/INSERT/DELETE the file upload needs. So
   the first run works and the NEXT upload fails with "does not exist or not
   authorized", pointing at the upload rather than at the statement that broke
   it. SP_MTN_SAVE_PREP carries COPY GRANTS.

   This is what the table's grants look like right now. SVC_VERCEL_APP_ROLE
   should appear with SELECT, INSERT and DELETE. If it appears with nothing, the
   CTAS has already eaten them and section 7 puts them back.
-------------------------------------------------------------------------------- */

SHOW GRANTS ON TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;


/* -----------------------------------------------------------------------------
   SECTION 6a — DID THE ID NUMBERS SURVIVE THE UPLOAD? (defect 13)

   RUN THIS IMMEDIATELY AFTER EVERY UPLOAD, before the prep procedure. It is the
   one check whose answer cannot be fixed later: a mangled ID keeps 6 of its 13
   digits, so an affected batch has to be re-uploaded from the file, not
   repaired in place.

   STILL_MANGLED must be 0. Anything else means the app build doing the upload
   does not have the parser fix — stop and re-upload once it does. The preview
   screen says the same thing earlier and louder: it raises a banner counting
   the cells it expanded out of scientific notation.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                    AS ROWS_LOADED,
       COUNT_IF(ID_NUMBER ILIKE '%E+%')            AS STILL_MANGLED,
       COUNT_IF(LEN(ID_NUMBER) = 13)               AS LOOKS_LIKE_AN_ID,
       COUNT_IF(MSISDN    ILIKE '%E+%')            AS MSISDN_MANGLED,
       COUNT_IF(ACCOUNT_NO ILIKE '%E+%')           AS ACCOUNT_NO_MANGLED
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;

-- 6a-ii. The same question of the HLL, which is where it actually costs money:
--        UDM17 is the credit-risk join key. Not scoped to today — the question
--        is whether any historical batch is affected.
SELECT CAST(CREATEDONDATE AS DATE)                 AS LOAD_DAY,
       COUNT(*)                                    AS ROWS_LOADED,
       COUNT_IF(IDNUMBER ILIKE '%E+%')             AS IDNUMBER_MANGLED,
       COUNT_IF(UDM17    ILIKE '%E+%')             AS UDM17_MANGLED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
 GROUP BY 1
HAVING COUNT_IF(IDNUMBER ILIKE '%E+%') > 0
    OR COUNT_IF(UDM17 ILIKE '%E+%') > 0
 ORDER BY LOAD_DAY DESC;

/* AN EMPTY RESULT FROM 6a-ii IS THE GOOD ONE — no load day has a mangled ID.
   Any row it returns names a batch whose IDs are unrecoverable: the leads were
   loaded, dialled against no credit score and no enriched numbers, and the only
   remedy is to re-upload that file and re-sync. */


/* -----------------------------------------------------------------------------
   SECTION 7 — the grants for the whole MTN Save chain

   Run as ACCOUNTADMIN. Safe to re-run, and it must be re-run after every
   CREATE OR REPLACE PROCEDURE — that statement carries no grants and has no
   COPY GRANTS clause. The views in this folder do have COPY GRANTS, so
   replacing them keeps theirs.

   USAGE ON SCHEMA comes first and matters most. Without it every object inside
   is invisible however it is granted, and Snowflake reports it identically to
   the object not existing.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                             TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION                  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION       TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE SVC_VERCEL_APP_ROLE;

-- The upload target. DELETE rather than TRUNCATE: Snowflake has no grantable
-- TRUNCATE privilege — it requires OWNERSHIP — so the app clears the table with
-- DELETE FROM. Nothing to grant for that beyond DELETE.
GRANT SELECT, INSERT, DELETE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The two procedures. Signatures are part of a procedure's identity, so a
-- signature change needs the NEW signature granted — the old grant does not
-- follow it.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The HLL load view. A non-secure view does not launder access: the app reads
-- it as itself and needs SELECT on the view AND on the table underneath.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_MTN_SAVE_HLL_LOAD
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The HLL target. The load inserts; the post-load procedure and the two
-- downstream views read and update.
GRANT SELECT, INSERT, UPDATE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The SilverSurfer feed and the sync procedure that pushes it.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION.VW_AD_MTNSAVESOUTBOUNDSILVERSURFER
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE(VARCHAR, VARCHAR, VARCHAR, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The CXM dialler view, and the two scalar functions it and the SilverSurfer
-- view call. A missing function grant fails as "Unknown user-defined function",
-- which reads exactly like a missing view.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION.VW_KM_MTN_SAVES_OUTBOUND_DIALER_AUTOMATION
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON FUNCTION
  DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(VARCHAR)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON FUNCTION
  DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(VARCHAR)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The three shared update-HLL procedures, already granted for other campaigns.
-- Here for a fresh environment; harmless to re-run.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

/* THE OWNER ROLE NEEDS ITS OWN PRIVILEGES.
   Both procedures are EXECUTE AS OWNER, so the role that CREATEs them does the
   work — SVC_VERCEL_APP_ROLE only needs USAGE to call them. Replace SYSADMIN
   below if you create them as something else. A missing privilege here compiles
   fine and fails at run time, and Snowflake reports it against the OBJECT, so
   the error will not mention this file. */

GRANT USAGE ON DATABASE DATAWAREHOUSE                             TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION                  TO ROLE SYSADMIN;
GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION           TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DW_XDS                        TO ROLE SYSADMIN;
GRANT SELECT ON VIEW  DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS      TO ROLE SYSADMIN;
GRANT SELECT ON TABLE DATAWAREHOUSE.DW_XDS.CREDITRISK             TO ROLE SYSADMIN;
GRANT SELECT, UPDATE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SYSADMIN;
GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC      TO ROLE SYSADMIN;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC      TO ROLE SYSADMIN;

-- SP_MTN_SAVE_PREP does CREATE OR REPLACE TABLE and ALTER TABLE on the upload
-- target, and both require OWNERSHIP, not a grant. Only if it is not already
-- owned by the creating role:
--   GRANT OWNERSHIP ON TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
--     TO ROLE SYSADMIN COPY CURRENT GRANTS;


/* -----------------------------------------------------------------------------
   SECTION 8 — is everything reachable, and what to run next

   8a asks what exists. It is not the definitive test: INFORMATION_SCHEMA shows
   only what YOUR role can see, so run it as ACCOUNTADMIN and it tells you what
   exists, not what the app can reach.
-------------------------------------------------------------------------------- */

SELECT 'procedure' AS KIND, PROCEDURE_NAME AS NAME, ARGUMENT_SIGNATURE AS SIG
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
 WHERE PROCEDURE_NAME IN ('SP_MTN_SAVE_PREP', 'SP_MTN_SAVE_POST_LOAD',
                          'SP_SYNC_TO_SQLSERVER_LARGE')
UNION ALL
SELECT 'view', TABLE_NAME, NULL
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.VIEWS
 WHERE TABLE_NAME IN ('VW_MTN_SAVE_HLL_LOAD',
                      'VW_AD_MTNSAVESOUTBOUNDSILVERSURFER',
                      'VW_KM_MTN_SAVES_OUTBOUND_DIALER_AUTOMATION');

/* 8b. THE DEFINITIVE TEST IS THE APP'S OWN SESSION, not a worksheet. This
   endpoint runs SHOW as the app's role and reports visibleToApp:

     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP
     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_MTN_SAVE_HLL_LOAD

   8c. THEN, IN THIS ORDER:

     0. 01-staging-table.sql          section 1 — the upload target table
     1. sp-mtn-save-prep.sql          section 1 — the cleansing procedure
     2. sp-mtn-save-hll-load.sql      section 1 — the load view
     3. sp-mtn-save-post-load.sql     section 1 — DNC and credit score
     4. sp-mtn-save-silversurfer.sql  section 1 — the SilverSurfer feed
     5. sp-mtn-save-dialler.sql       section 1 — the CXM view
     6. re-run SECTION 7 of this file — the two CREATE OR REPLACE PROCEDUREs
        above have just dropped their grants
     7. type the config into Settings (sp-mtn-save-hll-load.sql section 4)
     8. FIX THE EXPORT LAYOUT — six edits, sp-mtn-save-dialler.sql section 6.
        Defect 12. Nothing above catches this one and the file goes out wrong.
     9. upload one file, then run SECTION 6a before anything else — defect 13
        is the only one that cannot be fixed after the fact
    10. run the steps one at a time from Manual → step 3, reading each step's
        row count against the sections above

   99-rank-on-request.sql is NOT part of the automated run. It is the MOD-22
   override, for the days you are asked to rank. Run it by hand, after the
   update-HLL steps and before the sync. */
