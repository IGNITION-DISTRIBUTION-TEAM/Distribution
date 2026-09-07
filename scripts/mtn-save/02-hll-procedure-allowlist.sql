/* =============================================================================
   MTN SAVE (campaign 11204) — the update-HLL override dropdown
   -----------------------------------------------------------------------------
   OPTIONAL. YOU DO NOT NEED THIS TO RUN THE CAMPAIGN.

   The four update-HLL procedures in the config are run by the campaign's own
   steps, which do not consult this table at all. This script exists for one
   narrower purpose: Tools → Update HLL has a free-text OVERRIDE box with a
   dropdown, the dropdown is populated from TSK_HLL_UPDATE_PROCEDURES, and the
   override is the one place a procedure name arrives from the browser rather
   than from a saved config. Adding these rows makes MTN Save's procedures
   pickable there, for the days you want to re-run one on its own.

   -----------------------------------------------------------------------------
   WHAT THIS TABLE IS, AND WHAT CHANGED

   It is an allowlist of procedures the app may CALL as an update-HLL step. It
   used to be checked with an EXACT string match against the whole call string,
   which had two consequences:

     - A campaign configured with SP_AUTORANK(11204,20) was refused against a
       row reading SP_AUTORANK. Every campaign therefore needed its own rows for
       the same handful of procedures, one per argument list.
     - It was enforced on Tools → Update HLL but NOT on the campaign's own step
       4, which runs through a different code path. So it gated the weaker
       screen: SP_MTN_SAVE_POST_LOAD() was rejected from the tab while step 4
       would have run the identical procedure unchecked.

   Both are fixed in the app. The check now compares the procedure IDENTITY —
   everything before the "(" — and applies only to the override. So:

     ONE ROW PER PROCEDURE, WITH NO ARGUMENTS, COVERS EVERY CAMPAIGN.

   That is why the rows below are bare names. Do not add argument lists; they
   would still match, but they would suggest the arguments mean something here,
   and they do not.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — what is in there now

   Run this first. Two of the four may well be listed already — SP_AUTORANK and
   SP_OPTINSTATUS_UPDATE are shared across campaigns and predate MTN Save,
   possibly with an argument list attached from whichever campaign added them.
   Either form matches now, so a row like SP_AUTORANK(11058,20) needs no fixing.
-------------------------------------------------------------------------------- */

SELECT PROC_INDEX,
       PROC_NAME,
       SPLIT_PART(PROC_NAME, '(', 1) AS IDENTITY_MATCHED_ON,
       CREATED_AT
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES
 ORDER BY PROC_INDEX;

-- 1b. Which of the four are already reachable. Anything returning FALSE here is
--     what section 2 adds; anything TRUE needs nothing.
WITH WANTED AS (
    SELECT 'DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD'            AS PROC_NAME
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE'
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK'
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE'
)
SELECT w.PROC_NAME,
       EXISTS (
         SELECT 1
           FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES t
          WHERE UPPER(TRIM(SPLIT_PART(t.PROC_NAME, '(', 1))) = UPPER(w.PROC_NAME)
       ) AS ALREADY_REACHABLE
  FROM WANTED w
 ORDER BY 2, 1;


/* -----------------------------------------------------------------------------
   SECTION 2 — add the ones that are missing

   PROC_INDEX is the primary key and has no autoincrement, so the indexes are
   derived from MAX rather than hard-coded — a hard-coded 5 collides the moment
   someone else has added a row.

   The NOT EXISTS makes this safe to re-run and safe to run against a table that
   already holds some of the four: it inserts only what is not already
   reachable, matching on identity exactly as the app does.
-------------------------------------------------------------------------------- */

INSERT INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES (PROC_INDEX, PROC_NAME)
WITH WANTED AS (
    SELECT 'DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD'            AS PROC_NAME
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE'
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK'
    UNION ALL SELECT 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE'
), MISSING AS (
    SELECT w.PROC_NAME
      FROM WANTED w
     WHERE NOT EXISTS (
             SELECT 1
               FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES t
              WHERE UPPER(TRIM(SPLIT_PART(t.PROC_NAME, '(', 1))) = UPPER(w.PROC_NAME))
), BASE AS (
    SELECT IFNULL(MAX(PROC_INDEX), 0) AS N
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES
)
SELECT (SELECT N FROM BASE) + ROW_NUMBER() OVER (ORDER BY m.PROC_NAME) AS PROC_INDEX,
       m.PROC_NAME
  FROM MISSING m;


/* -----------------------------------------------------------------------------
   SECTION 3 — grants

   The app READS this table on the Tools tab and on the config screen's "import
   from the shared list" button, and the unused POST on /api/hll-procedures
   would write to it. SELECT is what is actually needed.

   INSERT is granted here only because that POST exists; nothing in the UI calls
   it today, and with identity matching this table should stop growing. If you
   would rather the app never write to it, drop the INSERT — the app will not
   notice, and this script is how rows get added.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                          TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION         TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 4 — confirm

   Re-run section 1b. All four should read TRUE.

   Then, in the app — and this is the part worth reading:

     RUN THE FOUR PROCEDURES FROM THE CAMPAIGN'S OWN STEPS, NOT FROM THE TOOLS
     TAB. Manual → step 4 lists them as four separate steps, "Update HLL —
     <name>", in the order the config gives. Tools → Update HLL runs ONE
     procedure — the first of the list — so used on its own it would run the
     post-load procedure and silently skip the opt-in update, the ranking and
     the phone scoring.

   The order matters and only the steps honour it: SP_MTN_SAVE_POST_LOAD writes
   SCORE and SCOREGROUP, and SP_AUTORANK reads them to set UDM30. Run AUTORANK
   first and it ranks on nulls.
-------------------------------------------------------------------------------- */
