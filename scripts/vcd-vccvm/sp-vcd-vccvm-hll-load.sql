/* =============================================================================
   VC CVM UPGRADES (campaign 11058) — the HLL load
   -----------------------------------------------------------------------------
   Your INSERT ... SELECT as a view the app reads, so the load becomes a step it
   can run, retry and count rather than a statement someone pastes into a
   worksheet.

       upload file → DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
       SP_VCD_VCCVM_PREP(11058, 90, 6)            (sp-vcd-vccvm-prep.sql)
       VW_VCD_VCCVM_HLL_LOAD → TM_HLL_HISTORYLEADSLOADED    ← this file

   I CHECKED THE ALIGNMENT FIRST. 32 insert columns, 32 select expressions, and
   they line up all the way down. The two commented-out lines cancel each other
   — "---UDM1," in the column list against "---Subs_Id," in the select — which
   is the only reason the count works. Uncomment one without the other and every
   column from UDM2 down shifts by one, silently, because the types are
   compatible. That is worth knowing before anyone tidies those lines up.

   -----------------------------------------------------------------------------
   WHAT THE VIEW DOES NOT SUPPLY, AND WHY

   CAMPAIGNID, BATCHNAME, CREATEDONDATE and LEADEXPIRY are gone from the view.
   The app fills all four from the automation config and strips them out of any
   column mapping, so a view supplying them is four columns you have to remember
   not to map.

   The batch name is reproduced EXACTLY. Yours:

       replace(concat('EX', cast(current_date()+30 as date), 'VCCVM_',
                      cast(current_date() as date), 'B1'), '-')

   With batch template "EX{expiry}VCCVM_{date}B1" and lead expiry 30 days, the
   app generates:

       CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
              'VCCVM_', REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')

   Same string. Your outer REPLACE strips hyphens from the whole concatenation,
   but 'EX', 'VCCVM_' and 'B1' contain none, so stripping them from the two dates
   alone is the same thing. Section 5 proves it against your original.

   -----------------------------------------------------------------------------
   THE ONE THING TO DECIDE BEFORE YOU RUN THIS

   YOUR INSERT HAS NO WHERE CLAUSE. Every row in the table loads, including
   every row SP_VCD_VCCVM_PREP just labelled:

       LEAD IN DMASA                 on the opt-out list
       LEAD IN HISTORY 90 DAYS       already worked recently
       DUPLICATE LEAD                second and later rows for one ID
       CURR_CMTMNT_END_DT > ...      still in contract for six months or more

   ESTATUS travels with them into the HLL, so the reason is not lost — but the
   rows are in the table the sync pushes to the dialler. If something downstream
   filters on ESTATUS then this is fine and deliberate. If nothing does, then the
   four checks in the prep procedure are labelling leads and dialling them
   anyway, and the DMASA one is the one that matters: that is an opt-out list,
   not a quality score.

   I have NOT added a filter, because it changes your volumes and that is your
   call, not a translation decision. Section 3 counts what each label is worth
   and has the filtered view ready to paste. Run the count before you decide.

   -----------------------------------------------------------------------------
   FIVE SMALLER THINGS IN THE MAPPING

   1. FILENAME IS A FIXED STRING WITH A DATE IN IT.
        'Elite_Out_Upgrades_C0642_20260710'
      Every batch loaded from today onwards is stamped 10 July 2026. If FILENAME
      is how you trace a batch back to the file it came from, it stopped working
      the day after that file. Section 1 has a dated version commented out
      directly beneath it — one line, and the stamp follows the run.

   2. CELLNUMBER GETS MSISDN_MAH, NOT MSISDN.
      CONTACTNUMBER1 gets MSISDN, which the prep procedure's history check
      confirms is right. But CELLNUMBER — usually the dialler's primary number,
      and the key the temp-upload duplicate scan partitions on — gets the master
      account holder's number. For an upgrades campaign that may well be
      deliberate. It is worth being sure, because if MSISDN_MAH is often blank
      then CELLNUMBER is often blank. Section 5 counts.

   3. CURR_DEAL_DESC IS LOADED TWICE, into UDM4 and UDM10.
      UDM10's alias is "Curr_Deal_Desc", so UDM10 looks like the intended home
      and UDM4 looks like it was meant to hold something else that was never
      swapped in. Two columns of identical text either way.

   4. R3 HAS THREE COLUMNS WHERE R1 AND R2 HAVE TWO.
      R1 and R2 give PRICE_PLAN and SUBSCRIPTION; R3 gives PRICE_PLAN,
      PRICEPLAN_CD and SUBSCRIPTION. The count still comes out right, so nothing
      is shifted — but either R1 and R2 are missing their PRICEPLAN_CD, or R3's
      does not belong.

   5. EXTRADATA ENDS ON AN EMPTY LABEL.
        concat('MSISDN: ', …, '|Current Pkg_Desc: ', …, '|Subscription: ')
      "Subscription:" with nothing after it, on every row. Harmless, but if the
      agent screen renders EXTRADATA as-is they see an empty field.

   And UDM1 is deliberately left unfilled, since Subs_Id is commented out. Kept
   that way.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the view

   Every column is named after the HLL column it feeds, so the app's mapper
   matches them automatically and there is nothing to map by hand. The aliases
   from your select are kept as comments so the intent stays readable.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_VCD_VCCVM_HLL_LOAD
COPY GRANTS
AS
SELECT
     ID_NUM                                   AS IDNUMBER
    ,MSISDN_MAH                               AS CELLNUMBER        -- note 2
    ,MSISDN                                   AS CONTACTNUMBER1
    ,MSISDN_ALT2                              AS CONTACTNUMBER2
    ,ALTERNATENUMBER                          AS CONTACTNUMBER3    -- filled by the prep proc
    ,FIRST_NAME                               AS CUSTOMERNAME
    ,LAST_NAME                                AS LASTNAME
    ,CONCAT('MSISDN: ',            IFNULL(MSISDN, ''),
            '|Current Pkg_Desc: ', IFNULL(CURR_DEAL_DESC, ''),
            '|Subscription: ')                AS EXTRADATA         -- note 5
    ,EMAIL_ADDR                               AS EMAIL
    -- UDM1 intentionally not supplied: Subs_Id is commented out in your script.
    ,CONTRACT_STATUS                          AS UDM2              -- Contract_Status
    ,ACCT_CD                                  AS UDM3              -- Acct_Cd
    ,CURR_DEAL_DESC                           AS UDM4              -- note 3: same as UDM10
    ,''                                       AS UDM5              -- Pmt_Meth_Cd
    ,PORTFOLIO_SCORE                          AS UDM6              -- Portfolio_Score
    ,''                                       AS UDM7              -- Value_Band
    ,ARPU_INCVAT                              AS UDM8              -- ARPU_IncVAT
    ,''                                       AS UDM9              -- Curr_Deal_Cd
    ,CURR_DEAL_DESC                           AS UDM10             -- Curr_Deal_Desc
    ,''                                       AS UDM11             -- Curr_Subscription
    ,R1_PRICE_PLAN                            AS UDM12
    ,R1_SUBSCRIPTION                          AS UDM13
    ,R2_PRICE_PLAN                            AS UDM14
    ,R2_SUBSCRIPTION                          AS UDM15
    ,R3_PRICE_PLAN                            AS UDM16
    ,R3_PRICEPLAN_CD                          AS UDM17             -- note 4: no R1/R2 equivalent
    ,R3_SUBSCRIPTION                          AS UDM18
    ,ESTATUS                                  AS ESTATUS
    ,'Elite_Out_Upgrades_C0642_20260710'      AS FILENAME          -- note 1
    -- Dated instead of fixed — swap the line above for this one:
    -- ,CONCAT('Elite_Out_Upgrades_C0642_',
    --         REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''))  AS FILENAME
FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION;


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   The app reads this view directly, as itself, so SVC_VERCEL_APP_ROLE needs
   SELECT on the view AND on the table underneath it. A view does not launder
   access unless it is a secure view owned by a role that holds the base grant —
   and this one is not.

   CREATE OR REPLACE VIEW carries COPY GRANTS above, so re-running section 1
   keeps these. Run this once, as ACCOUNTADMIN.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                             TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION       TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION                  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_VCD_VCCVM_HLL_LOAD
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Already granted for the file upload; here for completeness if this is a fresh
-- environment.
GRANT SELECT, INSERT, DELETE ON TABLE
  DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The load writes into the HLL.
GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 3 — the ESTATUS decision

   Run this FIRST. It tells you what loading every row actually costs.
-------------------------------------------------------------------------------- */

SELECT IFNULL(ESTATUS, '(eligible — no label)')                        AS ESTATUS,
       COUNT(*)                                                        AS LEADS,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)                AS PCT
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
 GROUP BY 1
 ORDER BY LEADS DESC;

/* If you decide the labelled rows should not go out, this is the whole change —
   re-run section 1 with this WHERE clause on the end and nothing else differs:

       WHERE ESTATUS IS NULL

   Or, to exclude only the compliance one and keep the rest as they are:

       WHERE ESTATUS IS NULL OR ESTATUS <> 'LEAD IN DMASA'

   Note the second form still needs the IS NULL: ESTATUS <> 'LEAD IN DMASA' on
   its own is UNKNOWN for an unlabelled row and would drop every eligible lead
   in the file. That is the same NULL-comparison trap as note C in the prep
   procedure, and it would be a very quiet way to send out an empty batch. */


/* -----------------------------------------------------------------------------
   SECTION 4 — the config

   Settings → Campaign automation → the VC CVM config. These values reproduce
   your INSERT exactly.

     Campaign id            11058
     Lead source            File
     Upload target table    DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION
     Source type            Stored procedure → HLL
     Procedure              DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_PREP(11058, 90, 6)
     Load from              DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_VCD_VCCVM_HLL_LOAD
     Lead expiry (days)     30
     Batch name template    EX{expiry}VCCVM_{date}B1

   LEAD EXPIRY 30, NOT THE DEFAULT 45. It drives both LEADEXPIRY and the
   {expiry} half of the batch name, so getting it wrong changes the batch name
   as well as the expiry date — and the batch name is what the emailed file is
   called. Your script uses current_date()+30 in both places.

   Manual → step 3 then shows: Upload to stage, run procedure, map into HLL,
   each runnable on its own.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 5 — verification

   Run these after the first load, before you trust it.
-------------------------------------------------------------------------------- */

-- 5a. The batch name the app generates against the one your script generates.
--     Both columns must be identical.
SELECT
    CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
           'VCCVM_', REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')  AS APP_BATCH,
    REPLACE(CONCAT('EX', CAST(CURRENT_DATE() + 30 AS DATE), 'VCCVM_',
                   CAST(CURRENT_DATE() AS DATE), 'B1'), '-')            AS YOUR_BATCH,
    IFF(
        CONCAT('EX', REPLACE(TO_VARCHAR(DATEADD(day, 30, CURRENT_DATE)), '-', ''),
               'VCCVM_', REPLACE(TO_VARCHAR(CURRENT_DATE), '-', ''), 'B1')
        = REPLACE(CONCAT('EX', CAST(CURRENT_DATE() + 30 AS DATE), 'VCCVM_',
                         CAST(CURRENT_DATE() AS DATE), 'B1'), '-'),
        'MATCH', 'DIFFERENT')                                           AS VERDICT;

-- 5b. Note 2 — how many leads would arrive with a blank CELLNUMBER, and whether
--     MSISDN would have been populated for those same rows.
SELECT COUNT(*)                                                    AS TOTAL,
       COUNT_IF(MSISDN_MAH IS NULL OR TRIM(MSISDN_MAH) = '')       AS BLANK_CELLNUMBER,
       COUNT_IF((MSISDN_MAH IS NULL OR TRIM(MSISDN_MAH) = '')
                AND MSISDN IS NOT NULL AND TRIM(MSISDN) <> '')     AS BLANK_BUT_MSISDN_PRESENT
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_VCD_VCCVMDISTRIBUTION;

-- 5c. Every column the view exposes exists on the HLL target. Anything listed
--     here is a name the mapper cannot match and would leave unmapped.
SELECT v.COLUMN_NAME AS VIEW_COLUMN_WITH_NO_HLL_HOME
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS v
 WHERE v.TABLE_SCHEMA = 'DISTRIBUTION_AUTOMATION'
   AND v.TABLE_NAME   = 'VW_VCD_VCCVM_HLL_LOAD'
   AND NOT EXISTS (
         SELECT 1
           FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS h
          WHERE h.TABLE_SCHEMA = 'DISTRIBUTION_DATA_APPLICATION'
            AND h.TABLE_NAME   = 'TM_HLL_HISTORYLEADSLOADED'
            AND h.COLUMN_NAME  = v.COLUMN_NAME);

-- 5d. What actually landed. Row count and batch name for today's load.
SELECT BATCHNAME,
       CAMPAIGNID,
       CREATEDONDATE,
       LEADEXPIRY,
       COUNT(*)                                              AS LEADS,
       COUNT_IF(CELLNUMBER IS NULL OR TRIM(CELLNUMBER) = '') AS BLANK_CELLNUMBER,
       COUNT_IF(ESTATUS IS NOT NULL)                         AS LABELLED_LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CREATEDONDATE = CURRENT_DATE()
 GROUP BY 1, 2, 3, 4;
