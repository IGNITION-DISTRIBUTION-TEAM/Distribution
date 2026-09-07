/* =============================================================================
   MTN SAVE (campaign 11204) — the MOD-22 ranking override
   -----------------------------------------------------------------------------
   DEPLOYS NOTHING AND IS NOT AN APP STEP. Run it by hand, on the days you are
   asked to re-rank, AFTER the update-HLL steps and BEFORE the sync.

   Your runbook heads this block

       --- RANK DATA, ONLY IF THEY ASK US TOO RANK DATA ---

   so it is not part of the daily run and it is not automated. Two other reasons
   it could not be, even if you wanted it to be:

   1. IT WOULD FIGHT SP_AUTORANK OVER THE SAME COLUMN. SP_AUTORANK(11204, 20) is
      an update-HLL step and it sets UDM30 to 1-20. This spreads leads across
      1-22. Two automated steps writing UDM30 with different ranges would make
      the dialling spread depend on which ran last — and the run log would show
      both succeeding.

   2. THE TEMP TABLE CANNOT SURVIVE BEING SPLIT UP. Every app step runs in its
      own Snowflake session, and a TEMP table lives and dies with its session.
      Split across three config steps, the second statement would not find the
      table the first created. As one script in one worksheet it is fine.

   NOTE THE RANGE MISMATCH BEFORE YOU RUN IT: 22 here against SP_AUTORANK's 20.
   If the campaign dials over 22 working days then SP_AUTORANK's second argument
   should be 22 in the config and this script is only needed when the spread has
   to ignore score groups. If it dials over 20, then this script's 22 is wrong
   and two days' worth of leads never get dialled. One of the two is stale.
   Section 1 shows which range is actually in the data.

   -----------------------------------------------------------------------------
   FIVE THINGS ABOUT THIS BLOCK, INCLUDING THE TWO THAT WILL NOT COMPILE
============================================================================= */

/* -----------------------------------------------------------------------------
   SECTION 1 — where the ranking currently stands

   Run this first. It answers the 20-vs-22 question and tells you whether
   SP_AUTORANK ran at all.
-------------------------------------------------------------------------------- */

SELECT UDM30,
       COUNT(*) AS LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
 GROUP BY UDM30
 ORDER BY LEADS DESC;

-- Eligible leads only, which is what the spread is actually for.
SELECT MIN(UDM30)                        AS LOWEST_DAY,
       MAX(UDM30)                        AS HIGHEST_DAY,
       COUNT(DISTINCT UDM30)             AS DISTINCT_DAYS,
       COUNT_IF(UDM30 IS NULL)           AS UNRANKED,
       COUNT(*)                          AS ELIGIBLE_LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
   AND ESTATUS IS NULL;

/* HIGHEST_DAY of 20 means SP_AUTORANK is in charge and this script would change
   the spread. UNRANKED equal to ELIGIBLE_LEADS means SP_AUTORANK did not run —
   check the update-HLL procedure order in the config before ranking by hand. */


/* -----------------------------------------------------------------------------
   SECTION 2 — the statement I am NOT giving you, and why

   Your block opens with this:

       update ...TM_HLL_HISTORYLEADSLOADED
          set CREATEDONDATE = CURRENT_DATE()
        where campaignid = '11204'
          and CREATEDONDATE = CURRENT_DATE() - 1
          AND ESTATUS iS NOT NULL

   It moves YESTERDAY'S EXCLUDED LEADS forward to today's load date. That is not
   a ranking statement and it is not harmless:

     - it rewrites history. Yesterday's exclusions become today's, so
       yesterday's load appears to have contained fewer leads than it did and
       today's appears to have contained more.
     - every date filter downstream then sees them. This file's ranking view,
       the credit-score update, the DNC statement, both output views and the
       reconciliation all filter on CREATEDONDATE = today. Leads that were
       already labelled and finished with are pulled back into all of them.
     - it uses the same bare `CREATEDONDATE = CURRENT_DATE() - 1` equality that
       stopped DNC from ever working. If CREATEDONDATE is a timestamp, this
       statement has been matching nothing — which is very likely the only
       reason the above has not caused visible trouble.

   I have not reproduced it. If there is a real need behind it — re-presenting
   yesterday's excluded leads for a second look, say — that wants its own batch
   name and its own load, not a rewritten date. If it is only there to make a
   reporting query line up, the query is the thing to change.

   Say the word and I will write whichever of those you actually want.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — the two statements that will not compile — defect 7

   Two of your statements are literally

       set UDM30 =
       where a.hll_Id in (...)

   with nothing after the equals sign. They are a syntax error, so this whole
   block has never run as written. They read as "put the SKY leads on day X and
   the Data leads on day Y", with X and Y depending on the daily volumes you
   worked out by hand in the comment above them:

       Integrated = 8358 (distributed)  9277 (total)
       SKY        = 302  (distributed)  348  (total)
       Data       = 9157 (distributed)  9923 (total)
       302 / 13 per day / R1 TO R22 = 14 / R23 = 379

   Only you know those numbers for a given day, so the value stays a placeholder
   below. Fill in the day, run the statement, and delete the guard.

   AND FOR MTN SAVE BOTH ARE INERT ANYWAY. They filter on `b.udm21 = 'SKY'` and
   `b.udm21 = 'Data'`, and NOTHING IN THE MTN SAVE PIPELINE POPULATES UDM21 —
   it is commented out in both of your INSERTs, and TYPE_CAT does not exist in
   the staging table. So even once the syntax is fixed they match zero rows. If
   the SKY/Data/Integrated split is real for this campaign then UDM21 has to be
   filled in VW_MTN_SAVE_HLL_LOAD first, and there is no column in the file to
   fill it from. That is worth resolving before ranking by hand at all: the
   three numbers in the comment above suggest someone WAS splitting the base
   three ways, and the pipeline cannot currently tell the three apart.

   The guard is deliberate. It makes both statements no-ops until edited, so
   pasting this file whole can never write a wrong day.
-------------------------------------------------------------------------------- */

-- 3a. Your hand adjustment: move day 20 down to day 19.
--     This one IS complete in your script and is left exactly as written.
UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
   SET UDM30 = 19
 WHERE a.HLL_ID IN (
        SELECT b.HLL_ID
          FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED b
         WHERE b.CAMPAIGNID = 11204
           AND CAST(b.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
           AND b.UDM30 = 20
           AND b.ESTATUS IS NULL
       );

-- 3b. The SKY leads. REPLACE THE 0 AND DELETE THE `AND 1 = 0` LINE.
UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
   SET UDM30 = 0                          -- ← the day. Placeholder.
 WHERE 1 = 0                              -- ← delete this line to arm it.
   AND a.HLL_ID IN (
        SELECT b.HLL_ID
          FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED b
         WHERE b.CAMPAIGNID = 11204
           AND CAST(b.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
           AND b.UDM30 IS NULL
           AND b.UDM21 = 'SKY'            -- nothing populates UDM21 — see above
           AND b.ESTATUS IS NULL
       );

-- 3c. The Data leads. Same two edits.
UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
   SET UDM30 = 0                          -- ← the day. Placeholder.
 WHERE 1 = 0                              -- ← delete this line to arm it.
   AND a.HLL_ID IN (
        SELECT b.HLL_ID
          FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED b
         WHERE b.CAMPAIGNID = 11204
           AND CAST(b.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
           AND b.UDM30 IS NULL
           AND b.UDM21 = 'Data'           -- nothing populates UDM21 — see above
           AND b.ESTATUS IS NULL
       );


/* -----------------------------------------------------------------------------
   SECTION 4 — the MOD-22 spread

   Yours, with three things worth knowing and none of them changed.

   A. THE RANKING VIEW HAS NO ESTATUS FILTER, so it ranks the excluded leads
      alongside the eligible ones. They take up positions in the ROW_NUMBER
      sequence, which means each day gets fewer dialable leads than 1/22 of the
      eligible pool — and unevenly, since exclusions are not spread evenly
      across score groups. Adding `AND a.ESTATUS IS NULL` to the view fixes
      that; I have left it out because it changes the daily volumes and section
      6 counts what it is worth first.

   B. RANKLEADS IS COMPUTED AND NEVER USED.
          ROUND(COUNT(*) OVER (PARTITION BY SCOREGROUP) / 22, 0) AS RANKLEADS
      The update below uses `1 + MOD(UPDATEDRANK - 1, 22)` instead, which does
      not need it. Kept, because it is genuinely useful to look at: it is the
      leads-per-day each score group is contributing.

   C. `ORDER BY SCORE` IS ASCENDING, SO THE LOWEST SCORE GETS DAY 1.
      Whether that is right depends on which end of your credit scale is good,
      and I do not know. Everything else in this pipeline that expresses a
      preference orders by SCORE DESC — the CXM view's de-duplication does. If
      the best leads should be dialled first, this needs DESC. Section 6 shows
      the score distribution per day so you can see which way round it came out.

   D. THE UPDATE JOINS ON IDNUMBER, WHICH IS NOT UNIQUE.
      Two HLL rows for one IDNUMBER — the same person on two accounts, which
      this campaign has by construction since IDNUMBER is ACCOUNT_NO — both
      match the same source row and both get the same day. That is probably what
      you want (one customer, one call), but it means a day's count is a count
      of rows, not of people.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_LEAD_RANKING AS
SELECT
    IDNUMBER,
    CAMPAIGNID,
    SCOREGROUP,
    ROW_NUMBER() OVER (PARTITION BY SCOREGROUP ORDER BY SCORE)          AS UPDATEDRANK,
    ROUND(COUNT(*) OVER (PARTITION BY SCOREGROUP) / 22, 0)              AS RANKLEADS,
    CURRENT_DATE()                                                      AS CREATEDONDATE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
 WHERE CREATEDONDATE >= CURRENT_DATE()
   AND a.CAMPAIGNID = 11204;
   -- note A: AND a.ESTATUS IS NULL   ← consider it, then see section 6

/* THE TEMP TABLE IS WHY THIS IS ONE SCRIPT. It lives and dies with the
   worksheet session, so the three statements below must run together, in this
   order, in the same worksheet. Fully qualifying a TEMP table's name also means
   it SHADOWS any permanent table of that name for the rest of the session —
   harmless here, worth knowing if one is ever created. */

CREATE OR REPLACE TEMP TABLE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TMP_LEAD_DISTRIBUTION AS
SELECT
    IDNUMBER,
    CAMPAIGNID,
    SCOREGROUP,
    UPDATEDRANK,
    RANKLEADS,
    CAST(NULL AS NUMBER(2,0)) AS UDM30
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_LEAD_RANKING;

UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TMP_LEAD_DISTRIBUTION
   SET UDM30 = 1 + MOD(UPDATEDRANK - 1, 22);

UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED AS tgt
   SET tgt.UDM30 = src.UDM30
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TMP_LEAD_DISTRIBUTION AS src
 WHERE tgt.IDNUMBER  = src.IDNUMBER
   AND tgt.CAMPAIGNID = src.CAMPAIGNID
   AND tgt.CREATEDONDATE >= CURRENT_DATE();


/* -----------------------------------------------------------------------------
   SECTION 5 — cleaning up

   VW_LEAD_RANKING is a PERMANENT view in a shared schema and it is hard-coded
   to campaign 11204. Nothing else in this repo references it, but its name says
   nothing about which campaign it serves, so another campaign's ranking script
   copied from this one would silently replace it.

   Leave it if it is already part of your routine. If not, drop it when you are
   done and this script recreates it next time:

     -- DROP VIEW DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_LEAD_RANKING;

   The TEMP table needs no cleanup; it goes when the worksheet session ends.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 6 — check the spread before the sync

   Run every one of these. The ranking is the last thing to touch the data
   before it leaves, and a bad spread is invisible in the file — it only shows
   up as a day with no leads on it, a week later.
-------------------------------------------------------------------------------- */

-- 6a. The spread itself. 22 rows, LEADS roughly equal, no NULL row among the
--     eligible leads.
SELECT UDM30                                    AS DIAL_DAY,
       COUNT(*)                                 AS LEADS,
       COUNT_IF(ESTATUS IS NULL)                AS ELIGIBLE,
       MIN(SCORE)                               AS LOWEST_SCORE,
       MAX(SCORE)                               AS HIGHEST_SCORE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
 GROUP BY UDM30
 ORDER BY DIAL_DAY;

/* READ THE SCORE COLUMNS — that is note C. If day 1's LOWEST_SCORE and
   HIGHEST_SCORE are the bottom of the range and day 22's are the top, the
   ascending ORDER BY is putting your worst leads out first. Whether that is
   wrong depends on your scale, but it should be a decision. */

-- 6b. Note A: what filtering the ranking view to eligible leads would be worth.
--     EXCLUDED_TAKING_UP_SLOTS is how many ranking positions are spent on leads
--     that will never be dialled.
SELECT COUNT(*)                                                AS RANKED_ROWS,
       COUNT_IF(ESTATUS IS NOT NULL)                           AS EXCLUDED_TAKING_UP_SLOTS,
       ROUND(100 * COUNT_IF(ESTATUS IS NOT NULL) / COUNT(*), 1) AS PCT_WASTED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE);

-- 6c. Nothing unranked, and nothing outside 1-22.
SELECT COUNT_IF(UDM30 IS NULL)                  AS UNRANKED,
       COUNT_IF(UDM30 < 1 OR UDM30 > 22)        AS OUTSIDE_RANGE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
   AND ESTATUS IS NULL;

/* THEN, AND ONLY THEN, RUN THE SYNC — Manual → step 5. The CXM view reads
   UDM30 as DATA_DAY_RANK, so the extract has to happen after this, not before.
   If you have already extracted or emailed today's file, re-run those steps:
   the file they produced carries the old ranking. */
