/* =============================================================================
   MTN SAVE (campaign 11204) — the CXM dialler view
   -----------------------------------------------------------------------------
   Your view, with three columns stopped from pretending to read data that does
   not exist, and every source column qualified. 55 columns, in your order.

   READ SECTION 6 BEFORE THE FIRST RUN. THE APP DOES NOT USE THIS VIEW.

   That is not a criticism of the view and not a reason to delete it — it is a
   fact about where the emailed file comes from, and it has a consequence for
   MTN Save that will otherwise show up as a wrong column in a file CXM has
   already received.

   The app's Extract data and Email data steps build the file from the HLL table
   directly, applying the campaign's EXPORT LAYOUT — a stored per-campaign
   column list (Settings → Export layout (CXM)). So there are two independent
   descriptions of the same 55-column file:

       this view                    what you get from a worksheet
       the campaign's export layout what the app extracts and emails

   They have to be kept in agreement by hand. Section 6 is the mapping to type
   into the layout editor, and the three columns that come out WRONG if you skip
   it.

   -----------------------------------------------------------------------------
   THE CHANGE: THREE COLUMNS READ UDMs THAT NOTHING POPULATES (defect 10)

     SERIAL_NUMBER   ← REGEXP_REPLACE(UDM25, ...)
     DEVICE_VALUE    ← REGEXP_REPLACE(UDM3, ...)
     MVNX_NUMBER     ← UDM4

   Neither of your two INSERTs writes UDM25, UDM3 or UDM4 — UDM3 and UDM4 are
   commented out in both (they wanted CREDIT_LIMIT and MOST_USED_PROVINCE, and
   MOST_USED_PROVINCE does not exist in the staging table at all), and UDM25 is
   not mentioned anywhere in the runbook. They are leftovers from whichever
   campaign's view this was copied from.

   So they are always NULL, and the REGEXP_REPLACE around two of them is work
   done on nothing. They stay in the view as explicit CAST(NULL AS VARCHAR) so
   that THE COLUMN LIST AND ITS ORDER ARE UNCHANGED FOR CXM — a positional CSV
   contract must not shift — but they no longer claim to read a column.

   CAST rather than a bare NULL, deliberately: REGEXP_REPLACE returns VARCHAR,
   so anything that introspects this view's schema sees exactly what it saw
   before. A bare untyped NULL would have changed the declared type.

   IF ANY OF THE THREE SHOULD CARRY REAL DATA, the staging table has the columns
   for two of them and section 4 shows how well populated they are:

     DEVICE_VALUE / DEVICE_DETAILS   DEVICE_MANUFACTURER, DEVICE_MODEL,
                                     CHG_SUBS_VAT
     AVERAGESPEND                    ASPU, which is already in UDM1

   That needs a UDM in VW_MTN_SAVE_HLL_LOAD as well as a line here, so it is a
   two-file change and I have not made it on my own initiative.

   -----------------------------------------------------------------------------
   ONE THING I HARDENED: EVERY SOURCE COLUMN IS NOW QUALIFIED

   Your join is

       LEFT JOIN SILVERSURFER SS ON (A.IDNUMBER = SS.IDNO AND BATCHNAME = SS.BATCH)

   with BATCHNAME unqualified. It resolves today because the CTE aliases its
   batch column to BATCH, not BATCHNAME — but that is luck, not design, and this
   exact class of bug has bitten this repo before: an unqualified column that
   becomes ambiguous the moment someone adds a column to the CTE, and Snowflake
   then either errors or silently reads the wrong side. Every column below is
   prefixed A. or SS. There is no behaviour change; there is one fewer way for a
   later edit to break this quietly.

   -----------------------------------------------------------------------------
   THREE THINGS I DID NOT CHANGE

   A. THIS VIEW IS WHERE ESTATUS IS ACTUALLY ENFORCED.
      `AND A.ESTATUS is null` — so DNC, INVALID ID, DUPLICATE LEAD and Incorrect
      Cell Number leads never reach CXM. It is the only place in the MTN Save
      pipeline that filters on ESTATUS; the SilverSurfer view does not. Worth
      knowing, because it means the labels the prep procedure writes are load
      bearing here and decorative there.

   B. THE DE-DUPLICATION ORDERS BY SCORE, WHICH IS A REAL PREFERENCE.
          QUALIFY ROW_NUMBER() OVER (PARTITION BY PROVIDER_ACCOUNT_NUMBER
                                     ORDER BY SCORE DESC) = 1
      Good — unlike the SilverSurfer view's, which orders by the column it
      partitions by. But it depends on SCORE being populated, and until the
      UDM17 fix in sp-mtn-save-hll-load.sql it was null on every row that came
      through your second INSERT. So this ordering has been close to arbitrary,
      and it will now choose differently. Expect the file's CONTENTS to shift on
      the first run even where the row count does not. That is the fix working,
      not a regression.

   C. THE SILVERSURFER CTE READS A DIFFERENT SCHEMA FROM THE REST OF THIS APP.
      This view reads "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMER";
      the app's own batch-upload reconciliation reads
      "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER". Same data, presumably,
      through two different Hevo landings — but if they are not in step, this
      view's SS_LEADCUSTOMERID and the reconciliation's counts disagree about
      the same batch, and nothing would say so. That question is still open and
      is not mine to settle; section 5 is the query that answers it.

   AND ONE COLUMN THAT IS FED PROPERLY ONLY IF THE RANKING RAN:
      DATA_DAY_RANK ← UDM30, set by SP_AUTORANK(11204, 20) in the update-HLL
      step. If that procedure has not run, the column is null for every lead and
      CXM has nothing to spread the dialling across the day by.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the view
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.DISTRIBUTION.VW_KM_MTN_SAVES_OUTBOUND_DIALER_AUTOMATION
COPY GRANTS
AS
WITH SILVERSURFER AS (
    SELECT A.IDNUMBER    AS IDNO,
           A.LEADCUSTOMERID,
           B.BATCHNAME   AS BATCH
      FROM "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMER" A
      JOIN "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMERDETAILS" B
        ON A.LEADCUSTOMERID = B.LEADCUSTOMERID
     WHERE CAMPAIGNID IN (11204)
       AND B.BATCHNAME IN (SELECT DISTINCT BATCHNAME
                             FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
                            WHERE CAMPAIGNID = 11204
                              AND CREATEDONDATE >= CURRENT_DATE())
)
SELECT * FROM (
SELECT RTRIM(LTRIM(A.CUSTOMERNAME))                            AS "First Name"       --  1
     , RTRIM(LTRIM(A.LASTNAME))                                AS "Last Name"        --  2
     , DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CELLNUMBER)
                                                               AS "Contact No"       --  3
     , A.EMAIL                                                 AS "Email ID"         --  4
     , NULL                                                    AS "Address"          --  5
     , A.IDNUMBER                                              AS IDNUMBER           --  6
     , LEFT(A.IDNUMBER, 6)                                     AS MASKID             --  7
     , A.CAMPAIGNID                                            AS CAMPAIGNID         --  8
     , A.BATCHNAME                                             AS BATCHNAME          --  9
     , CURRENT_DATE()                                          AS CREATEDONDATE      -- 10
     , CAST(CURRENT_DATE() AS DATE) + 30                       AS LEADEXPIRY         -- 11
     , NULL                                                    AS BANK               -- 12
     , NULL                                                    AS BANKACCOUNTTYPE    -- 13
     , NULL                                                    AS BRANCHCODE         -- 14
     -- was REGEXP_REPLACE(UDM25, ...): nothing populates UDM25. Defect 10.
     , CAST(NULL AS VARCHAR)                                   AS SERIAL_NUMBER      -- 15
     , NULL                                                    AS DEBIT_DAY          -- 16
     , NULL                                                    AS AVERAGESPEND       -- 17
     , NULL                                                    AS MARKETING_OFFER_DESC -- 18
     , NULL                                                    AS ORDERDATE          -- 19
     , NULL                                                    AS ADDRESS_RANK       -- 20
     , REGEXP_REPLACE(A.UDM1, '[^a-zA-Z0-9|:,.\s-]', ' ')      AS SOURCEORDER        -- 21
     -- was REGEXP_REPLACE(UDM3, ...): nothing populates UDM3. Defect 10.
     , CAST(NULL AS VARCHAR)                                   AS DEVICE_VALUE       -- 22
     , NULL                                                    AS CONTRACTTYPE       -- 23
     , NULL                                                    AS PAYDAY             -- 24
     , NULL                                                    AS SOURCE             -- 25
     , NULL                                                    AS UPGRADE_DATE       -- 26
     , NULL                                                    AS ACTIVATIONDATE     -- 27
     -- was UDM4: nothing populates UDM4. Defect 10.
     , CAST(NULL AS VARCHAR)                                   AS MVNX_NUMBER        -- 28
     , NULL                                                    AS LTE_COVERAGE       -- 29
     , NULL                                                    AS INSURANCEPRICE     -- 30
     , NULL                                                    AS PREMIUM            -- 31
     , NULL                                                    AS PROVINCE           -- 32
     , NULL                                                    AS HANDSETPRICE       -- 33
     , CAST(NULL AS NUMBER(38, 0))                             AS PROVINCE_RANK      -- 34
     , NULL                                                    AS DEVICE_TYPE        -- 35
     , NULL                                                    AS DATE_OF_PURCHASE   -- 36
     , NULL                                                    AS TAKEUP_PROB        -- 37
     , CAST(NULL AS NUMBER(38, 0))                             AS MATOGEN_SCORE      -- 38
     , A.SCORE                                                 AS SCORE              -- 39
     , A.SCOREGROUP                                            AS SCOREGROUP         -- 40
     , CASE
         WHEN A.OPTINSTATUS::INT = 0 THEN 'CUSTOMER NOT OPTED IN'
         WHEN A.OPTINSTATUS::INT = 1 THEN 'CUSTOMER ALREADY OPTED'
         WHEN A.OPTINSTATUS::INT = 2 THEN 'CUSTOMER ALREADY OPTED OUT'
       END                                                     AS OPTINSTATUS        -- 41
     , A.PROPENSITYTOCONNECT::INT                              AS PROPENSITYTOCONNECT -- 42
     , NULL                                                    AS SKILL              -- 43
     , NULL                                                    AS BANK_ACCOUNT_MASKED -- 44
     , A.HLL_ID                                                                       -- 45
     , REGEXP_REPLACE(A.UDM2,  '[^a-zA-Z0-9|:,.\s-]', ' ')     AS CURRENT_PACKAGE    -- 46
     , REGEXP_REPLACE(A.UDM30, '[^a-zA-Z0-9|:,.\s-]', ' ')     AS DATA_DAY_RANK      -- 47
     , NULL                                                    AS DEVICE_DETAILS     -- 48
     , RTRIM(IFNULL(A.IDNUMBER, A.CELLNUMBER))                 AS PROVIDER_ACCOUNT_NUMBER -- 49
     , SS.LEADCUSTOMERID                                       AS SS_LEADCUSTOMERID  -- 50
     , CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER1)
                 = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CELLNUMBER)
            THEN NULL
            ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER1)
       END                                                     AS CONTACTNUMBER2     -- 51
     , CASE WHEN DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER2)
                 = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER1)
             OR DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER2)
                 = DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CELLNUMBER)
            THEN NULL
            ELSE DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(A.CONTACTNUMBER2)
       END                                                     AS CONTACTNUMBER3     -- 52
     , NULL                                                    AS COMMENT            -- 53
     , REGEXP_REPLACE(A.EXTRADATA, '[^a-zA-Z0-9|:,.\s-]', ' ') AS EXTRADATA          -- 54
     , NULL                                                    AS "Next Dial Time"   -- 55
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED A
LEFT JOIN SILVERSURFER SS
       ON A.IDNUMBER = SS.IDNO
      AND A.BATCHNAME = SS.BATCH
WHERE A.CAMPAIGNID = 11204
  AND CAST(A.CREATEDONDATE AS DATE) >= CAST(CURRENT_DATE() AS DATE)
  AND A.ESTATUS IS NULL                                        -- note A
)
WHERE "Contact No" IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY PROVIDER_ACCOUNT_NUMBER
                           ORDER BY SCORE DESC) = 1;           -- note B

/* THE SHIFTED CONTACT NUMBERS ARE INTENTIONAL AND WORTH READING TWICE.
   Column 51 is called CONTACTNUMBER2 and holds CONTACTNUMBER1; column 52 is
   called CONTACTNUMBER3 and holds CONTACTNUMBER2. That is because column 3
   ("Contact No") already carries CELLNUMBER, so the numbering is CXM's, not the
   HLL's — and each is nulled where it would repeat one already sent. Yours,
   unchanged. CONTACTNUMBER3 from the HLL (the home number) is therefore NOT in
   this file at all: three slots, four numbers. If the home number should reach
   CXM it needs a column of its own, which changes the layout. */


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   All in 00-grants.sql section 7 — SELECT on this view, and USAGE on
   SF_PHONE_NUMBER_FIX_CXM. COPY GRANTS above, so re-running section 1 keeps
   them.

   The app also needs SELECT on the two SILVERSURFER_LEAD_HEVO tables the CTE
   reads. Those are Hevo-owned and already granted for the batch-upload check;
   if this view fails with "does not exist or not authorized" and the view
   itself is granted, that CTE is where to look.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — what the file will contain, before you send it

   Run it after the update-HLL steps. LEADS is the row count of the CXM file.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                        AS LEADS_IN_THE_FILE,
       COUNT_IF(SCORE IS NULL)                         AS NO_SCORE,
       COUNT_IF(DATA_DAY_RANK IS NULL)                 AS NO_DAY_RANK,
       COUNT_IF(OPTINSTATUS IS NULL)                   AS NO_OPTIN_STATUS,
       COUNT_IF(SS_LEADCUSTOMERID IS NULL)             AS NOT_YET_IN_SILVERSURFER
  FROM DATAWAREHOUSE.DISTRIBUTION.VW_KM_MTN_SAVES_OUTBOUND_DIALER_AUTOMATION;

/* NO_DAY_RANK at the full row count means SP_AUTORANK(11204, 20) has not run —
   check the update-HLL step order in the config.

   NOT_YET_IN_SILVERSURFER at the full row count is EXPECTED before the sync and
   a problem after it: the CTE looks the leads up by IDNUMBER and batch, so a
   full count after a successful sync means either the sync did not land or the
   two SilverSurfer schemas are out of step — note C, and section 5. */


/* -----------------------------------------------------------------------------
   SECTION 4 — the three empty columns, and what could fill them — defect 10

   4a proves they were always empty: every count should be zero on data loaded
   before today's change as well as after it.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                        AS ROWS_LOADED,
       COUNT_IF(UDM25 IS NOT NULL)     AS UDM25_EVER_SET,
       COUNT_IF(UDM3  IS NOT NULL)     AS UDM3_EVER_SET,
       COUNT_IF(UDM4  IS NOT NULL)     AS UDM4_EVER_SET
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204;

-- 4b. And what the file could carry instead, if any of it is worth having.
SELECT COUNT(*)                                        AS ROWS_IN_STAGING,
       COUNT_IF(DEVICE_MANUFACTURER IS NOT NULL)       AS HAS_MANUFACTURER,
       COUNT_IF(DEVICE_MODEL IS NOT NULL)              AS HAS_MODEL,
       COUNT_IF(CHG_SUBS_VAT IS NOT NULL)              AS HAS_SUBS_VAT,
       COUNT_IF(PRICE_PLAN_GROUP IS NOT NULL)          AS HAS_PLAN_GROUP
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;


/* -----------------------------------------------------------------------------
   SECTION 5 — are the two SilverSurfer schemas in step? — note C

   This view reads SILVERSURFER_LEAD_HEVO.LEADCUSTOMER; the app's batch-upload
   check reads SILVERSURFER.LEAD_LEADCUSTOMER. If the counts differ for the same
   batch, one of them is stale and the two disagree about whether a lead arrived.

   Run it after a sync. Matching counts settle the question; differing counts
   mean the reconciliation and this view cannot both be trusted, and the one to
   keep is whichever the SilverSurfer team says is current.
-------------------------------------------------------------------------------- */

WITH BATCHES AS (
    SELECT DISTINCT BATCHNAME
      FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
     WHERE CAMPAIGNID = 11204
       AND CREATEDONDATE >= CURRENT_DATE()
)
SELECT b.BATCHNAME,
       (SELECT COUNT(DISTINCT s.LEADCUSTOMERID)
          FROM "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMER" s
          JOIN "DATAWAREHOUSE"."SILVERSURFER_LEAD_HEVO"."LEADCUSTOMERDETAILS" d
            ON s.LEADCUSTOMERID = d.LEADCUSTOMERID
         WHERE d.BATCHNAME = b.BATCHNAME)                    AS HEVO_SCHEMA_COUNT,
       (SELECT COUNT(DISTINCT s.LEADCUSTOMERID)
          FROM "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER" s
          JOIN "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMERDETAILS" d
            ON s.LEADCUSTOMERID = d.LEADCUSTOMERID
         WHERE d.BATCHNAME = b.BATCHNAME)                    AS APP_SCHEMA_COUNT
  FROM BATCHES b;


/* -----------------------------------------------------------------------------
   SECTION 6 — THE EXPORT LAYOUT, WHICH IS WHAT ACTUALLY GETS EMAILED

   The app never reads this view. `buildQuery` in lib/distribution-export.ts
   selects from TM_HLL_HISTORYLEADSLOADED directly, renders the campaign's
   stored export layout as its SELECT list, and applies the same shape this view
   does — ESTATUS IS NULL, one row per IDNUMBER ordered by SCORE DESC, ordered
   by UDM30. So the file is built from the same rows by a different definition.

   WITH NO LAYOUT SAVED FOR 11204 IT FALLS BACK TO THE DEFAULT — WHICH IS SPOT
   CONNECT 1'S. That layout reads UDM columns that mean something else here, and
   three columns come out actively wrong rather than merely empty:

     header in the file   default layout reads   which for MTN Save is
     ------------------   --------------------   ---------------------------
     Address              UDM7                   RECOMMENDATION_2
     LTE_COVERAGE         UDM6                   RECOMMENDATION_1
     PROVINCE             UDM9                   CONTACT_AS

   A save offer in a column headed "Address" is worse than a blank one: it is
   plausible-looking data in the wrong field, and nothing downstream can tell.

   And three columns this view fills would arrive empty, because the default
   layout NULLs them:

     SOURCEORDER               ← UDM1  (ASPU)
     CURRENT_PACKAGE           ← UDM2  (CURR_TARIFF_NM)
     PROVIDER_ACCOUNT_NUMBER   ← IFNULL(IDNUMBER, CELLNUMBER)

   THE REST ALREADY AGREES, and it is worth knowing how much: First Name, Last
   Name, Contact No, Email ID, IDNUMBER, MASKID, CAMPAIGNID, BATCHNAME,
   CREATEDONDATE, LEADEXPIRY, SCORE, SCOREGROUP, OPTINSTATUS,
   PROPENSITYTOCONNECT, HLL_ID, DATA_DAY_RANK (UDM30), SS_LEADCUSTOMERID,
   CONTACTNUMBER2, CONTACTNUMBER3 and EXTRADATA all match this view already —
   including the ones the default layout NULLs that this view also NULLs, which
   is the majority. SERIAL_NUMBER, DEVICE_VALUE and MVNX_NUMBER are NULL in the
   default layout too: the app made the same call about them that defect 10
   makes above, independently, which is some comfort that it is the right one.

   SO: SIX EDITS IN Settings → THE CAMPAIGN → EXPORT LAYOUT (CXM).
   Everything else stays as it is.

     Address                   → NULL          (was UDM7)
     LTE_COVERAGE              → NULL          (was UDM6)
     PROVINCE                  → NULL          (was UDM9)
     SOURCEORDER               → UDM1, "Strip odd characters"  (was NULL)
     CURRENT_PACKAGE           → UDM2, "Strip odd characters"  (was NULL)
     PROVIDER_ACCOUNT_NUMBER   → preset "ID number, falling back to the cell
                                 number"        (was NULL)

   ADDRESS_RANK can stay on UDM3: nothing populates UDM3 for MTN Save, so it
   renders empty, and that matches this view's `NULL AS ADDRESS_RANK`.

   The editor writes the layout to EXPORT_LAYOUT_JSON on the campaign's config
   row. Nothing here needs deploying and nothing in the app changes.

   -----------------------------------------------------------------------------
   THEN WHAT THIS VIEW IS FOR

   Keep it. It is the object to query when you want to see the file's contents
   in a worksheet without running an export, it is what CXM's own automation
   reads if it reads Snowflake directly, and it is the reference the layout is
   checked against. Section 3's counts are the pre-send check either way, since
   both definitions select the same rows.

   One caveat if you use it to predict the emailed file: this view stamps
   CREATEDONDATE with CURRENT_DATE() and LEADEXPIRY with today + 30, while the
   export layout reads the ROW's own load date for both. Identical on the day of
   the load; different on a re-send of an older batch, which the app's date
   picker allows and a worksheet query of this view does not.
-------------------------------------------------------------------------------- */
