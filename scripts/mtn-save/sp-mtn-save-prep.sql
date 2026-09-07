/* =============================================================================
   MTN SAVE (campaign 11204) — lead preparation procedure
   -----------------------------------------------------------------------------
   Your cleansing block — the comma strips, the phone normalisation and
   de-duplication, the XDS enrichment, the duplicate and invalid-ID marking — as
   one procedure, in the same order, with a row count per statement so the app's
   run log says what actually happened rather than just "succeeded".

   It runs BETWEEN the upload and the HLL load, because everything it does has
   to reach the rows before they are read into HLL:

       upload file → TM_MU2_MTNSAVESOUTBOUND
       SP_MTN_SAVE_PREP(11204)                  ← this file
       VW_MTN_SAVE_HLL_LOAD → TM_HLL_HISTORYLEADSLOADED

   In app terms that is the SOURCE PROCEDURE, not an update-HLL procedure. An
   update-HLL procedure runs after the load, when the ESTATUS labels, the
   leading zeros and the alternate numbers can no longer reach the HLL rows.

   -----------------------------------------------------------------------------
   SIX THINGS I CHANGED, AND WHY

   1. `where HOME_PHONE_NO = null` IS NOW `IS NULL` — three occurrences.
      `x = null` is UNKNOWN, never TRUE. Your two XDS HOME_PHONE_NO enrichments
      and the HOME_PHONE_NO = work_phone_no fallback have therefore never
      updated a single row.

   2. EVERY PHONE-NUMBER INEQUALITY IN THE ENRICHMENT BLOCK IS NULL-SAFE.
      This is the fix that makes fix 1 worth having, and it is the one judgement
      call in this file. Your conditions read

          and CELL_PHONE_NO <> HOME1
          and cell2 <> cell1

      and both are UNKNOWN — so the row is skipped — whenever the left side is
      NULL. That is precisely the state the six null-out statements just above
      them create: they blank CELL_PHONE_NO, WORK_PHONE_NO and HOME_PHONE_NO
      wherever they duplicated another number. So the leads with the FEWEST
      numbers on file, the only ones that need enriching, were the ones excluded
      from being enriched. Fixing `= null` alone would leave you looking at
      another zero-row report and reasonably concluding nothing had been fixed.

      Every such comparison is now COALESCE(x, '') <> y. If you would rather
      keep the strict form, each one has the original directly above it as a
      comment — but then expect the enrichment to do very little.

      This changes which leads get a second and third contact number. It does
      NOT change how many leads are distributed, or which are excluded: no
      ESTATUS decision depends on it.

   3. CREATE OR REPLACE TABLE NOW CARRIES COPY GRANTS.
      Your duplicate-check CTAS does not, unlike the CREATE TABLE at the top of
      the runbook, which does. Without it every run silently drops every grant
      on the table — including the SELECT/INSERT/DELETE the file upload needs.
      The first run works, and the NEXT upload fails with "does not exist or not
      authorized", pointing at the upload rather than at the statement that
      broke it. See 00-grants.sql section 6.

   4. `drop column "row"` IS CONDITIONAL, AND THE COLUMN IS NOW ROWNUMB.
      Your DROP sits ABOVE the CTAS that creates the column, so on a clean run
      it errors and takes the whole procedure with it — it is a re-run artefact.
      It now checks INFORMATION_SCHEMA first. The drop is still needed on later
      runs: `SELECT a.*` would otherwise carry the old column through and the
      CTAS would try to create two of that name.

      Renamed to ROWNUMB, unquoted, matching the other campaigns in this repo. A
      quoted lowercase `"row"` has to be quoted at every single use forever, and
      `row` is a reserved word in enough dialects to be worth not having. The
      conditional drop handles BOTH names, so an existing table with `"row"` on
      it upgrades cleanly on the first run.

   5. THE TWO 'Incorrect Cell Number' STATEMENTS ARE ONE.
      `length(MSISDN) <> 11` is UNKNOWN for a NULL MSISDN, which is why you
      needed the second statement. `OR MSISDN IS NULL` is the same set of rows
      in one pass, and there is now one place to add the next case. The returned
      count is the total across both.

   6. THE SEVEN ALTER ADDs ARE CONDITIONAL, SO THIS IS SELF-HEALING.
      ESTATUS and RECOMMENDATION_1..6 are added if absent. On an existing table
      that is a no-op; on a table someone has just recreated from your CREATE
      statement it saves a manual step, and it means the CTAS in section 1 can
      never lose them.

   -----------------------------------------------------------------------------
   FOUR THINGS I DID NOT CHANGE, BUT YOU SHOULD LOOK AT

   A. RECOMMENDATION_1..6 ARE NEVER POPULATED BY ANYTHING.
      Your CREATE TABLE has `recommendation`, SINGULAR. The ALTER ADDs create
      the six numbered ones, after the load, and nothing anywhere writes them.
      So the six comma-strip UPDATEs at the top of your runbook run against
      columns that are empty on every row, and UDM5-8, UDM14-16 and UDM18-20
      arrive at the dialler blank — on a campaign whose whole point is
      presenting a save offer.

      I have NOT invented a split, because only you know the separator and
      whether the CSV even carries the offers. 00-grants.sql section 5 tells you
      which of the two cases it is, and the commented block at the end of
      section 1 below does the split once you know. Read that section before the
      first run; it is the second most important finding after DNC.

   B. THE ESTATUS LABEL A LEAD ENDS UP WITH IS DECIDED BY STATEMENT ORDER.
      'Incorrect Cell Number', then 'DUPLICATE LEAD', then 'INVALID ID', and
      none of the three checks whether ESTATUS is already set — so the last
      write wins and a lead that is all three reports only as INVALID ID. That
      ordering is left exactly as you wrote it, because it changes reporting
      only: the dialler view excludes on `ESTATUS IS NULL`, so a lead is
      excluded either way. If you want the first reason to stick instead, add
      `AND ESTATUS IS NULL` to the two later statements — both are marked.

   C. WHICH DUPLICATE SURVIVES IS ARBITRARY.
          ROW_NUMBER() OVER (PARTITION BY a.ACCOUNT_NO ORDER BY a.ACCOUNT_NO)
      orders by the same column it partitions by, so every row in the group ties
      and Snowflake may number them in any order. Re-run on unchanged data and a
      different row can be the keeper. If one duplicate is better than the
      others — a populated CELL_PHONE_NO, the higher ASPU, a later
      CONTRACT_END_DATE — order by that and the choice becomes deliberate.
      Section 4 sizes it.

   D. VW_CONTACTNUMBERS MAY HAVE SEVERAL ROWS PER ID.
      When an UPDATE ... FROM matches more than one source row, Snowflake picks
      one arbitrarily, so the number a lead gets is not repeatable between runs.
      Section 5 checks whether that is the case here.

   AND ONE THING THAT IS NOT IN THIS FILE: the `COPY INTO @PO500STAGE` step has
   no equivalent and is not needed. The app never uses a Snowflake stage for
   campaign data — the upload screen parses the file in the browser and posts it
   in 1,000-row batches. Your COPY INTO is commented out in the runbook anyway.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the procedure

   One parameter, CAMPAIGN_ID, which this procedure does not currently use for
   filtering — the staging table holds one campaign's file at a time. It is
   taken anyway so that the config reads
   SP_MTN_SAVE_PREP(11204) like every other campaign's, and so a history check
   can be added later without a signature change (which would need a fresh
   grant; see 00-grants.sql section 7).

   EXECUTE AS OWNER, so the OWNER role — not the caller — needs the privileges.
   00-grants.sql section 7 lists them.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP(
        CAMPAIGN_ID NUMBER(38,0)
    )
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n_commas      NUMBER DEFAULT 0;
    n_badcell     NUMBER DEFAULT 0;
    n_msisdn      NUMBER DEFAULT 0;
    n_work        NUMBER DEFAULT 0;
    n_cell        NUMBER DEFAULT 0;
    n_home        NUMBER DEFAULT 0;
    n_blanked     NUMBER DEFAULT 0;
    n_cell1       NUMBER DEFAULT 0;
    n_cell2       NUMBER DEFAULT 0;
    n_cell3       NUMBER DEFAULT 0;
    n_home1       NUMBER DEFAULT 0;
    n_home3       NUMBER DEFAULT 0;
    n_homework    NUMBER DEFAULT 0;
    n_dupes       NUMBER DEFAULT 0;
    n_invalid     NUMBER DEFAULT 0;
    n_rows        NUMBER DEFAULT 0;
    n_norec       NUMBER DEFAULT 0;
    has_col       NUMBER DEFAULT 0;
    msg           VARCHAR DEFAULT '';
BEGIN

    -- ------------------------------------------------------- self-healing columns
    -- Change 6. ESTATUS and the six recommendation columns, added only if the
    -- table does not already have them. ALTER TABLE ... ADD COLUMN has no
    -- IF NOT EXISTS in Snowflake, hence the introspection.
    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'ESTATUS');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN ESTATUS VARCHAR(500);
    END IF;

    -- One guard per column rather than one guard for all six. Two reasons:
    -- Snowflake's ALTER TABLE ADD takes a comma-separated column list, NOT a
    -- repeated `ADD COLUMN` clause, and a table that somehow has
    -- RECOMMENDATION_1 but not RECOMMENDATION_4 would be skipped entirely by a
    -- single guard on the first name. Verbose, but it cannot half-migrate.
    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_1');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_1 VARCHAR(500);
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_2');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_2 VARCHAR(500);
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_3');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_3 VARCHAR(500);
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_4');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_4 VARCHAR(500);
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_5');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_5 VARCHAR(500);
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'RECOMMENDATION_6');
    IF (has_col = 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            ADD COLUMN RECOMMENDATION_6 VARCHAR(500);
    END IF;

    -- --------------------------------------------------- strip commas from offers
    -- Your six statements as one. They were identical bar the column, and the
    -- ILIKE '%,%' guard only skips rows REPLACE would leave unchanged anyway —
    -- so one pass over the table instead of six.
    --
    -- NOTE A: these columns are empty on every row unless something populates
    -- them. See 00-grants.sql section 5 and the commented block at the end of
    -- this section.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET RECOMMENDATION_1 = REPLACE(RECOMMENDATION_1, ',', ''),
           RECOMMENDATION_2 = REPLACE(RECOMMENDATION_2, ',', ''),
           RECOMMENDATION_3 = REPLACE(RECOMMENDATION_3, ',', ''),
           RECOMMENDATION_4 = REPLACE(RECOMMENDATION_4, ',', ''),
           RECOMMENDATION_5 = REPLACE(RECOMMENDATION_5, ',', ''),
           RECOMMENDATION_6 = REPLACE(RECOMMENDATION_6, ',', '')
     WHERE RECOMMENDATION_1 ILIKE '%,%' OR RECOMMENDATION_2 ILIKE '%,%'
        OR RECOMMENDATION_3 ILIKE '%,%' OR RECOMMENDATION_4 ILIKE '%,%'
        OR RECOMMENDATION_5 ILIKE '%,%' OR RECOMMENDATION_6 ILIKE '%,%';
    n_commas := SQLROWCOUNT;

    -- ------------------------------------------------------- bad primary number
    -- Change 5: your two statements merged. An 11-digit MSISDN is the expected
    -- shape (27 + 9 digits); anything else, NULL included, is unusable.
    -- Runs BEFORE the normalisation below, which is what makes the length test
    -- meaningful.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET ESTATUS = 'Incorrect Cell Number'
     WHERE LENGTH(MSISDN) <> 11
        OR MSISDN IS NULL;
    n_badcell := SQLROWCOUNT;

    -- ---------------------------------------------------- normalise to 0xxxxxxxxx
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET MSISDN = CONCAT('0', RIGHT(CAST(MSISDN AS VARCHAR), 9))
     WHERE LENGTH(MSISDN) = 11;
    n_msisdn := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET WORK_PHONE_NO = CONCAT('0', RIGHT(CAST(WORK_PHONE_NO AS VARCHAR), 9))
     WHERE LENGTH(WORK_PHONE_NO) = 11;
    n_work := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET CELL_PHONE_NO = CONCAT('0', RIGHT(CAST(CELL_PHONE_NO AS VARCHAR), 9))
     WHERE LENGTH(CELL_PHONE_NO) = 11;
    n_cell := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET HOME_PHONE_NO = CONCAT('0', RIGHT(CAST(HOME_PHONE_NO AS VARCHAR), 9))
     WHERE LENGTH(HOME_PHONE_NO) = 11;
    n_home := SQLROWCOUNT;

    -- -------------------------------------------- blank out repeated numbers
    -- Your six null-out statements as one. Each row's three secondary numbers
    -- are cleared wherever they repeat MSISDN or each other, so the dialler
    -- never gets the same number twice for one lead. Written as one UPDATE
    -- because the six ran in a fixed order and the CASEs below reproduce it:
    -- MSISDN wins over all, then WORK_PHONE_NO over HOME_PHONE_NO, then
    -- CELL_PHONE_NO over both.
    --
    -- Order matters and is preserved: CELL_PHONE_NO is compared against the
    -- ORIGINAL work and home values, exactly as in your sequence, because a
    -- single UPDATE evaluates every right-hand side against the row as it was.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET HOME_PHONE_NO = CASE
                             WHEN HOME_PHONE_NO = CELL_PHONE_NO THEN NULL
                             WHEN HOME_PHONE_NO = WORK_PHONE_NO THEN NULL
                             WHEN HOME_PHONE_NO = MSISDN        THEN NULL
                             ELSE HOME_PHONE_NO END,
           WORK_PHONE_NO = CASE
                             WHEN WORK_PHONE_NO = CELL_PHONE_NO THEN NULL
                             WHEN WORK_PHONE_NO = MSISDN        THEN NULL
                             ELSE WORK_PHONE_NO END,
           CELL_PHONE_NO = CASE
                             WHEN CELL_PHONE_NO = MSISDN        THEN NULL
                             ELSE CELL_PHONE_NO END
     WHERE HOME_PHONE_NO IN (CELL_PHONE_NO, WORK_PHONE_NO, MSISDN)
        OR WORK_PHONE_NO IN (CELL_PHONE_NO, MSISDN)
        OR CELL_PHONE_NO = MSISDN;
    n_blanked := SQLROWCOUNT;

    -- ------------------------------------------------ XDS cell-number enrichment
    -- Changes 1 and 2. Original conditions kept above each as comments.
    -- cell1, then cell2, then cell3, each filling only what is still blank.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
       SET a.CELL_PHONE_NO = b.CELL1
      FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
     WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER
       AND a.CELL_PHONE_NO IS NULL
       AND b.CELL1 IS NOT NULL
       -- original: AND b.CELL1 <> a.MSISDN
       AND COALESCE(a.MSISDN, '') <> b.CELL1;
    n_cell1 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
       SET a.CELL_PHONE_NO = b.CELL2
      FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
     WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER
       AND a.CELL_PHONE_NO IS NULL
       AND b.CELL2 IS NOT NULL
       -- original: AND b.CELL2 <> a.MSISDN AND b.CELL2 <> b.CELL1
       AND COALESCE(a.MSISDN, '') <> b.CELL2
       AND COALESCE(b.CELL1, '')  <> b.CELL2;
    n_cell2 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
       SET a.CELL_PHONE_NO = b.CELL3
      FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
     WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER
       AND a.CELL_PHONE_NO IS NULL
       AND b.CELL3 IS NOT NULL
       -- original: AND b.CELL3 <> a.MSISDN AND b.CELL3 <> b.CELL1 AND b.CELL3 <> b.CELL2
       AND COALESCE(a.MSISDN, '') <> b.CELL3
       AND COALESCE(b.CELL1, '')  <> b.CELL3
       AND COALESCE(b.CELL2, '')  <> b.CELL3;
    n_cell3 := SQLROWCOUNT;

    -- ------------------------------------------------ XDS home-number enrichment
    -- These are the three statements that have never run: `= null` in the
    -- original, on the very column being filled.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
       SET a.HOME_PHONE_NO = b.HOME1
      FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
     WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER
       -- original: AND a.HOME_PHONE_NO = null   ← never true
       AND a.HOME_PHONE_NO IS NULL
       AND b.HOME1 IS NOT NULL
       -- original: AND a.CELL_PHONE_NO <> b.HOME1 AND a.WORK_PHONE_NO <> b.HOME1 AND b.HOME1 <> a.MSISDN
       AND COALESCE(a.CELL_PHONE_NO, '') <> b.HOME1
       AND COALESCE(a.WORK_PHONE_NO, '') <> b.HOME1
       AND COALESCE(a.MSISDN, '')        <> b.HOME1;
    n_home1 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
       SET a.HOME_PHONE_NO = b.CELL3
      FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
     WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER
       -- original: AND a.HOME_PHONE_NO = null   ← never true
       AND a.HOME_PHONE_NO IS NULL
       AND b.CELL3 IS NOT NULL
       AND COALESCE(a.CELL_PHONE_NO, '') <> b.CELL3
       AND COALESCE(a.WORK_PHONE_NO, '') <> b.CELL3
       AND COALESCE(a.MSISDN, '')        <> b.CELL3;
    n_home3 := SQLROWCOUNT;

    -- Last resort: promote the work number into the home slot. Your version had
    -- `where HOME_PHONE_NO = null`, so this has never run either. The extra
    -- guards are new and necessary — without them this would undo the blanking
    -- two statements up by putting the work number straight back.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET HOME_PHONE_NO = WORK_PHONE_NO
     WHERE HOME_PHONE_NO IS NULL
       AND WORK_PHONE_NO IS NOT NULL
       AND COALESCE(CELL_PHONE_NO, '') <> WORK_PHONE_NO
       AND COALESCE(MSISDN, '')        <> WORK_PHONE_NO;
    n_homework := SQLROWCOUNT;

    -- --------------------------------------------------------------- duplicates
    -- Change 4. ROWNUMB is rebuilt rather than updated in place: the table has
    -- no unique key to join a window function back onto, so a CTAS is the only
    -- way. Both the old quoted "row" and ROWNUMB are dropped if present, so an
    -- existing table upgrades on the first run.
    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'row');
    IF (has_col > 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            DROP COLUMN "row";
    END IF;

    has_col := (SELECT COUNT(*) FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
                   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
                   AND COLUMN_NAME  = 'ROWNUMB');
    IF (has_col > 0) THEN
        ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
            DROP COLUMN ROWNUMB;
    END IF;

    -- COPY GRANTS: change 3. Without it this line revokes the app's own access
    -- to the table and the next upload fails.
    CREATE OR REPLACE TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
    COPY GRANTS
    AS
    SELECT a.*,
           ROW_NUMBER() OVER (PARTITION BY a.ACCOUNT_NO ORDER BY a.ACCOUNT_NO) AS ROWNUMB
      FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a;

    -- NOTE B: no `AND ESTATUS IS NULL` — as you wrote it, so 'DUPLICATE LEAD'
    -- overwrites 'Incorrect Cell Number'. Add it here if you want the first
    -- reason to stick instead.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET ESTATUS = 'DUPLICATE LEAD'
     WHERE ROWNUMB > 1;
    n_dupes := SQLROWCOUNT;

    -- ------------------------------------------------------------- invalid ID
    -- NOTE B again: overwrites both labels above.
    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET ESTATUS = 'INVALID ID'
     WHERE ID_NUMBER = '0000000000000';
    n_invalid := SQLROWCOUNT;

    -- ------------------------------------------------------------------ summary
    -- Built into a variable rather than returned as one expression: inside a
    -- scripting expression variables are referenced bare, inside a SQL
    -- statement with a colon, and a single RETURN mixing both is a good way to
    -- find out which at run time.
    n_rows := (SELECT COUNT(*) FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND);

    -- NOTE A, surfaced in the run log rather than left for someone to notice.
    n_norec := (
        SELECT COUNT(*)
          FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
         WHERE COALESCE(RECOMMENDATION_1, RECOMMENDATION_2, RECOMMENDATION_3,
                        RECOMMENDATION_4, RECOMMENDATION_5, RECOMMENDATION_6) IS NULL
    );

    msg := 'MTN Save prep done — ' || n_rows || ' rows in table. '
        || 'comma-stripped '          || n_commas
        || ' | bad MSISDN '           || n_badcell
        || ' | 0-prefixed msisdn/work/cell/home '
        || n_msisdn || '/' || n_work || '/' || n_cell || '/' || n_home
        || ' | repeated numbers blanked ' || n_blanked
        || ' | xds cell1/2/3 '        || n_cell1 || '/' || n_cell2 || '/' || n_cell3
        || ' | xds home1/cell3/work ' || n_home1 || '/' || n_home3 || '/' || n_homework
        || ' | duplicates '           || n_dupes
        || ' | invalid id '           || n_invalid;

    IF (n_norec > 0) THEN
        msg := msg || ' | WARNING: ' || n_norec
                   || ' of ' || n_rows || ' rows have NO recommendation at all —'
                   || ' the agent screen will show no offer for them.'
                   || ' See 00-grants.sql section 5.';
    END IF;

    RETURN msg;

END;
$$;


/* -----------------------------------------------------------------------------
   IF THE RECOMMENDATIONS ARRIVE IN ONE COLUMN — note A

   Only once 00-grants.sql section 5b has told you the separator. Paste this
   into the procedure directly ABOVE the comma-stripping UPDATE, replacing the
   '|' with whatever 5b shows, and re-run section 1 and then 00-grants.sql
   section 7 (the CREATE OR REPLACE has dropped the grant).

   SPLIT_PART returns '' rather than NULL past the end of the string, hence the
   NULLIF: an empty offer must read as absent, not as an offer that is blank,
   because the view's IFNULLs and the dialler screen both key off NULL.

    UPDATE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SET RECOMMENDATION_1 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 1)), ''),
           RECOMMENDATION_2 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 2)), ''),
           RECOMMENDATION_3 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 3)), ''),
           RECOMMENDATION_4 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 4)), ''),
           RECOMMENDATION_5 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 5)), ''),
           RECOMMENDATION_6 = NULLIF(TRIM(SPLIT_PART(RECOMMENDATION, '|', 6)), '')
     WHERE RECOMMENDATION IS NOT NULL
       AND TRIM(RECOMMENDATION) <> '';

   If instead the CSV really carries six separate columns, do NOT use this. Add
   them to the CREATE TABLE at the top of your runbook — before the load, not
   after — and this procedure's conditional ADD COLUMN block becomes a no-op.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   All in 00-grants.sql section 7, including the owner-role privileges this
   procedure needs and the one line that must be re-run every time the
   procedure is replaced:

     GRANT USAGE ON PROCEDURE
       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP(NUMBER)
       TO ROLE SVC_VERCEL_APP_ROLE;

   Verify from the app's own session rather than a worksheet — a worksheet tells
   you about your access, not the app's:
     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — what the enrichment fix is worth

   Run AFTER an upload and BEFORE the procedure, then compare against the
   procedure's returned xds counts. STRICT is what your original conditions
   would have matched; NULL_SAFE is what change 2 matches. The gap is the
   number of leads that were silently getting no extra number.
-------------------------------------------------------------------------------- */

SELECT COUNT_IF(a.CELL_PHONE_NO <> b.HOME1
                AND a.WORK_PHONE_NO <> b.HOME1
                AND a.MSISDN <> b.HOME1)                       AS STRICT_MATCHES,
       COUNT_IF(COALESCE(a.CELL_PHONE_NO, '') <> b.HOME1
                AND COALESCE(a.WORK_PHONE_NO, '') <> b.HOME1
                AND COALESCE(a.MSISDN, '') <> b.HOME1)         AS NULL_SAFE_MATCHES
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
  JOIN DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
    ON a.ID_NUMBER = b.IDENTIFIERNUMBER
 WHERE a.HOME_PHONE_NO IS NULL
   AND b.HOME1 IS NOT NULL;


/* -----------------------------------------------------------------------------
   SECTION 4 — how much the arbitrary duplicate choice costs you — note C

   If DIFFERING_CELL or DIFFERING_ASPU is more than a handful, the ORDER BY in
   the window function is worth making deliberate: whichever of the duplicates
   you would rather keep, order by that instead of by ACCOUNT_NO.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                    AS DUPLICATE_GROUPS,
       SUM(rows_in_group)                          AS ROWS_IN_GROUPS,
       SUM(IFF(distinct_cell > 1, 1, 0))           AS DIFFERING_CELL,
       SUM(IFF(distinct_aspu > 1, 1, 0))           AS DIFFERING_ASPU,
       SUM(IFF(distinct_end  > 1, 1, 0))           AS DIFFERING_END_DATE
  FROM (
        SELECT ACCOUNT_NO,
               COUNT(*)                            AS rows_in_group,
               COUNT(DISTINCT CELL_PHONE_NO)       AS distinct_cell,
               COUNT(DISTINCT ASPU)                AS distinct_aspu,
               COUNT(DISTINCT CONTRACT_END_DATE)   AS distinct_end
          FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
         WHERE ACCOUNT_NO IS NOT NULL
         GROUP BY ACCOUNT_NO
        HAVING COUNT(*) > 1
       );

-- PARTITION BY treats NULLs as equal to each other, so every blank-ACCOUNT_NO
-- row after the first is marked 'DUPLICATE LEAD' however unrelated they are.
-- If this is not zero, blank account numbers need their own handling.
SELECT COUNT(*) AS NULL_ACCOUNT_NO_ROWS
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
 WHERE ACCOUNT_NO IS NULL;


/* -----------------------------------------------------------------------------
   SECTION 5 — is VW_CONTACTNUMBERS one row per ID? — note D

   MAX_ROWS_PER_ID of 1 means the arbitrary-pick concern does not apply. More
   than 1 means the number a lead gets is not repeatable between runs.
-------------------------------------------------------------------------------- */

SELECT MAX(c)    AS MAX_ROWS_PER_ID,
       COUNT(*)  AS IDS_WITH_MORE_THAN_ONE
  FROM (
        SELECT b.IDENTIFIERNUMBER, COUNT(*) AS c
          FROM DATAWAREHOUSE.DW_XDS.VW_CONTACTNUMBERS b
         WHERE EXISTS (
                 SELECT 1
                   FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a
                  WHERE a.ID_NUMBER = b.IDENTIFIERNUMBER)
         GROUP BY b.IDENTIFIERNUMBER
        HAVING COUNT(*) > 1
       );


/* -----------------------------------------------------------------------------
   SECTION 6 — confirm the run did what the return value says

   The label counts. These should match the counts in the returned message,
   allowing for note B: a lead can be counted by two statements and reported
   under only the last label.
-------------------------------------------------------------------------------- */

SELECT IFNULL(ESTATUS, '(eligible — no label)')  AS ESTATUS,
       COUNT(*)                                  AS LEADS,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS PCT
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
 GROUP BY 1
 ORDER BY LEADS DESC;

-- And the contact-number fill rate, which is what the enrichment block is for.
SELECT COUNT(*)                                     AS ROWS_TOTAL,
       COUNT_IF(MSISDN IS NOT NULL)                 AS HAS_MSISDN,
       COUNT_IF(CELL_PHONE_NO IS NOT NULL)          AS HAS_CELL,
       COUNT_IF(WORK_PHONE_NO IS NOT NULL)          AS HAS_WORK,
       COUNT_IF(HOME_PHONE_NO IS NOT NULL)          AS HAS_HOME
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;


/* -----------------------------------------------------------------------------
   SECTION 7 — wire it into the app

   This is the SOURCE PROCEDURE. It cleans the uploaded table, so it must run
   before the HLL load, not after it. The full config is in
   sp-mtn-save-hll-load.sql section 4; the two lines that matter here are

     Source type   Stored procedure → HLL
     Procedure     DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP(11204)

   Unquoted argument, and that is not a style choice: the config field accepts
   only letters, digits, commas and spaces between the brackets, so a quoted
   argument is rejected before it ever reaches Snowflake.

   It then appears in Manual → step 3 as its own tab, runnable on its own, and
   in the same position in the automated run. Change the number in the config,
   not in this file.
-------------------------------------------------------------------------------- */
