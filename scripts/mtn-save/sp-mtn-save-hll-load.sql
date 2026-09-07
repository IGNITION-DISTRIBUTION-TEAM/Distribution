/* =============================================================================
   MTN SAVE (campaign 11204) — the HLL load
   -----------------------------------------------------------------------------
   Your two INSERT ... SELECTs as ONE view the app reads, so the load becomes a
   step it can run, retry and count rather than two statements someone pastes
   into a worksheet.

       upload file → DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
       SP_MTN_SAVE_PREP(11204)                       (sp-mtn-save-prep.sql)
       VW_MTN_SAVE_HLL_LOAD → TM_HLL_HISTORYLEADSLOADED       ← this file

   -----------------------------------------------------------------------------
   WHY ONE VIEW AND NOT TWO — THIS IS THE BIGGEST CHANGE IN THE FOLDER

   Your two INSERTs are not two filters on one shape. They overlap, and they map
   different columns.

     INSERT 1   reads cte1, i.e. ROWNUMB = 1, with NO ESTATUS condition
     INSERT 2   reads WHERE ESTATUS IS NOT NULL, with NO row condition

   So a row-1 lead labelled 'INVALID ID' or 'Incorrect Cell Number' satisfies
   BOTH and lands in the HLL twice — under two different IDNUMBERs, because:

     INSERT 1   IDNUMBER = ACCOUNT_NO,  UDM17 = ID_NUMBER
     INSERT 2   IDNUMBER = ID_NUMBER,   UDM17 = ACCOUNT_NO

   That second disagreement then breaks the credit-risk update, which joins
   `a.UDM17 = S.idno` — an ID number. It can only ever match the rows INSERT 1
   put there. Rows from INSERT 2 get no SCORE and no SCOREGROUP, and SCORE is
   what the dialler view orders its de-duplication by.

   Step 15 of your runbook says which mapping is intended:

       UPDATE ...TM_HLL_HISTORYLEADSLOADED b
          SET b.IDNUMBER = a.ACCOUNT_NO
         FROM ...TM_MU2_MTNSAVESOUTBOUND a
        WHERE a.id_number = b.UDM17

   — a patch that drags INSERT 2's rows into INSERT 1's shape after the fact.

   So this view uses INSERT 1's mapping (IDNUMBER = ACCOUNT_NO, UDM17 =
   ID_NUMBER) with INSERT 2's fuller UDM set, over ALL rows, unfiltered.

   That: removes the double load; makes UDM17 mean one thing so the credit join
   works for every row; and DELETES STEP 15 ENTIRELY — there is nothing left to
   patch. Do not run it. It is not in this folder.

   -----------------------------------------------------------------------------
   THE CONTACT NUMBERS ARE THE UNION OF YOUR TWO INSERTS

   The two disagreed here as well, and between them they used all three:

     INSERT 1   CONTACTNUMBER1 = CELL_PHONE_NO   CONTACTNUMBER3 = HOME_PHONE_NO
                (nothing in CONTACTNUMBER2, and WORK_PHONE_NO unused)
     INSERT 2   CONTACTNUMBER1 = WORK_PHONE_NO   CONTACTNUMBER2 = HOME_PHONE_NO
                (CELL_PHONE_NO unused)

   One slot each, no column doing double duty:

     CONTACTNUMBER1 = CELL_PHONE_NO
     CONTACTNUMBER2 = WORK_PHONE_NO
     CONTACTNUMBER3 = HOME_PHONE_NO

   This is a decision, not a translation. It is the only arrangement that
   carries all three numbers, it keeps CELL_PHONE_NO — the best of the three —
   in the slot the dialler view reads first, and it is why the prep procedure's
   blanking and enrichment work is worth doing at all. Say the word and it goes
   back to either original.

   -----------------------------------------------------------------------------
   WHAT THE VIEW DOES NOT SUPPLY, AND WHY

   CAMPAIGNID, BATCHNAME, CREATEDONDATE and LEADEXPIRY are not here. The app
   fills all four from the automation config and strips them out of any column
   mapping, so a view supplying them would be four columns you have to remember
   not to map.

   THE BATCH NAME IS REPRODUCED EXACTLY. Yours:

       replace(concat('EX', cast(current_date()+30 as date), 'MTNSAVESOUTBOUND',
                      cast(current_date() as date), 'B1'), '-')

   With batch template EX{expiry}MTNSAVESOUTBOUND{date}B1 and lead expiry 30,
   the app generates

       CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
              'MTNSAVESOUTBOUND',
              REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')

   Same string. Your outer REPLACE strips hyphens from the whole concatenation,
   but 'EX', 'MTNSAVESOUTBOUND' and 'B1' contain none, so stripping them from
   the two dates alone is the same thing. Section 5a proves it against your
   original, on the day you run it.

   TWO DATE DIFFERENCES, BOTH DELIBERATE:

   1. LEADEXPIRY. Yours is `dateadd(MM, 1, getdate())` — one calendar month. The
      config's is CURRENT_DATE + 30 days. They differ by a day in a 31-day month
      and by two in March. I have used 30 days because your BATCH NAME already
      uses current_date()+30, so on 31-day months your own batch name and your
      own expiry date disagreed with each other. 30 makes them agree. If the
      month is the one that matters, the batch template has to change with it
      and the app cannot express "+1 month" — that would need the expiry back
      inside the view.

   2. CREATEDONDATE. Yours is `getdate()`, a TIMESTAMP. The app writes
      CURRENT_DATE, a date. THIS IS WHAT FIXES DEFECT 1: your DNC statement's
      `and createdondate = current_date()` compares against midnight, so a
      timestamp never matched and DNC was never applied. A plain date matches.
      SP_MTN_SAVE_POST_LOAD casts on both sides anyway, so it is correct either
      way — but the root cause goes away here.

   -----------------------------------------------------------------------------
   FOUR SMALLER THINGS IN THE MAPPING

   1. EVERY RECOMMENDATION IS LOADED TWICE OR THREE TIMES.
      RECOMMENDATION_1 goes to UDM5, UDM6 AND UDM14; RECOMMENDATION_2 to UDM7
      and UDM15; RECOMMENDATION_3 to UDM8 and UDM16. Kept, because something
      downstream may read either copy and I cannot see which — but it is six
      columns of duplicated text and worth a look. UDM5 additionally differs
      from UDM6 only in an IFNULL(...,''), so a lead with no first
      recommendation gets '' in UDM5 and NULL in UDM6.

   2. AND NOTHING THE CXM VIEW READS COMES FROM THEM.
      VW_KM_MTN_SAVES_OUTBOUND_DIALER_AUTOMATION reads UDM1, UDM2, UDM30 and
      EXTRADATA — not one of UDM5-8 or UDM14-20. So the recommendations reach a
      CXM agent ONLY through EXTRADATA. On the SilverSurfer side they reach the
      agent only through ExtraData too. Ten HLL columns are being filled for a
      screen that does not read them.

   3. UDM3, UDM4, UDM10-13 AND UDM21 STAY UNFILLED.
      They are commented out in both your INSERTs, and the columns they wanted
      (MOST_USED_PROVINCE, Hero_deal, iLula_*, Total_Subscription, TYPE_CAT) do
      not exist in the staging table. Left out rather than faked. This matters
      for the dialler view — see defect 10 in sp-mtn-save-dialler.sql.

   4. FIVE STAGING COLUMNS ARE NEVER USED AT ALL:
      MB_USAGE, MIN_USAGE, GENDER, CREDIT_LIMIT_AMT, AVAIL_CREDIT_AMT,
      DEVICE_MANUFACTURER, DEVICE_MODEL, CHG_SUBS_VAT, PRICE_PLAN_GROUP and
      CONTRACT_END_DATE. That is ten of the twenty-four columns in the file
      loaded and then discarded. DEVICE_MANUFACTURER and DEVICE_MODEL are the
      obvious feed for the dialler view's DEVICE_DETAILS, which is currently
      NULL. Not added on my own initiative; section 6 has the one-line change.

   -----------------------------------------------------------------------------
   THE ONE THING TO DECIDE BEFORE YOU RUN THIS

   THE VIEW HAS NO WHERE CLAUSE — same as your INSERT 1. Every row loads,
   including every row the prep procedure just labelled:

       Incorrect Cell Number    MSISDN not 11 digits, or missing
       DUPLICATE LEAD           second and later rows for one ACCOUNT_NO
       INVALID ID               ID_NUMBER = '0000000000000'
       DNC                      added later, by SP_MTN_SAVE_POST_LOAD

   ESTATUS travels with them, so the reason is not lost, AND FOR MTN SAVE THERE
   IS A REAL ANSWER to whether anything downstream filters on it — unlike the
   other campaigns in this repo:

     the CXM dialler view      filters `AND ESTATUS is null`  → labelled leads
                                                                never dialled
     the SilverSurfer view     does NOT filter on ESTATUS     → labelled leads
                                                                ARE pushed

   So labelled leads reach SilverSurfer and not CXM. If SilverSurfer is a
   record of what was loaded, that is correct and deliberate. If it feeds an
   agent, then DNC and INVALID ID leads are being dialled through it, and the
   fix belongs in sp-mtn-save-silversurfer.sql section 3 — not here.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the view

   Every column is named after the HLL column it feeds, so the app's mapper
   matches them automatically and there is nothing to map by hand. Your aliases
   are kept as trailing comments where they said something.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_MTN_SAVE_HLL_LOAD
COPY GRANTS
AS
SELECT
     a.ACCOUNT_NO                             AS IDNUMBER          -- INSERT 1's mapping
    ,'External'                               AS DATATYPE
    ,a.FIRST_NAME                             AS CUSTOMERNAME      -- your alias: FIRSTNAME
    ,a.LAST_NAME                              AS LASTNAME
    ,a.MSISDN                                 AS CELLNUMBER
    ,a.CELL_PHONE_NO                          AS CONTACTNUMBER1    -- see header
    ,a.WORK_PHONE_NO                          AS CONTACTNUMBER2
    ,a.HOME_PHONE_NO                          AS CONTACTNUMBER3
    ,a.EMAIL_ADDRESS                          AS EMAIL
    ,a.ESTATUS                                AS ESTATUS
    -- INSERT 2's EXTRADATA, which is INSERT 1's without the empty
    -- '|MOST_USED_PROVINCE: ' label — nothing populates that column, so it
    -- rendered as a blank field on every agent screen.
    ,CONCAT('ASPU: ',              IFNULL(CAST(a.ASPU AS VARCHAR), ''),
            '|CURR_TARIFF_NM: ',   IFNULL(CAST(a.CURR_TARIFF_NM AS VARCHAR), ''),
            '|RECOMMENDATION_1: ', IFNULL(a.RECOMMENDATION_1, ''),
            '|RECOMMENDATION_2: ', IFNULL(a.RECOMMENDATION_2, ''),
            '|RECOMMENDATION_3: ', IFNULL(CAST(a.RECOMMENDATION_3 AS VARCHAR), ''),
            '|contact_as: ',       IFNULL(CAST(a.CONTACT_AS AS VARCHAR), ''))
                                              AS EXTRADATA
    ,a.ASPU                                   AS UDM1
    ,a.CURR_TARIFF_NM                         AS UDM2
    -- UDM3, UDM4 not supplied — see note 3, and defect 10 in the dialler view.
    ,IFNULL(a.RECOMMENDATION_1, '')           AS UDM5              -- note 1
    ,a.RECOMMENDATION_1                       AS UDM6              -- note 1
    ,a.RECOMMENDATION_2                       AS UDM7
    ,a.RECOMMENDATION_3                       AS UDM8
    ,a.CONTACT_AS                             AS UDM9
    -- UDM10-13 not supplied.
    ,a.RECOMMENDATION_1                       AS UDM14             -- note 1
    ,a.RECOMMENDATION_2                       AS UDM15
    ,a.RECOMMENDATION_3                       AS UDM16
    ,a.ID_NUMBER                              AS UDM17             -- INSERT 1's mapping
    ,a.RECOMMENDATION_4                       AS UDM18
    ,a.RECOMMENDATION_5                       AS UDM19
    ,a.RECOMMENDATION_6                       AS UDM20
    -- UDM21 not supplied.
    ,a.FILENAME                               AS FILENAME
FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND a;

/* NOT IN THIS VIEW, AND NOT AN OVERSIGHT:

   The four CTEs cte2..cte5 (defect 11). Your INSERT 1 defines them for ROWNUMB
   2 to 5 and LEFT JOINs all four, without selecting a single column from any of
   them. Four joins that cost time and produce nothing. The intent looks like
   "pull a second and third contact number off the duplicate rows" — which is a
   genuinely good idea and is not what the code does. If that IS what you want,
   it belongs in the prep procedure's enrichment block, filling CELL_PHONE_NO
   and HOME_PHONE_NO from the duplicates before they are marked, and it is a
   different conversation from this translation. Section 6 sizes the
   opportunity. */


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   All in 00-grants.sql section 7. The view has COPY GRANTS above, so re-running
   section 1 keeps them — unlike the two procedures.

   The app reads this view AS ITSELF, so SVC_VERCEL_APP_ROLE needs SELECT on the
   view AND on the table underneath it. A non-secure view does not launder
   access.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — the ESTATUS decision

   Run this BEFORE the first load. It tells you what loading every row costs,
   and the split is the answer to the question at the end of the header.
-------------------------------------------------------------------------------- */

SELECT IFNULL(ESTATUS, '(eligible — no label)')                 AS ESTATUS,
       COUNT(*)                                                 AS LEADS,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)         AS PCT
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
 GROUP BY 1
 ORDER BY LEADS DESC;

/* If you decide the labelled rows should not be loaded at all, this is the
   whole change — re-run section 1 with

       WHERE a.ESTATUS IS NULL

   on the end and nothing else differs. But note it would then also hide them
   from your own reporting: the ESTATUS counts in section 5c are the record of
   what the file contained and why leads were dropped. Filtering the SilverSurfer
   view instead keeps that record and stops the push, which is probably what you
   want; see sp-mtn-save-silversurfer.sql section 3.

   And if you do filter here, it must be `ESTATUS IS NULL`, not
   `ESTATUS <> 'DNC'` — the latter is UNKNOWN for an unlabelled row and would
   silently drop every eligible lead in the file. That is a very quiet way to
   send out an empty batch. */


/* -----------------------------------------------------------------------------
   SECTION 4 — THE CONFIG

   Settings → the campaign → Campaign automation. All typed, no code.

     Campaign id            11204
     Lead source            File
     Upload target table    DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND
     Source type            Stored procedure → HLL
     Procedure              DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_PREP(11204)
     Load from              DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_MTN_SAVE_HLL_LOAD

     Update-HLL procedures  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_MTN_SAVE_POST_LOAD()
                            DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE(11204)
                            DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11204,20)
                            DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_PHONENUMBERSCORING_UPDATE(11204)

     Lead expiry (days)     30
     Batch name template    EX{expiry}MTNSAVESOUTBOUND{date}B1

     Sync procedure         DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE
     Sync source view       DATAWAREHOUSE.DISTRIBUTION.VW_AD_MTNSAVESOUTBOUNDSILVERSURFER
     Sync target table      Upload.TempUpload
     Sync batch size        10000
     Sync columns           CustomerCode,CampaignId,IdNumber,CellNumber,CustomerName,
                            LastName,Tariff,ContactNumber1,ContactNumber2,ContactNumber3,
                            ContactNumber4,AvgSpend,HandsetType,HandsetCost,DelAdd,Email,
                            ContractDate,AllocateUser,AllocateDate,AllocateTimeFrom,
                            AllocateTimeTo,LeadExpiry,BatchName,ExtraData,SystemMessage,
                            UpdatedByUserId,UpdatedOnDate,Affordability,AccountNumber,
                            LeadSystemTypeId,BranchCode,Bank,BankAccountType,
                            AccountFirstName,AccountLastName,LeadSourceId,SourceOrderId,
                            HistoryLeadId,OptInStatus
                            (39, comma-separated on ONE line, no spaces —
                             exactly your CALL's third argument, unchanged)

   FOUR THINGS ABOUT THIS CONFIG THAT WILL BITE IF THEY ARE WRONG:

   1. THE ORDER OF THE UPDATE-HLL PROCEDURES IS THE ORDER THEY RUN IN, and it
      matters. SP_MTN_SAVE_POST_LOAD writes SCORE and SCOREGROUP; SP_AUTORANK
      reads them to set UDM30. Put AUTORANK first and it ranks on nulls.

      AND RUN THEM FROM THE CAMPAIGN'S OWN STEPS, NOT FROM TOOLS → UPDATE HLL.
      Manual → step 4 lists all four as separate steps, "Update HLL — <name>",
      in config order. The Tools tab runs ONE procedure — the first of the list
      — so used on its own it runs the post-load procedure and silently skips
      the opt-in update, the ranking and the phone scoring. Only the steps
      honour the ordering above. See scripts/mtn-save/02-hll-procedure-allowlist.sql.

   2. LEAD EXPIRY 30, NOT THE DEFAULT 45. It drives BOTH the LEADEXPIRY column
      and the {expiry} half of the batch name, so 45 here would change the batch
      name as well as the expiry — and the batch name is what the emailed file
      is called and what the reconciliation matches on.

   3. SP_MTN_SAVE_POST_LOAD TAKES NO ARGUMENTS, deliberately. The config field
      allows only letters, digits, commas and spaces between the brackets, so
      'CL1' and '%MTN%' — which its DNC query needs — cannot be typed into
      Settings at all. SP_AUTORANK(11204,20) is fine; a quoted string is not.

   4. THE SYNC COLUMN LIST IS POSITIONAL. The view's SELECT order and this list
      must agree item for item; nothing in SQL will complain if they slip, the
      leads simply land in the wrong fields. Section 5b checks it.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 5 — verification, after the first load and before you trust it
-------------------------------------------------------------------------------- */

-- 5a. The batch name the app generates against the one your script generates.
--     VERDICT must read MATCH.
SELECT
    CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
           'MTNSAVESOUTBOUND', REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')
        AS APP_BATCH,
    REPLACE(CONCAT('EX', CAST(CURRENT_DATE() + 30 AS DATE), 'MTNSAVESOUTBOUND',
                   CAST(CURRENT_DATE() AS DATE), 'B1'), '-')
        AS YOUR_BATCH,
    IFF(CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
               'MTNSAVESOUTBOUND', REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')
        = REPLACE(CONCAT('EX', CAST(CURRENT_DATE() + 30 AS DATE), 'MTNSAVESOUTBOUND',
                         CAST(CURRENT_DATE() AS DATE), 'B1'), '-'),
        'MATCH', 'DIFFERENT')
        AS VERDICT;

-- 5b. Every column the view exposes has a home in the HLL table. Anything
--     listed here is a name the mapper cannot match and would leave unmapped —
--     silently, since an unmapped column is simply absent from the INSERT.
SELECT v.COLUMN_NAME AS VIEW_COLUMN_WITH_NO_HLL_HOME
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS v
 WHERE v.TABLE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
   AND v.TABLE_NAME   = 'VW_MTN_SAVE_HLL_LOAD'
   AND NOT EXISTS (
         SELECT 1
           FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS h
          WHERE h.TABLE_SCHEMA = 'DISTRIBUTION_DATA_APPLICATION'
            AND h.TABLE_NAME   = 'TM_HLL_HISTORYLEADSLOADED'
            AND h.COLUMN_NAME  = v.COLUMN_NAME);

-- 5c. THE ONE THAT PROVES THE DOUBLE LOAD IS GONE.
--     ROWS_LOADED must equal the staging row count EXACTLY, and DISTINCT_IDS
--     plus the duplicate groups from sp-mtn-save-prep.sql section 4 must
--     account for the difference. Under the old two-INSERT version ROWS_LOADED
--     was staging + the number of labelled rows.
SELECT BATCHNAME,
       CAMPAIGNID,
       CREATEDONDATE,
       LEADEXPIRY,
       COUNT(*)                                              AS ROWS_LOADED,
       COUNT(DISTINCT IDNUMBER)                              AS DISTINCT_IDS,
       COUNT_IF(ESTATUS IS NOT NULL)                          AS LABELLED,
       COUNT_IF(CELLNUMBER IS NULL OR TRIM(CELLNUMBER) = '')  AS BLANK_CELLNUMBER,
       COUNT_IF(UDM17 IS NULL)                                AS BLANK_UDM17
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
 GROUP BY 1, 2, 3, 4;

SELECT COUNT(*) AS ROWS_IN_STAGING
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;

-- 5d. UDM17 now means ID_NUMBER on every row, which is what the credit join
--     needs. LEN <> 13 should be ~0; anything else is a malformed ID in the
--     file, not a mapping problem.
SELECT COUNT(*)                                       AS ROWS_LOADED,
       COUNT_IF(LEN(UDM17) = 13)                      AS UDM17_LOOKS_LIKE_AN_ID,
       COUNT_IF(UDM17 IS NOT NULL AND LEN(UDM17) <> 13) AS UDM17_MALFORMED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE);


/* -----------------------------------------------------------------------------
   SECTION 6 — the two things worth adding later, sized

   Neither is in the view. Both are one line if you want them.
-------------------------------------------------------------------------------- */

-- 6a. Note 4: the device columns, which would give the dialler view a real
--     DEVICE_DETAILS instead of NULL. If these are well populated it is worth
--     an UDM4 (or UDM21) and a change to the dialler view.
SELECT COUNT(*)                                                  AS ROWS_TOTAL,
       COUNT_IF(DEVICE_MANUFACTURER IS NOT NULL)                 AS HAS_MANUFACTURER,
       COUNT_IF(DEVICE_MODEL IS NOT NULL)                        AS HAS_MODEL,
       COUNT_IF(PRICE_PLAN_GROUP IS NOT NULL)                    AS HAS_PLAN_GROUP,
       COUNT_IF(CONTRACT_END_DATE IS NOT NULL)                   AS HAS_END_DATE
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND;

-- 6b. Defect 11: what cte2..cte5 were reaching for. How many duplicate rows
--     carry a phone number the surviving row does NOT have. That is the number
--     of extra contact numbers currently being thrown away — and it is the
--     honest version of those four dead LEFT JOINs.
SELECT COUNT(*) AS DUPLICATES_WITH_A_NUMBER_THE_KEEPER_LACKS
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND d
  JOIN DATAWAREHOUSE.DISTRIBUTION.TM_MU2_MTNSAVESOUTBOUND k
    ON k.ACCOUNT_NO = d.ACCOUNT_NO
   AND k.ROWNUMB = 1
 WHERE d.ROWNUMB > 1
   AND d.CELL_PHONE_NO IS NOT NULL
   AND k.CELL_PHONE_NO IS NULL;
