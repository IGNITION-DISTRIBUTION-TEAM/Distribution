/* =============================================================================
   SP_AUTORANK_V2 reported success and nothing is ranked
   -----------------------------------------------------------------------------
   It said "Done." because the CALL did not raise an error. That is all "Done."
   ever meant — the app was discarding the statement's return value, which for a
   CALL is the procedure's own report of what it changed. That is fixed, so
   re-running the step now prints whatever SP_AUTORANK_V2 actually says. Do that
   first; if it returns a message, it will very likely name the reason and the
   rest of this file is unnecessary.

   THE CONFIGURED CALL, from Settings, is

       DATAWAREHOUSE.LEADS_DISTRIBUTION.SP_AUTORANK_V2(11058, 8)

   so the arguments ARE being passed and the campaign id is right. An earlier
   version of this file guessed the app was calling it bare, from its
   predecessor SP_AUTORANK(11381, 5) in the Spot Connect script; that guess was
   wrong and the candidate is struck. Note the schema too — LEADS_DISTRIBUTION,
   not DISTRIBUTION_DATA_APPLICATION where the other two update procedures live.

   That leaves three candidates, in order of likelihood.

   1. ONLY STEP 4 WAS RUN.
      The screenshot shows steps 1, 2 and 3 with no status and step 4 ticked.
      SP_VCD_VCCVM_POST_LOAD is step 1, and it is what fills SCORE and
      SCOREGROUP:

          SET a.SCORE = s.SCORE3, a.SCOREGROUP = s.SCOREGROUP3
          FROM DW_XDS.CREDITRISK s ... AND a.ESTATUS IS NULL

      A ranking almost certainly ranks on score. With SCORE still NULL on every
      row there is nothing to order, so a correct procedure would rank nothing
      and succeed. Section 1 settles this in one query, and the fix is to press
      "Run all 4 in order" rather than step 4 on its own.

   2. IT DOES NOT WRITE UDM30.
      UDM30 is where you expect the rank. Section 3 asks the table which
      columns actually changed, rather than trusting either of us. Section 2's
      GET_DDL answers it outright.

   3. IT RANKS A DIFFERENT DAY, OR THE SECOND ARGUMENT MEANS SOMETHING ELSE.
      Spot Connect passes 5 where you pass 8. If that is a bucket count, fine;
      if it is a day window, a batch size or a score band, 8 may exclude
      everything. Only the body says. Section 4 looks for ranks anywhere in the
      table, so a procedure that worked on the wrong scope shows up as ranks in
      the wrong place rather than as nothing at all.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — is there anything to rank?

   The single most likely answer. If HAS_SCORE is 0 while ELIGIBLE is not, then
   step 1 has not run and the ranking had nothing to work with.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                              AS LEADS_TODAY,
       COUNT_IF(ESTATUS IS NULL)                             AS ELIGIBLE,
       COUNT_IF(ESTATUS IS NULL AND SCORE IS NOT NULL)       AS ELIGIBLE_WITH_SCORE,
       COUNT_IF(ESTATUS IS NULL AND SCOREGROUP IS NOT NULL)  AS ELIGIBLE_WITH_SCOREGROUP,
       COUNT_IF(ESTATUS IS NULL AND UDM30 IS NOT NULL)       AS ELIGIBLE_WITH_RANK,
       COUNT_IF(UDM29 IS NOT NULL)                           AS HAS_VOICE_DATA_FLAG
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE();

/* READING IT
     ELIGIBLE_WITH_SCORE = 0        step 1 has not run. Run all 4 in order.
     HAS_VOICE_DATA_FLAG = 0        confirms it — UDM29 is also set by step 1.
     ELIGIBLE_WITH_SCORE > 0        there was something to rank, so the problem
                                    is in SP_AUTORANK_V2 itself: sections 2-4. */


/* -----------------------------------------------------------------------------
   SECTION 2 — READ THE BODY. This is the one that actually answers it.

   GET_DDL prints the procedure. It settles every remaining question at once:
   which column it writes, what it orders on, what the second argument means,
   and whether it filters on a date. Run as ACCOUNTADMIN.
-------------------------------------------------------------------------------- */

SELECT GET_DDL('PROCEDURE',
  'DATAWAREHOUSE.LEADS_DISTRIBUTION.SP_AUTORANK_V2(NUMBER, NUMBER)') AS BODY;

-- If that errors on the signature, take the exact types from here first.
SHOW PROCEDURES LIKE 'SP_AUTORANK%' IN ACCOUNT;

SELECT PROCEDURE_CATALOG, PROCEDURE_SCHEMA, PROCEDURE_NAME,
       ARGUMENT_SIGNATURE, PROCEDURE_OWNER
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.PROCEDURES
 WHERE PROCEDURE_NAME LIKE 'SP_AUTORANK%';

/* WATCH FOR TWO PROCEDURES UNDER ONE NAME. If SHOW returns both a
   (NUMBER, NUMBER) and some other signature, the app calls whichever matches
   the brackets in the config — and an older copy left behind from a previous
   version is a very quiet way to run last month's logic. Drop what you are not
   using. */


/* -----------------------------------------------------------------------------
   SECTION 3 — which columns did it actually write?

   Rather than assuming UDM30, ask which of the UDM columns hold anything for
   today's eligible leads. A rank shows up as a small set of repeated values.
-------------------------------------------------------------------------------- */

SELECT 'UDM28' AS COL, COUNT_IF(UDM28 IS NOT NULL) AS POPULATED,
       COUNT(DISTINCT UDM28) AS DISTINCT_VALUES
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058 AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
UNION ALL SELECT 'UDM29', COUNT_IF(UDM29 IS NOT NULL), COUNT(DISTINCT UDM29)
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058 AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
UNION ALL SELECT 'UDM30', COUNT_IF(UDM30 IS NOT NULL), COUNT(DISTINCT UDM30)
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058 AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
UNION ALL SELECT 'SCORE', COUNT_IF(SCORE IS NOT NULL), COUNT(DISTINCT SCORE)
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058 AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
UNION ALL SELECT 'SCOREGROUP', COUNT_IF(SCOREGROUP IS NOT NULL), COUNT(DISTINCT SCOREGROUP)
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058 AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
 ORDER BY COL;


/* -----------------------------------------------------------------------------
   SECTION 4 — did it rank the wrong scope?

   If UDM30 is populated for another campaign or another day, the procedure
   works and is simply not looking at today's 11058. Nothing back at all means
   it has never written UDM30 and candidate 3 is the answer.
-------------------------------------------------------------------------------- */

SELECT CAMPAIGNID,
       CAST(CREATEDONDATE AS DATE)     AS LOADED,
       COUNT(*)                        AS LEADS,
       COUNT_IF(UDM30 IS NOT NULL)     AS RANKED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAST(CREATEDONDATE AS DATE) >= DATEADD(day, -7, CURRENT_DATE())
 GROUP BY 1, 2
HAVING COUNT_IF(UDM30 IS NOT NULL) > 0
 ORDER BY LOADED DESC, CAMPAIGNID;


/* -----------------------------------------------------------------------------
   SECTION 5 — one caveat about the ordering of your four procedures

   SP_VCD_VCCVM_POST_LOAD sets ESTATUS = 'DNC' and then refreshes SCORE only
   where ESTATUS IS NULL. So DNC leads deliberately reach SP_AUTORANK_V2 with
   no score. Whether that ranks them last, ranks them first, or errors depends
   on how the procedure treats a NULL score — and it is the final step, so
   nothing after it would catch the problem.

   This shows what the ranking did with the scoreless leads once it runs:
-------------------------------------------------------------------------------- */

SELECT IFNULL(ESTATUS, '(eligible)')          AS ESTATUS,
       IFNULL(UDM30::VARCHAR, '(no rank)')    AS RANK,
       COUNT(*)                               AS LEADS,
       COUNT_IF(SCORE IS NULL)                AS OF_WHICH_NO_SCORE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
 GROUP BY 1, 2
 ORDER BY ESTATUS, RANK;
