/* =============================================================================
   MTN SAVE (campaign 11204) — the upload target table
   -----------------------------------------------------------------------------
   Deploy this BEFORE the first upload. It replaces the CREATE TABLE at the top
   of your runbook, and it differs from it in three ways that matter.

   -----------------------------------------------------------------------------
   1. IT DECLARES RECOMMENDATION_1..6, BECAUSE THE FILE CARRIES THEM

   Your runbook creates 24 columns and then, AFTER the load, runs seven
   ALTER TABLE ADD statements for ESTATUS and RECOMMENDATION_1..6. That ordering
   is why those six were empty on every row: the columns did not exist when the
   file was read, so the file's recommendation columns had nowhere to land, and
   nothing afterwards ever filled them. UDM5-8, UDM14-16 and UDM18-20 arrived at
   the dialler blank, and EXTRADATA read
   '|RECOMMENDATION_1: |RECOMMENDATION_2: |RECOMMENDATION_3: ' on every lead —
   on a campaign whose entire purpose is presenting a save offer.

   Declared up front, they are loaded with everything else and the six
   comma-strip UPDATEs in SP_MTN_SAVE_PREP finally have something to strip.

   -----------------------------------------------------------------------------
   2. IT IS A SUPERSET, AND THAT IS DELIBERATE

   The upload preview reports 25 columns in the file. Your CREATE TABLE declares
   24, and 24 + 6 recommendations is 30 — so the file's column set differs from
   the runbook by more than the recommendations, and I am not going to guess
   which five of the 24 are absent.

   So this declares the UNION: your 24, plus the six recommendations, plus
   ESTATUS and ROWNUMB which the prep procedure needs. 32 columns. Extra columns
   cost nothing — an unmapped one simply stays NULL — and the upload's mapping
   step lists every file header alongside the column it will be written to, so
   anything the file carries that this table has no home for is visible there
   before you load rather than missing afterwards.

   AFTER THE FIRST UPLOAD, section 4 reconciles the two lists properly.

   -----------------------------------------------------------------------------
   3. EVERY COLUMN IS VARCHAR, INCLUDING THE NUMBERS

   Yours too, and it is worth saying why it is right rather than lazy.

   The app inserts every value as a quoted string literal
   (app/api/upload/load/route.ts). Against a VARCHAR column Snowflake stores
   the text as given. Against a NUMBER column it would ACCEPT '6.31008E+12' as
   a numeric literal and cast it to 6310080000000 — a wrong number, stored
   silently, with no error to notice. VARCHAR at least keeps the damage
   visible: a malformed value stays readable and a LEN() check can find it.

   That is not hypothetical. The first MTN Save upload put exactly
   '6.31008E+12' into ID_NUMBER for all 7,257 rows, because the parser was
   handing over Excel's on-screen rendering rather than the underlying value.
   Six of the thirteen digits survived, so it could not be repaired in SQL —
   only re-uploaded. The parser is fixed (lib/upload-cell-text.ts); section 5
   is the query that proves it stayed fixed.

   CONTRACT_END_DATE IS A VARCHAR TOO, and stays one. The file's dates arrive as
   Excel's formatted text and nothing downstream does date arithmetic on them.
   A DATE column here would move the parsing problem into the load, where it
   fails per-row and stops the batch.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the table

   CREATE TABLE IF NOT EXISTS, not CREATE OR REPLACE. Re-running this must never
   discard a loaded file or drop the app's grants — see section 3 of
   sp-mtn-save-prep.sql for what an unguarded CREATE OR REPLACE did to them.

   To add a column later, use the ALTER in section 2 rather than editing this
   and re-running: IF NOT EXISTS makes this statement a no-op once the table is
   there, so an edited version of it will appear to succeed and change nothing.
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND (
    -- The 24 from your runbook, in your order.
    MSISDN               VARCHAR(500),
    ACCOUNT_NO           VARCHAR(500),
    ID_NUMBER            VARCHAR(500),
    ASPU                 VARCHAR(500),
    MB_USAGE             VARCHAR(500),
    MIN_USAGE            VARCHAR(500),
    CURR_TARIFF_NM       VARCHAR(500),
    EMAIL_ADDRESS        VARCHAR(500),
    WORK_PHONE_NO        VARCHAR(500),
    CELL_PHONE_NO        VARCHAR(500),
    HOME_PHONE_NO        VARCHAR(500),
    GENDER               VARCHAR(500),
    CREDIT_LIMIT_AMT     VARCHAR(500),
    AVAIL_CREDIT_AMT     VARCHAR(500),
    FIRST_NAME           VARCHAR(500),
    LAST_NAME            VARCHAR(500),
    CONTACT_AS           VARCHAR(500),
    CONTRACT_END_DATE    VARCHAR(500),
    DEVICE_MANUFACTURER  VARCHAR(500),
    DEVICE_MODEL         VARCHAR(500),
    CHG_SUBS_VAT         VARCHAR(500),
    PRICE_PLAN_GROUP     VARCHAR(500),
    RECOMMENDATION       VARCHAR(500),
    FILENAME             VARCHAR(500),

    -- The six the file carries and the runbook added too late. Reason 1.
    RECOMMENDATION_1     VARCHAR(500),
    RECOMMENDATION_2     VARCHAR(500),
    RECOMMENDATION_3     VARCHAR(500),
    RECOMMENDATION_4     VARCHAR(500),
    RECOMMENDATION_5     VARCHAR(500),
    RECOMMENDATION_6     VARCHAR(500),

    -- Written by SP_MTN_SAVE_PREP, not by the file. ESTATUS carries the
    -- exclusion reason; ROWNUMB is the duplicate ranking the procedure rebuilds
    -- on every run. Declared here so the procedure's self-healing ADD COLUMN
    -- guards are a safety net rather than the only thing creating them.
    ESTATUS              VARCHAR(500),
    ROWNUMB              NUMBER(38,0)
);

/* RECOMMENDATION, SINGULAR, IS KEPT. If the file turns out not to have it the
   column simply stays NULL, which costs nothing — and if it DOES have it
   alongside the six, dropping it here would silently discard whatever it
   holds. Section 4 says which. */


/* -----------------------------------------------------------------------------
   SECTION 2 — adding a column the file turns out to need

   Once section 4 has told you what the 25 headers actually are, anything
   missing goes in like this. ALTER TABLE ADD COLUMN has no IF NOT EXISTS in
   Snowflake, so a second run errors — which is harmless and honest.

     ALTER TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       ADD COLUMN <NAME> VARCHAR(500);

   VARCHAR(500) for anything from the file, whatever it looks like. Reason 3.

   ADDING A COLUMN DOES NOT DISTURB THE GRANTS, unlike a CREATE OR REPLACE. No
   need to re-run section 3 afterwards.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — grants

   Also in 00-grants.sql section 7; repeated here so this file is deployable on
   its own. Safe to re-run.

   DELETE, NOT TRUNCATE. Snowflake has no grantable TRUNCATE privilege — it
   requires OWNERSHIP — so the upload clears the table with DELETE FROM when
   "replace existing rows" is chosen. The route tries TRUNCATE first and falls
   back, so without DELETE the first batch fails on a table the app can
   otherwise write to perfectly well.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE              TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION   TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, DELETE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
  TO ROLE SVC_VERCEL_APP_ROLE;

-- SP_MTN_SAVE_PREP runs CREATE OR REPLACE TABLE and ALTER TABLE against this
-- table, and both require OWNERSHIP rather than a grant. The procedure is
-- EXECUTE AS OWNER, so it is the CREATING role that needs it — replace SYSADMIN
-- if you create the procedure as something else.
GRANT CREATE TABLE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION TO ROLE SYSADMIN;
-- Only if it is not already owned there:
--   GRANT OWNERSHIP ON TABLE DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
--     TO ROLE SYSADMIN COPY CURRENT GRANTS;


/* -----------------------------------------------------------------------------
   SECTION 4 — reconcile the table against the file's 25 headers

   Run 4a and compare it, by eye, against the header row in the upload preview.
   That screen lists all 25; this lists all 32. Two things to look for:

     a header in the file with NO column here   → add it, section 2
     RECOMMENDATION_1..6 present in both        → reason 1 is settled

   The upload's mapping step is the other half of this check and the easier
   one: it shows each file header next to the column it will write to, so an
   unmatched header is visible there before you load.
-------------------------------------------------------------------------------- */

SELECT ORDINAL_POSITION AS POS,
       COLUMN_NAME,
       DATA_TYPE,
       CHARACTER_MAXIMUM_LENGTH AS LEN
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
 ORDER BY ORDINAL_POSITION;

-- 4b. Nothing should be NUMBER except ROWNUMB. Reason 3 — a NUMBER column
--     would silently cast '6.31008E+12' to 6310080000000 on load.
SELECT COLUMN_NAME, DATA_TYPE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'DISTRIBUTION'
   AND TABLE_NAME   = 'TM_MU2_MTNSAVESOUTBOUND'
   AND DATA_TYPE   <> 'TEXT'
   AND COLUMN_NAME <> 'ROWNUMB';


/* -----------------------------------------------------------------------------
   SECTION 5 — after the first upload, before anything else

   Run this the moment the load finishes. It is four numbers and it decides
   whether to carry on or re-export the file.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                          AS ROWS_LOADED,
       COUNT_IF(LEN(ID_NUMBER) = 13)                     AS LOOKS_LIKE_AN_ID,
       COUNT_IF(ID_NUMBER ILIKE '%E+%')                  AS STILL_MANGLED,
       COUNT_IF(RECOMMENDATION_1 IS NOT NULL
                AND TRIM(RECOMMENDATION_1) <> '')        AS HAS_REC_1
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;

/* HOW TO READ IT

   STILL_MANGLED must be 0. Anything else means the scientific-notation fix is
   not in the deployed build, and you should STOP — the ID numbers in those rows
   cannot be recovered from Snowflake, only re-uploaded. The preview would also
   have said so: it raises a banner counting the cells it expanded.

   LOOKS_LIKE_AN_ID should be close to ROWS_LOADED. A shortfall is either
   genuinely malformed IDs in the file or the '0000000000000' placeholders that
   SP_MTN_SAVE_PREP marks as INVALID ID — both are 13 characters, so check:

     SELECT LEN(ID_NUMBER) AS CHARS, COUNT(*) AS ROWS_AFFECTED
       FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
      GROUP BY 1 ORDER BY ROWS_AFFECTED DESC;

   HAS_REC_1 should be most of ROWS_LOADED. Zero means the six recommendation
   columns still are not arriving — the mapping step in the upload is where to
   look, not this table.

   THEN: 00-grants.sql section 8c, from step 1.
-------------------------------------------------------------------------------- */
