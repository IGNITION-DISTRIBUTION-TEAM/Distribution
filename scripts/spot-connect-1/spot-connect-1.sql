/* =============================================================================
   SPOT CONNECT 1  (campaign 11381) — as an app automation
   -----------------------------------------------------------------------------
   Your script, split along the seams the app already runs on. Nothing about the
   logic changes; it is repackaged so each piece lands in a step the app can run,
   retry and report on.

     your script                         becomes                    app step
     -----------------------------------------------------------------------
     CREATE TABLE ..._DATA AS ...        SP_SPOT_CONNECT_1_BUILD    1 procedure
     INSERT INTO HLL SELECT ...          VW_SPOT_CONNECT_1_LOAD     2 load into HLL
     the six contact-number UPDATEs      SP_SPOT_CONNECT_1_CONTACTS 4 update HLL
     SP_YAXXA_RPC_CONTACT_UPDATE         unchanged                  4 update HLL
     SP_OPTINSTATUS_UPDATE               unchanged                  4 update HLL
     SP_AUTORANK                         unchanged                  4 update HLL
     SP_SYNC_TO_SQLSERVER_LARGE          unchanged                  5 sync

   THREE THINGS I CHANGED, AND WHY

   1. The sample is taken ONCE, not twice.
      Your script samples proportionally to 9,000 inside the CREATE TABLE, then
      samples the result to 9,000 again in the INSERT. The second pass is very
      nearly a no-op — it is drawing 9,000 from about 9,000 — but it means the
      target appears in two places and a resize that misses one silently gives
      you the smaller of the two. The build now samples; the load just reads.

   2. CAMPAIGNID / BATCHNAME / CREATEDONDATE / LEADEXPIRY are dropped from the
      view. The app fills all four from the automation config and strips them
      from any column mapping, so a view supplying them is four columns you have
      to remember not to map. The batch name is reproduced exactly by the
      template — see section 5.

   3. The six UPDATEs are wrapped in a procedure taking the campaign id, rather
      than hard-coding 11381 six times. Same statements, one place to change.

   ONE THING I DID NOT CHANGE, BUT YOU SHOULD LOOK AT
      The QUALIFY COUNT(*) OVER (PARTITION BY IDNUMBER) = 1 in finalselection
      DROPS every duplicated ID rather than keeping one of them. If a customer
      has two rows in the base file — two accounts, say — they are excluded
      entirely, silently. QUALIFY ROW_NUMBER() OVER (PARTITION BY IDNUMBER
      ORDER BY ...) = 1 would keep one. Section 6 counts how many that is
      before you decide.
============================================================================= */


/* -----------------------------------------------------------------------------
   STEP 1 — the build procedure

   Everything up to and including the proportional sample. Writes the same table
   your script does, so anything already reading it keeps working.

     TARGET_TOTAL  how many leads to pull   e.g. 9000
----------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_BUILD(TARGET_TOTAL NUMBER(38,0))
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n NUMBER;
BEGIN
    CREATE OR REPLACE TABLE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_DATA
    COPY GRANTS
    AS
    WITH basefile AS (
        SELECT * FROM UCONNECT_DW.ANALYTICS.VW_CVM_SPOT_ACTIVE_CUSTOMERS_REVENUE_35DAYS
    ),
    credit AS (
        SELECT IDNO, SCORE3, SCOREGROUP3
        FROM DATAWAREHOUSE.DW_XDS.CREDITRISK a
        WHERE EXISTS (SELECT * FROM basefile b WHERE b.IDNUMBER = a.IDNO)
    ),
    consumer AS (
        SELECT IDNO, FIRSTNAME, SURNAME
        FROM DATAWAREHOUSE.DW_XDS.DEMOGRAPHIC_CONSUMERDETAILS a
        WHERE EXISTS (SELECT * FROM basefile b WHERE b.IDNUMBER = a.IDNO)
          AND FIRSTNAME IS NOT NULL
    ),
    finalselection AS (
        SELECT
             IDNUMBER
            ,FIRSTNAME
            ,SURNAME
            ,MSISDN
            ,SCORE3
            ,SCOREGROUP3
            ,'INTERNAL' AS DATATYPE
            ,CONCAT('ACCOUNT_NUMBER:', ACCOUNT_NUMBER,
                    ' | APP_PURCHASES:', APP_PURCHASES,
                    ' | CELLC_RECHARGE:', CELLC_RECHARGE,
                    ' | TOTAL_REVENUE_LAST_60_DAYS:', TOTAL_REVENUE_LAST_60_DAYS) AS EXTRADATA
            ,ACCOUNT_NUMBER               AS UDM1
            ,APP_PURCHASES                AS UDM2
            ,CELLC_RECHARGE               AS UDM3
            ,TOTAL_REVENUE_LAST_60_DAYS   AS UDM4
        FROM basefile a
        LEFT JOIN credit b   ON a.IDNUMBER = b.IDNO
        LEFT JOIN consumer f ON a.IDNUMBER = f.IDNO
        WHERE f.FIRSTNAME IS NOT NULL
          -- Not already live on this campaign.
          AND NOT EXISTS (
              SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED c
              WHERE a.IDNUMBER = c.IDNUMBER
                AND c.CAMPAIGNID = 11381
                AND c.CREATEDONDATE > DATEADD(day, 45, CURRENT_DATE()::DATE))
          -- Not touched by 11346 or 11296 in the last week.
          AND NOT EXISTS (
              SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED d
              WHERE a.IDNUMBER = d.IDNUMBER
                AND d.CAMPAIGNID = 11346
                AND d.CREATEDONDATE > DATEADD(day, -7, CURRENT_DATE()::DATE))
          AND NOT EXISTS (
              SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED e
              WHERE a.IDNUMBER = e.IDNUMBER
                AND e.CAMPAIGNID = 11296
                AND e.CREATEDONDATE > DATEADD(day, -7, CURRENT_DATE()::DATE))
          -- No Spot Connect 1 telco sale in the last six months.
          AND NOT EXISTS (
              SELECT * FROM DATAWAREHOUSE.CX_PRODUCTION.VW_FACT_SS_SALES_6_MONTHS e
              JOIN DATAWAREHOUSE.DW_XDS.CREDITRISK cr ON e.CUSTOMERIDNUMBER = cr.IDNO
              WHERE a.IDNUMBER = e.CUSTOMERIDNUMBER
                AND CAMPAIGNNAME IN ('Spot Connect 1')
                AND PROVIDERTYPE = 'Telco')
        -- NOTE: drops duplicated IDs entirely rather than keeping one. Left as
        -- written; section 6 measures the cost.
        QUALIFY COUNT(*) OVER (PARTITION BY IDNUMBER) = 1
    ),
    -- The sample, taken once. Each score group keeps its share of the book, so
    -- resizing TARGET_TOTAL preserves the mix rather than reshaping it.
    numbered AS (
        SELECT
             d.*
            ,ROW_NUMBER() OVER (PARTITION BY SCOREGROUP3 ORDER BY RANDOM()) AS rn
            ,COUNT(*)     OVER (PARTITION BY SCOREGROUP3)                   AS group_count
            ,COUNT(*)     OVER ()                                           AS total_count
        FROM finalselection d
    )
    SELECT n.* EXCLUDE (rn, group_count, total_count)
    FROM numbered n
    WHERE n.rn <= ROUND(:TARGET_TOTAL * n.group_count / n.total_count);

    SELECT COUNT(*) INTO :n
      FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_DATA;

    RETURN 'target ' || :TARGET_TOTAL || ' | selected ' || :n;
END;
$$;


/* -----------------------------------------------------------------------------
   STEP 2 — the view the app loads from

   Column names match the HLL columns exactly, so "Load columns & map" matches
   all eleven by name in one click. No CAMPAIGNID / BATCHNAME / CREATEDONDATE /
   LEADEXPIRY — the app supplies those.
----------------------------------------------------------------------------- */
CREATE OR REPLACE VIEW
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_LOAD
COPY GRANTS
AS
SELECT
     IDNUMBER
    ,FIRSTNAME   AS CUSTOMERNAME
    ,SURNAME     AS LASTNAME
    ,MSISDN      AS CELLNUMBER
    ,SCORE3      AS SCORE
    ,SCOREGROUP3 AS SCOREGROUP
    ,DATATYPE
    ,EXTRADATA
    ,UDM1
    ,UDM2
    ,UDM3
    ,UDM4
FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_DATA;


/* -----------------------------------------------------------------------------
   STEP 3 — the contact-number cleanup, as one procedure

   Your six UPDATEs, in order, unchanged apart from taking the campaign id as an
   argument instead of repeating '11381' six times.
----------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_CONTACTS(CAMPAIGN_ID NUMBER(38,0))
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
BEGIN
    -- 1. RPC number seen in the last 3 months and it matches the cell we hold:
    --    keep it as the alternate...
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CONTACTNUMBER1 = h.CELLNUMBER
    FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS c
    WHERE c.IDNO = h.IDNUMBER
      AND c.RPC1_CALL_DATE > DATEADD(month, -3, CURRENT_DATE())
      AND h.CELLNUMBER = CONCAT('0', SUBSTRING(c.RPC1, 3, 10))
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    -- 2. ...and promote the RPC number itself to the primary.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CELLNUMBER = c.RPC1
    FROM DATAWAREHOUSE.DISTRIBUTION.VW_YAXXA_RPC_CONTACTNUMBERS c
    WHERE c.IDNO = h.IDNUMBER
      AND c.RPC1_CALL_DATE > DATEADD(month, -3, CURRENT_DATE())
      AND h.CELLNUMBER = CONCAT('0', SUBSTRING(c.RPC1, 3, 10))
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    -- 3. Otherwise fall back to the demographic first cell.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CONTACTNUMBER1 = CONCAT('0', SUBSTRING(c.CELL1, 4, 10))
    FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
    WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
      AND h.CELLNUMBER <> CONCAT('0', SUBSTRING(c.CELL1, 4, 10))
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL
      AND h.CONTACTNUMBER1 IS NULL;

    -- 4. Normalise anything still carrying a country code.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CELLNUMBER = CONCAT('0', SUBSTRING(h.CELLNUMBER, 3, 10))
    WHERE LENGTH(h.CELLNUMBER) > 10
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    -- 5. Never hand the dialler the same number twice.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CONTACTNUMBER1 = NULL
    WHERE h.CELLNUMBER = h.CONTACTNUMBER1
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    -- 6. A second and third alternate, each distinct from the ones before it.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CONTACTNUMBER2 = CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
    FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
    WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
      AND h.CELLNUMBER      <> CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
      AND h.CONTACTNUMBER1  <> CONCAT('0', SUBSTRING(c.CELL2, 4, 10))
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
    SET h.CONTACTNUMBER2 = CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
    FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE c
    WHERE c.IDENTIFIERNUMBER = h.IDNUMBER
      AND h.CELLNUMBER      <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
      AND h.CONTACTNUMBER1  <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
      AND h.CONTACTNUMBER2  <> CONCAT('0', SUBSTRING(c.CELL3, 4, 10))
      AND h.CAMPAIGNID = :CAMPAIGN_ID
      AND h.CREATEDONDATE = CURRENT_DATE()
      AND h.ESTATUS IS NULL;

    RETURN 'contact cleanup complete for campaign ' || :CAMPAIGN_ID;
END;
$$;

/* Worth knowing about statements 3, 6 and 7: the <> comparisons are against
   columns that can be NULL, and in SQL "x <> NULL" is unknown, not true. So a
   lead whose CONTACTNUMBER1 is still NULL is skipped by the CONTACTNUMBER2
   updates entirely. That is the same defect the OnAir builders have, where it
   makes CONTACTNUMBER3 unreachable outright. Here it only reduces how often an
   alternate is found, so it is not urgent — but if alternates look thin, this
   is why. The fix is IS DISTINCT FROM in place of <>. Left as written so this
   behaves exactly like the script you are running today. */


/* -----------------------------------------------------------------------------
   STEP 4 — grants
----------------------------------------------------------------------------- */
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_BUILD(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_CONTACTS(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON SCHEMA DATAWAREHOUSE.DISTRIBUTION_AUTOMATION TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_LOAD
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT ON TABLE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_DATA
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The three procedures the app will call at step 4, and the sync at step 5.
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_YAXXA_RPC_CONTACT_UPDATE(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE(NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(NUMBER, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE(VARCHAR, VARCHAR, VARCHAR, NUMBER)
  TO ROLE SVC_VERCEL_APP_ROLE;
-- Signatures are guesses from the call sites. If one errors, take the real one
-- from  SHOW PROCEDURES LIKE '<name>' IN ACCOUNT  and use that.


/* -----------------------------------------------------------------------------
   STEP 5 — the automation config

   Settings -> campaign 11381 -> New automation.
   Fill in this order; Upload target must be set before the column mapper.

     Name                  Spot Connect 1
     Lead source           Snowflake (stored proc / view)
     Source type           Stored procedure -> stage table
     Procedure             DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_BUILD(9000)
     Upload target         DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_LOAD
     Lead expiry           45
     Batch name            EX_{date}_SPOT_CONNECT_1_{expiry}_B1
     Load columns & map    expect "11 column(s) mapped"

     Update HLL procedures, IN THIS ORDER:
       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_CONTACTS(11381)
       DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_YAXXA_RPC_CONTACT_UPDATE(11381)
       DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_OPTINSTATUS_UPDATE(11381)
       DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_AUTORANK(11381,5)

     Sync procedure        DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SYNC_TO_SQLSERVER_LARGE
     Sync source view      DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.VW_SPOT_CONNECT_1_SS
     Sync target table     Upload.TempUpload
     Sync batch size       10000
     Sync columns          CustomerCode,CampaignId,IdNumber,CellNumber,CustomerName,LastName,Tariff,ContactNumber1,ContactNumber2,ContactNumber3,ContactNumber4,AvgSpend,HandsetType,HandsetCost,DelAdd,Email,ContractDate,AllocateUser,AllocateDate,AllocateTimeFrom,AllocateTimeTo,LeadExpiry,BatchName,ExtraData,SystemMessage,UpdatedByUserId,UpdatedOnDate,Affordability,AccountNumber,LeadSystemTypeId,BranchCode,Bank,BankAccountType,AccountFirstName,AccountLastName,LeadSourceId,SourceOrderId,HistoryLeadId,OptInStatus

   The batch name template reproduces yours exactly. {date} is today and
   {expiry} is today + the lead-expiry days above, both YYYYMMDD, so
   EX_{date}_SPOT_CONNECT_1_{expiry}_B1 gives
   EX_20260831_SPOT_CONNECT_1_20261015_B1 — the same string your CONCAT builds.

   Resizing the pull is one edit to the Procedure field: (9000) -> (12000).
----------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   STEP 6 — checks, before the first run
----------------------------------------------------------------------------- */

-- 6a. Build it by hand once and see what comes out.
CALL DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_SPOT_CONNECT_1_BUILD(9000);

-- 6b. The mix the sample preserved.
SELECT SCOREGROUP3, COUNT(*) AS N
FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_DATA
GROUP BY 1 ORDER BY 1;

-- 6c. What the QUALIFY is costing you. These are customers with more than one
-- row in the base file, dropped outright rather than deduplicated.
WITH basefile AS (
    SELECT * FROM UCONNECT_DW.ANALYTICS.VW_CVM_SPOT_ACTIVE_CUSTOMERS_REVENUE_35DAYS
)
SELECT COUNT(*) AS IDS_WITH_DUPLICATES,
       SUM(N)   AS ROWS_DROPPED
FROM (SELECT IDNUMBER, COUNT(*) AS N FROM basefile GROUP BY 1 HAVING COUNT(*) > 1);

-- 6d. The view the app will read, and its column names.
SELECT * FROM DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.VW_SPOT_CONNECT_1_LOAD LIMIT 5;

-- 6e. After the first full run — what landed, under which batch.
SELECT BATCHNAME, CREATEDONDATE, LEADEXPIRY, COUNT(*) AS LEADS,
       COUNT_IF(CONTACTNUMBER1 IS NOT NULL) AS WITH_ALT1,
       COUNT_IF(CONTACTNUMBER2 IS NOT NULL) AS WITH_ALT2
FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
WHERE CAMPAIGNID = 11381 AND CREATEDONDATE = CURRENT_DATE()
GROUP BY 1, 2, 3;
