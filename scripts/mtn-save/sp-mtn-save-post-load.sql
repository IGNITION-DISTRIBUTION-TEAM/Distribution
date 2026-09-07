/* =============================================================================
   MTN SAVE (campaign 11204) — post-load procedure: DNC, then credit score
   -----------------------------------------------------------------------------
   The two statements that run against the HLL rows after they have landed, as
   one procedure, with a row count each — and with the bug that made the first
   of them do nothing at all.

       VW_MTN_SAVE_HLL_LOAD → TM_HLL_HISTORYLEADSLOADED
       SP_MTN_SAVE_POST_LOAD()                          ← this file
       SP_OPTINSTATUS_UPDATE(11204)
       SP_AUTORANK(11204, 20)
       SP_PHONENUMBERSCORING_UPDATE(11204)

   In app terms these are the UPDATE-HLL procedures, run in that order, and the
   order matters: this one writes SCORE and SCOREGROUP, and SP_AUTORANK reads
   them to set UDM30. Put AUTORANK first and it ranks on nulls.

   -----------------------------------------------------------------------------
   NO PARAMETERS, DELIBERATELY

   The DNC query needs the literals 'CL1' and '%MTN%'. The app's config field
   accepts only letters, digits, commas and spaces between a procedure's
   brackets, so a quoted string cannot be typed into Settings at all — it is
   rejected before it reaches Snowflake. Hard-coding them here is the only way
   this can be an app step, and it is the right trade: they are campaign
   identity, not a tuning knob. Campaign 11204 is hard-coded for the same
   reason it is in the view. If MTN Save ever splits into two campaigns, this
   procedure gains a parameter and a new grant (00-grants.sql section 7).

   -----------------------------------------------------------------------------
   THE FIX THAT MATTERS: DNC MAY NEVER HAVE BEEN APPLIED (defect 1)

   Your statement is

       update ...TM_HLL_HISTORYLEADSLOADED
          set estatus = 'DNC'
        where campaignid = '11204'
          and createdondate = current_date()          -- bare equality
          and right(CELLNUMBER, 9) in ( ... );

   Every other statement in your runbook that filters that column casts it
   first: the credit-score update two lines below uses
   `cast(a.CREATEDONDATE as date) = cast(current_date() as date)`, the ranking
   view uses `>= CURRENT_DATE()`. Your INSERT writes the column with
   `getdate()`, a TIMESTAMP. So `= current_date()` compared an instant against
   midnight, matched nothing, updated zero rows, and reported success.

   It is now cast on both sides, like every other statement. Belt and braces:
   the app writes CREATEDONDATE as CURRENT_DATE rather than getdate(), so the
   root cause is gone too — but a cast costs nothing and the HLL table holds
   history written by the old path.

   DNC is a do-not-call obligation, not a quality score. Run 00-grants.sql
   section 1 before the first run: if 1b returns zero, this has never worked on
   this campaign, and 1c tells you how many leads per load were affected.

   THE RETURN VALUE NOW SAYS SO. If the DNC statement matches nothing, the
   message says WARNING rather than letting a zero look like good news. On a
   file that genuinely contains no do-not-call numbers that warning is a false
   alarm, which is the correct direction for this one to fail in.

   -----------------------------------------------------------------------------
   THE CREDIT JOIN NOW WORKS FOR EVERY ROW (defect 4)

   Nothing in this file changed to achieve that. The join is

       AND a.UDM17 = S.idno

   and UDM17 is an ID number — but your second INSERT put ACCOUNT_NO there, so
   those rows could never match and got no SCORE and no SCOREGROUP. The single
   view in sp-mtn-save-hll-load.sql makes UDM17 mean ID_NUMBER on every row, so
   the join reaches all of them. The statement below is yours, unchanged.

   That has a knock-on worth knowing: the dialler view de-duplicates with
   `QUALIFY ROW_NUMBER() OVER (PARTITION BY PROVIDER_ACCOUNT_NUMBER ORDER BY
   SCORE DESC)`. With SCORE null on half the rows, that ordering was arbitrary.
   It will now pick differently — correctly, but differently — so expect the
   CXM file's contents to shift on the first run even where the row count does
   not.

   -----------------------------------------------------------------------------
   THREE THINGS I DID NOT CHANGE

   A. DNC OVERWRITES WHATEVER ESTATUS ALREADY SAID.
      There is no `AND ESTATUS IS NULL`, so a lead that was already 'INVALID ID'
      or 'DUPLICATE LEAD' is relabelled 'DNC'. Left as you wrote it: the lead is
      excluded either way, and if anything DNC is the label you would rather see
      on it. But it means the DNC count is not "leads I would otherwise have
      dialled" — section 4 splits it.

   B. UNION ALL, NOT UNION, IN THE DNC SUBQUERY.
      Kept byte-for-byte. It feeds an IN (...), so duplicates across the two
      lists cost a little time and change nothing. (00-grants.sql section 1c
      uses UNION, because there the number is the point.)

   C. THE COMMENTED-OUT `AND a.ESTATUS IS NULL` ON THE CREDIT UPDATE.
      Left commented, as in your script, so every row gets a score including the
      excluded ones. Harmless, and it means a lead that is later re-included
      already has its score.

   AND ONE STATEMENT THAT IS NOT HERE. Your

       update ...TM_HLL_HISTORYLEADSLOADED
          set FILENAME = 'Aug CPM base optin 12082026'
        where campaignid = '11204' and CREATEDONDATE = CURRENT_DATE()
          and filename = 'Data'

   is a hand patch with a hard-coded month in it, sitting under a comment about
   checking UDM21. Automating a statement whose literal has to be edited every
   month would guarantee it is wrong eleven months a year. FILENAME comes
   through from the file's own column via the view; if it arrives wrong, fix it
   in the file or in the view, not here.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the procedure

   EXECUTE AS OWNER, so the OWNER role needs SELECT on the two DNC sources and
   on CREDITRISK, plus UPDATE on the HLL table. 00-grants.sql section 7 lists
   them. A missing privilege compiles fine and fails at run time, and Snowflake
   reports it against the object rather than the procedure — so the error will
   not mention this file.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n_loaded   NUMBER DEFAULT 0;
    n_dnc      NUMBER DEFAULT 0;
    n_credit   NUMBER DEFAULT 0;
    n_unscored NUMBER DEFAULT 0;
    msg        VARCHAR DEFAULT '';
BEGIN

    -- How many rows this run is working on, so a zero further down can be told
    -- apart from "nothing was loaded".
    n_loaded := (
        SELECT COUNT(*)
          FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
         WHERE CAMPAIGNID = 11204
           AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
    );

    -- ---------------------------------------------------------------------- DNC
    -- Matched on the last nine digits, so a leading zero or a 27 prefix on
    -- either side does not matter. CAST on both sides of the date: see the
    -- header — the bare equality in the original never matched a timestamp.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
       SET ESTATUS = 'DNC'
     WHERE CAMPAIGNID = 11204
       AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
       AND RIGHT(CELLNUMBER, 9) IN (
               SELECT RIGHT(PHONENUMBER, 9)
                 FROM DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC
                WHERE CLUSTER = 'CL1'
                  AND (CAMPAIGN = 'GLOBAL' OR CAMPAIGN ILIKE '%MTN%')
               UNION ALL
               SELECT DISTINCT RIGHT(PHONENUMBER, 9)
                 FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
                WHERE CAMPAIGN_NAME ILIKE '%MTN%'
                  AND LEN(PHONENUMBER) = 9
           );
    n_dnc := SQLROWCOUNT;

    -- ------------------------------------------------------------- credit score
    -- Yours, unchanged. It works for every row now only because UDM17 means one
    -- thing — see the header and sp-mtn-save-hll-load.sql.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
       SET a.SCORE      = S.SCORE3,
           a.SCOREGROUP = S.SCOREGROUP3
      FROM DATAWAREHOUSE.DW_XDS.CREDITRISK S
     WHERE CAST(a.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
       AND a.CAMPAIGNID = 11204
       -- AND a.ESTATUS IS NULL      -- note C: commented in your script too
       AND a.UDM17 = S.IDNO;
    n_credit := SQLROWCOUNT;

    n_unscored := (
        SELECT COUNT(*)
          FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
         WHERE CAMPAIGNID = 11204
           AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
           AND SCORE IS NULL
    );

    -- ------------------------------------------------------------------ summary
    msg := 'MTN Save post-load done — ' || n_loaded || ' rows loaded today. '
        || 'marked DNC '      || n_dnc
        || ' | credit scored ' || n_credit
        || ' | still unscored ' || n_unscored;

    -- A zero DNC count is the failure mode this whole file exists for. Say it.
    IF (n_loaded > 0 AND n_dnc = 0) THEN
        msg := msg || ' | WARNING: NOT ONE lead was marked DNC.'
                   || ' Either this file genuinely contains no do-not-call'
                   || ' numbers, or the DNC sources are empty or unreachable.'
                   || ' Run 00-grants.sql section 1c before distributing.';
    END IF;

    IF (n_loaded > 0 AND n_unscored * 2 > n_loaded) THEN
        msg := msg || ' | WARNING: over half the rows have no credit score.'
                   || ' The dialler view de-duplicates by SCORE, so its choice'
                   || ' of row is close to arbitrary. Check UDM17 —'
                   || ' sp-mtn-save-hll-load.sql section 5d.';
    END IF;

    RETURN msg;

END;
$$;


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   All in 00-grants.sql section 7. The one line that must be re-run every single
   time the procedure above is replaced, because CREATE OR REPLACE PROCEDURE
   carries no grants and has no COPY GRANTS clause:

     GRANT USAGE ON PROCEDURE
       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()
       TO ROLE SVC_VERCEL_APP_ROLE;

   Verify from the app's own session, not a worksheet:
     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — are the DNC sources actually there?

   The warning in the return value cannot tell an empty list from a missing one.
   This can. Run it as ACCOUNTADMIN once, and again from a worksheet as
   SVC_VERCEL_APP_ROLE if the counts disagree — a role that cannot see a source
   gets an error, not a zero, but a role that cannot see the SCHEMA gets an
   error that reads like the object not existing.
-------------------------------------------------------------------------------- */

SELECT 'VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC (CL1, GLOBAL or MTN)' AS SOURCE,
       COUNT(*)                                               AS NUMBERS
  FROM DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC
 WHERE CLUSTER = 'CL1'
   AND (CAMPAIGN = 'GLOBAL' OR CAMPAIGN ILIKE '%MTN%')
UNION ALL
SELECT 'TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC (MTN, 9-digit)',
       COUNT(*)
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
 WHERE CAMPAIGN_NAME ILIKE '%MTN%'
   AND LEN(PHONENUMBER) = 9;

/* THE SECOND SOURCE'S `LEN(PHONENUMBER) = 9` IS WORTH A LOOK. It keeps only
   numbers stored WITHOUT a leading zero and without a country code. If that
   table stores some as '0821234567' (10) or '27821234567' (11), those rows are
   silently excluded from the DNC check — the filter and the RIGHT(...,9)
   comparison are doing the same normalising job twice, and only one of them is
   needed. This says whether it matters: */

SELECT LEN(PHONENUMBER) AS DIGITS,
       COUNT(*)         AS NUMBERS
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
 WHERE CAMPAIGN_NAME ILIKE '%MTN%'
 GROUP BY 1
 ORDER BY NUMBERS DESC;

/* If any row has DIGITS other than 9, dropping `AND LEN(PHONENUMBER) = 9` from
   the procedure widens the DNC check to cover them. RIGHT(PHONENUMBER, 9)
   already normalises, so nothing else has to change. I have not done it,
   because widening a do-not-call match is a compliance decision and it should
   be yours — but if that query returns more than one row, it is the next thing
   to fix after the cast. */


/* -----------------------------------------------------------------------------
   SECTION 4 — what the labels look like afterwards — note A

   DNC overwrites the earlier labels, so this is not a clean split. WOULD_HAVE
   is the number that were eligible before DNC touched them: that is the count
   that means "leads we would otherwise have dialled".

   Run it after the procedure. It needs the staging table to still hold the same
   file, which it will until the next upload.
-------------------------------------------------------------------------------- */

SELECT h.ESTATUS                                            AS HLL_LABEL,
       COUNT(*)                                             AS LEADS,
       COUNT_IF(s.ESTATUS IS NULL)                          AS WOULD_HAVE_BEEN_ELIGIBLE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
  LEFT JOIN DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND s
         ON s.ACCOUNT_NO = h.IDNUMBER
        AND s.ROWNUMB = 1
 WHERE h.CAMPAIGNID = 11204
   AND CAST(h.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
 GROUP BY 1
 ORDER BY LEADS DESC;


/* -----------------------------------------------------------------------------
   SECTION 5 — is CREDITRISK one row per ID?

   When an UPDATE ... FROM matches more than one source row, Snowflake picks one
   arbitrarily. If an ID can appear twice in CREDITRISK with different SCORE3
   values then the score a lead gets is not repeatable between runs — and the
   dialler view's de-duplication orders by SCORE, so the row that reaches CXM
   would not be repeatable either.

   MAX_ROWS_PER_ID of 1 means this does not apply.
-------------------------------------------------------------------------------- */

SELECT MAX(c)   AS MAX_ROWS_PER_ID,
       COUNT(*) AS IDS_WITH_MORE_THAN_ONE
  FROM (
        SELECT S.IDNO, COUNT(*) AS c
          FROM DATAWAREHOUSE.DW_XDS.CREDITRISK S
         WHERE EXISTS (
                 SELECT 1
                   FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
                  WHERE a.CAMPAIGNID = 11204
                    AND CAST(a.CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
                    AND a.UDM17 = S.IDNO)
         GROUP BY S.IDNO
        HAVING COUNT(*) > 1
       );


/* -----------------------------------------------------------------------------
   SECTION 6 — confirm, in this order

   1. 00-grants.sql section 1b, BEFORE the first run: has DNC ever worked?
   2. Run the load, then this procedure, from Manual → step 4. Read the
      returned message: it names both counts and warns on a zero.
   3. Section 4 above: the labels, and how many were eligible before DNC.
   4. sp-mtn-save-hll-load.sql section 5d: UDM17 looks like an ID on every row.
   5. THEN the other three update-HLL procedures, in config order.
   6. Only then the sync.

   If DNC still reports zero after all of that AND section 3 shows both sources
   populated, the remaining possibility is the phone format: CELLNUMBER holds
   0xxxxxxxxx after the prep procedure's normalisation, so RIGHT(...,9) is nine
   digits with no leading zero, and both DNC sources must yield the same nine.
   This is the query that settles it — it should return matching tails:

     SELECT RIGHT(CELLNUMBER, 9) AS TAIL
       FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
      WHERE CAMPAIGNID = 11204
        AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
      LIMIT 10;
-------------------------------------------------------------------------------- */
