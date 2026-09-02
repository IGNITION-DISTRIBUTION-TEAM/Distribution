/* =============================================================================
   VC CVM — lead preparation procedure
   -----------------------------------------------------------------------------
   Your eleven statements against
       DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
   as one procedure, in the same order, with the same effect — plus a row count
   per statement so the app's run log tells you what actually happened rather
   than just "succeeded".

   Run it after the file upload has loaded the table, as an update-HLL step:

       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP('11058', 90, 6)

   The first argument is QUOTED. It is a VARCHAR so that the history check can
   take a list, and Snowflake resolves a procedure on its argument types — an
   unquoted 11058 is a NUMBER and can be rejected outright with "invalid
   argument types", which is the same wall you hit on SP_ONAIR_U5_BALANCED_POOL.

   -----------------------------------------------------------------------------
   FIVE THINGS I CHANGED, AND WHY

   1. THE cell2 STATEMENT POINTED AT THE WRONG TABLE.
      Your alternatenumber-from-cell2 update reads

          update DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCEDISTRIBUTION a

      — VCE, not VCCVM. The two either side of it are VCCVM. As written, the
      middle statement of the three writes into a different campaign's table and
      the VCCVM rows never get cell2 at all. I have made it VCCVM. If that is
      wrong and the VCE table really is meant to be updated from inside the CVM
      run, say so and I will put it back, but it should then be its own step.

   2. CREATE OR REPLACE TABLE now carries COPY GRANTS.
      Without it, every run of this procedure silently revokes the app's access
      to the table — the SELECT/INSERT/DELETE you granted to SVC_VERCEL_APP_ROLE
      for the file upload. The next upload would fail with "does not exist or not
      authorized", which is exactly the message you spent time on last week, and
      nothing would point at this procedure as the cause.

   3. DROP COLUMN ROWNUMB is conditional.
      On the first run the column does not exist and a bare DROP COLUMN aborts
      the whole procedure. It now checks INFORMATION_SCHEMA first. (The drop is
      still needed on later runs: INF.* would otherwise carry the old ROWNUMB
      through and the CTAS would try to create two columns of that name.)

   4. TRY_TO_DATE instead of CAST on CURR_CMTMNT_END_DT.
      CAST throws on the first unparseable value and takes the entire run with
      it — and this is a hand-maintained text column, so it will happen. One bad
      cell should not stop a distribution. Rows that cannot be parsed are now
      skipped, and counted, and the count comes back in the return value so they
      are visible rather than quietly dropped. Everything parseable behaves
      exactly as before.

   5. The two contract_status updates are one statement.
      NULL, 'InLife' and '0' all become 'OOC'; running that as two statements
      gives the same rows. Merged, so there is one place to add the next value.
      (The returned count is therefore the total across all three cases.)

   -----------------------------------------------------------------------------
   SIX THINGS I DID NOT CHANGE, BUT YOU SHOULD LOOK AT

   A. WHICH DUPLICATE SURVIVES IS ARBITRARY.
          ROW_NUMBER() OVER (PARTITION BY Id_Num ORDER BY Id_Num)
      orders by the same column it partitions by, so every row in the group ties
      and Snowflake is free to number them in any order. Rerun the procedure on
      unchanged data and a different row can be the keeper. If one of the
      duplicates is better than the others — longer commitment left, a populated
      MSISDN_MAH, the more recent load — order by that instead and the choice
      becomes deliberate. Section 5 shows how many rows this affects.

   B. EVERY ROW WITH A NULL ID_NUM AFTER THE FIRST IS MARKED 'DUPLICATE LEAD'.
      PARTITION BY treats NULLs as equal to each other, so all the blank-ID rows
      land in one group and all but one are excluded — however unrelated they
      are. If blank IDs are possible in this feed, they need their own handling.

   C. A NULL MSISDN_MAH OR MSISDN_ALT2 BLOCKS THE ALTERNATE-NUMBER FILL.
          AND a.MSISDN_ALT2 <> b.cell3
      is UNKNOWN, not TRUE, when MSISDN_ALT2 is NULL, so the row is not updated.
      The leads with the fewest numbers on file are precisely the ones excluded
      from getting another one. The fix is one function per comparison:

          AND COALESCE(a.MSISDN_ALT2, '') <> b.cell3

      I have left the original semantics in place because it changes how many
      leads get an alternate number and that is a distribution decision, not a
      translation. Say the word and it is a three-line change. Section 6 counts
      what you are currently losing.

   D. cell1 OVERWRITES; cell2 AND cell3 ONLY FILL BLANKS.
      The cell1 statement has no "alternatenumber is null" guard, the other two
      do. If the uploaded file ever arrives with alternatenumber already
      populated, cell1 discards it. Harmless if the column always starts empty.

   E. ESTATUS IS ONE FIELD HOLDING EVERY EXCLUSION REASON, SO THE LAST WRITE WINS.
      A lead in history that is also in DMASA ends up 'LEAD IN DMASA' — the
      history label is overwritten. So is the CURR_CMTMNT_END_DT label. Only the
      duplicate marking checks "ESTATUS IS NULL" before writing. That ordering
      is a real policy (DMASA outranks everything, which is right) but it is
      currently implicit in statement order rather than stated anywhere, and the
      reporting can only ever see one reason per lead.

   F. VW_DEMOGRAPHIC_TELEPHONE MAY HAVE SEVERAL ROWS PER ID.
      When an UPDATE ... FROM matches more than one source row, Snowflake picks
      one arbitrarily. If an ID can appear twice in that view with different
      cell1 values, the alternate number you get is not repeatable. Section 7
      checks whether that is the case.

   -----------------------------------------------------------------------------
   THE LABEL TEXT IS YOURS, UNCHANGED
      CONCAT('CURR_CMTMNT_END_DT > ', CURRENT_DATE()) reads as "end date is
      after today", but the condition is "after today plus six months". I have
      kept the string byte-for-byte in case anything downstream matches on it.
      Worth correcting the wording at some point.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the procedure

   Parameters, so the numbers are not buried eleven statements deep:

     HISTORY_CAMPAIGNS   comma-separated campaign ids for the history check.
                         '11058' for one; '11058,11059' for several. Your script
                         had "in (11058)", which reads as a list waiting to grow.
     HISTORY_DAYS        the 90 in "loaded in the last 90 days".
     COMMITMENT_MONTHS   the 6 in "commitment ends more than six months out".

   EXECUTE AS OWNER, so the owner role — not the caller — needs the privileges.
   Section 2 lists them.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(
        HISTORY_CAMPAIGNS VARCHAR,
        HISTORY_DAYS      NUMBER(38,0),
        COMMITMENT_MONTHS NUMBER(38,0)
    )
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n_contract    NUMBER DEFAULT 0;
    n_history     NUMBER DEFAULT 0;
    n_commitment  NUMBER DEFAULT 0;
    n_enddate_fix NUMBER DEFAULT 0;
    n_msisdn      NUMBER DEFAULT 0;
    n_msisdn_mah  NUMBER DEFAULT 0;
    n_dmasa       NUMBER DEFAULT 0;
    n_dupes       NUMBER DEFAULT 0;
    n_alt1        NUMBER DEFAULT 0;
    n_alt2        NUMBER DEFAULT 0;
    n_alt3        NUMBER DEFAULT 0;
    n_unparseable NUMBER DEFAULT 0;
    has_rownumb   NUMBER DEFAULT 0;
    n_rows        NUMBER DEFAULT 0;
    msg           VARCHAR DEFAULT '';
BEGIN

    -- ---------------------------------------------------------------- contract
    -- NULL, 'InLife' and '0' all mean out of contract.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET CONTRACT_STATUS = 'OOC'
     WHERE CONTRACT_STATUS IS NULL
        OR CONTRACT_STATUS IN ('InLife', '0');
    n_contract := SQLROWCOUNT;

    -- ----------------------------------------------------------- lead in history
    -- Matched on the last nine digits, so a leading zero on either side does not
    -- matter — which is why this can run before the MSISDN fix below.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
       SET ESTATUS = 'LEAD IN HISTORY 90 DAYS'
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED b
     WHERE RIGHT(a.MSISDN, 9) = RIGHT(b.CONTACTNUMBER1, 9)
       AND b.CAMPAIGNID IN (
               SELECT TRY_TO_NUMBER(TRIM(VALUE::VARCHAR))
                 FROM TABLE(FLATTEN(INPUT => SPLIT(:HISTORY_CAMPAIGNS, ',')))
           )
       AND b.CREATEDONDATE > DATEADD('DAY', -1 * :HISTORY_DAYS, CURRENT_DATE());
    n_history := SQLROWCOUNT;

    -- --------------------------------------------------------- commitment end date
    -- Counted before the label is applied: these are the rows whose end date
    -- cannot be read at all, so they fall through every branch below silently.
    n_unparseable := (
        SELECT COUNT(*)
          FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
         WHERE CURR_CMTMNT_END_DT IS NOT NULL
           AND TRY_TO_DATE(REPLACE(CURR_CMTMNT_END_DT::VARCHAR, '/', '-')) IS NULL
    );

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET ESTATUS = CONCAT('CURR_CMTMNT_END_DT > ', CURRENT_DATE())
     WHERE TRY_TO_DATE(REPLACE(CURR_CMTMNT_END_DT::VARCHAR, '/', '-'))
             > DATEADD('MONTH', :COMMITMENT_MONTHS, CURRENT_DATE());
    n_commitment := SQLROWCOUNT;

    -- Anything not in YYYY-MM-DD shape is pushed out six months. Deliberately
    -- AFTER the label above, so a long-format date that really is far out still
    -- gets excluded first.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET CURR_CMTMNT_END_DT = DATEADD('MONTH', :COMMITMENT_MONTHS, CURRENT_DATE())
     WHERE LEN(CURR_CMTMNT_END_DT::VARCHAR) <> 10;
    n_enddate_fix := SQLROWCOUNT;

    -- ------------------------------------------------------------ leading zeros
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET MSISDN = CONCAT('0', MSISDN)
     WHERE LEN(MSISDN::VARCHAR) = 9;
    n_msisdn := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET MSISDN_MAH = CONCAT('0', MSISDN_MAH)
     WHERE LEN(MSISDN_MAH::VARCHAR) = 9;
    n_msisdn_mah := SQLROWCOUNT;

    -- -------------------------------------------------------------------- DMASA
    -- Runs last of the ESTATUS writers, so DMASA outranks the other reasons.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
       SET ESTATUS = 'LEAD IN DMASA'
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_DMASA_LEAD_STATUS DMA
     WHERE DMA.IDNUMBER = a.ID_NUM
       AND DMA.DMASA_STATUS = 'TRUE';
    n_dmasa := SQLROWCOUNT;

    -- --------------------------------------------------------------- duplicates
    -- ROWNUMB is rebuilt rather than updated in place: the table has no unique
    -- key to join a window function back onto, so a CTAS is the only way.
    has_rownumb := (
        SELECT COUNT(*)
          FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = 'DISTRIBUTION'
           AND TABLE_NAME   = 'TM_VCD_VCCVMDISTRIBUTION'
           AND COLUMN_NAME  = 'ROWNUMB'
    );

    IF (has_rownumb > 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
            DROP COLUMN ROWNUMB;
    END IF;

    -- COPY GRANTS: see note 2 in the header. Without it the app loses the table.
    CREATE OR REPLACE TABLE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
    COPY GRANTS
    AS
    SELECT INF.*,
           ROW_NUMBER() OVER (PARTITION BY INF.ID_NUM ORDER BY INF.ID_NUM) AS ROWNUMB
      FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION INF;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SET ESTATUS = 'DUPLICATE LEAD'
     WHERE ROWNUMB > 1
       AND ESTATUS IS NULL;
    n_dupes := SQLROWCOUNT;

    -- -------------------------------------------------------- alternate numbers
    -- cell1 first, unguarded, then cell2 and cell3 filling only what is still
    -- blank. Note C in the header: a NULL MSISDN_MAH or MSISDN_ALT2 stops all
    -- three from firing on that row.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
       SET a.ALTERNATENUMBER = b.CELL1
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.ID_NUM = b.IDENTIFIERNUMBER
       AND a.MSISDN      <> b.CELL1
       AND a.MSISDN_MAH  <> b.CELL1
       AND a.MSISDN_ALT2 <> b.CELL1;
    n_alt1 := SQLROWCOUNT;

    -- Was VCE in your script. See note 1 in the header.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
       SET a.ALTERNATENUMBER = b.CELL2
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.ALTERNATENUMBER IS NULL
       AND a.ID_NUM = b.IDENTIFIERNUMBER
       AND a.MSISDN      <> b.CELL2
       AND a.MSISDN_MAH  <> b.CELL2
       AND a.MSISDN_ALT2 <> b.CELL2;
    n_alt2 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
       SET a.ALTERNATENUMBER = b.CELL3
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.ALTERNATENUMBER IS NULL
       AND a.ID_NUM = b.IDENTIFIERNUMBER
       AND a.MSISDN      <> b.CELL3
       AND a.MSISDN_MAH  <> b.CELL3
       AND a.MSISDN_ALT2 <> b.CELL3;
    n_alt3 := SQLROWCOUNT;

    -- ------------------------------------------------------------------ summary
    -- Built into a variable rather than returned as one expression: inside a
    -- scripting expression variables are referenced bare, inside a SQL statement
    -- with a colon, and a single RETURN mixing both is a good way to find out
    -- which at run time.
    n_rows := (SELECT COUNT(*) FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION);

    msg := 'VC CVM prep done — ' || n_rows || ' rows in table. '
        || 'contract_status→OOC '    || n_contract
        || ' | history '             || n_history
        || ' | commitment>' || COMMITMENT_MONTHS || 'mo ' || n_commitment
        || ' | end-date fixed '      || n_enddate_fix
        || ' | msisdn 0-prefix '     || n_msisdn
        || ' | msisdn_mah 0-prefix ' || n_msisdn_mah
        || ' | dmasa '               || n_dmasa
        || ' | duplicates '          || n_dupes
        || ' | alt cell1/2/3 '       || n_alt1 || '/' || n_alt2 || '/' || n_alt3;

    IF (n_unparseable > 0) THEN
        msg := msg || ' | WARNING: ' || n_unparseable
                   || ' rows have an unreadable CURR_CMTMNT_END_DT and were not'
                   || ' date-checked — see section 4';
    END IF;

    RETURN msg;

END;
$$;


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   EXECUTE AS OWNER means the OWNER role does the work. Whatever role creates
   the procedure needs all of the following, or the procedure compiles fine and
   fails at run time — Snowflake reports the missing privilege against the
   object, never against the procedure, so the error will not mention this file.

   Run as ACCOUNTADMIN, replacing SYSADMIN if you create it as something else.
-------------------------------------------------------------------------------- */

-- Read and write the table it maintains, and own it — CREATE OR REPLACE TABLE
-- and ALTER TABLE both require OWNERSHIP, not merely a grant.
GRANT USAGE ON DATABASE DATAWAREHOUSE                        TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION             TO ROLE SYSADMIN;
GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION      TO ROLE SYSADMIN;
-- Only if it is not already owned there:
--   GRANT OWNERSHIP ON TABLE DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
--     TO ROLE SYSADMIN COPY CURRENT GRANTS;

-- The three objects it reads.
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE SYSADMIN;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SYSADMIN;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_DMASA_LEAD_STATUS
  TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DW_XDS                   TO ROLE SYSADMIN;
GRANT SELECT ON VIEW DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE TO ROLE SYSADMIN;


/* -----------------------------------------------------------------------------
   SECTION 3 — let the app call it

   CREATE OR REPLACE PROCEDURE does not carry grants and has no COPY GRANTS
   clause, so this has to be re-run every time the procedure is replaced. The
   argument types are part of the identity — a signature change needs the new
   signature granted.
-------------------------------------------------------------------------------- */

GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(VARCHAR, NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Verify from the app's own session rather than a worksheet — a worksheet tells
-- you about your access, not the app's:
--   /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP


/* -----------------------------------------------------------------------------
   SECTION 4 — the unreadable end dates, before you trust the exclusions

   These rows are not date-checked at all. Under your original CAST they would
   have aborted the run; now they are skipped. Either way they are not excluded
   for a long commitment, so they can go out to the dialler. Worth a look at the
   shapes before deciding whether to widen the parsing or reject the file.
-------------------------------------------------------------------------------- */

SELECT CURR_CMTMNT_END_DT,
       LEN(CURR_CMTMNT_END_DT::VARCHAR) AS CHARS,
       COUNT(*)                         AS ROWS_AFFECTED
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
 WHERE CURR_CMTMNT_END_DT IS NOT NULL
   AND TRY_TO_DATE(REPLACE(CURR_CMTMNT_END_DT::VARCHAR, '/', '-')) IS NULL
 GROUP BY 1, 2
 ORDER BY ROWS_AFFECTED DESC
 LIMIT 50;


/* -----------------------------------------------------------------------------
   SECTION 5 — how much the arbitrary duplicate choice costs you

   Note A. Rows in a group where the duplicates differ in something you would
   have picked on. If DIFFERING_END_DATES or DIFFERING_MAH is more than a
   handful, the ORDER BY in the window function is worth making deliberate.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                        AS DUPLICATE_GROUPS,
       SUM(rows_in_group)                              AS ROWS_IN_GROUPS,
       SUM(IFF(distinct_end_dates > 1, 1, 0))          AS DIFFERING_END_DATES,
       SUM(IFF(distinct_mah > 1, 1, 0))                AS DIFFERING_MAH
  FROM (
        SELECT ID_NUM,
               COUNT(*)                                   AS rows_in_group,
               COUNT(DISTINCT CURR_CMTMNT_END_DT)         AS distinct_end_dates,
               COUNT(DISTINCT MSISDN_MAH)                 AS distinct_mah
          FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
         WHERE ID_NUM IS NOT NULL
         GROUP BY ID_NUM
        HAVING COUNT(*) > 1
       );

-- Note B — the blank-ID rows, all of which but one get marked as duplicates of
-- each other:
SELECT COUNT(*) AS NULL_ID_ROWS
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
 WHERE ID_NUM IS NULL;


/* -----------------------------------------------------------------------------
   SECTION 6 — what the NULL comparisons are costing you

   Note C. Rows that have a cell1 on file, no alternate number, and would be
   updated by the COALESCE version but are not by the current one. This is the
   size of the change if you decide to make it.
-------------------------------------------------------------------------------- */

SELECT COUNT(*) AS LEADS_BLOCKED_BY_NULL_COMPARISON
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
  JOIN DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
    ON a.ID_NUM = b.IDENTIFIERNUMBER
 WHERE a.ALTERNATENUMBER IS NULL
   AND b.CELL1 IS NOT NULL
   -- would pass the null-safe version …
   AND COALESCE(a.MSISDN, '')      <> b.CELL1
   AND COALESCE(a.MSISDN_MAH, '')  <> b.CELL1
   AND COALESCE(a.MSISDN_ALT2, '') <> b.CELL1
   -- … but fails the current one, because one of them is NULL.
   AND (a.MSISDN_MAH IS NULL OR a.MSISDN_ALT2 IS NULL OR a.MSISDN IS NULL);


/* -----------------------------------------------------------------------------
   SECTION 7 — is VW_DEMOGRAPHIC_TELEPHONE one row per ID?

   Note F. If MAX_ROWS_PER_ID is 1 the arbitrary-pick concern does not apply and
   you can ignore it. If it is more than 1, the alternate number a lead gets is
   not repeatable between runs.
-------------------------------------------------------------------------------- */

SELECT MAX(c) AS MAX_ROWS_PER_ID,
       COUNT(*) AS IDS_WITH_MORE_THAN_ONE
  FROM (
        SELECT b.IDENTIFIERNUMBER, COUNT(*) AS c
          FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
         WHERE EXISTS (
                 SELECT 1
                   FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION a
                  WHERE a.ID_NUM = b.IDENTIFIERNUMBER)
         GROUP BY b.IDENTIFIERNUMBER
        HAVING COUNT(*) > 1
       );


/* -----------------------------------------------------------------------------
   SECTION 8 — wire it into the app

   Settings → Campaign automation → the VC CVM config:

     Lead source            File
     Upload target table    DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
     Update-HLL procedures   DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP('11058', 90, 6)

   It then appears in Manual → step 3 as its own tab, runnable on its own, and
   in the automated run in the same position.

   Change the numbers in the config, not in this file. Several campaigns in the
   history check go in as one quoted list:

     SP_VCD_VCCVM_PREP('11058,11059', 90, 6)
-------------------------------------------------------------------------------- */
