/* =============================================================================
   MTN SAVE (campaign 11204) — the SilverSurfer feed
   -----------------------------------------------------------------------------
   Your view, with one fix and nothing else touched. It is the source of the
   structured sync:

       SP_MTN_SAVE_POST_LOAD() and the three shared procedures
       VW_AD_MTNSAVESOUTBOUNDSILVERSURFER               ← this file
       SP_SYNC_TO_SQLSERVER_LARGE → Upload.TempUpload

   -----------------------------------------------------------------------------
   THE FIX: replace(EXTRADATA,'') IS MISSING ITS SECOND ARGUMENT (defect 9)

   REPLACE takes three arguments — the string, what to find, what to put in its
   place. Yours has two. Snowflake's REPLACE will accept two and treat the
   second as "delete every occurrence of this", so `replace(EXTRADATA, '')`
   deletes every occurrence of the empty string, which is a no-op. It does not
   error; it just does nothing.

   What it is meant to do is strip commas, and the working extend view in this
   repo does exactly that:

       REPLACE(EXTRADATA, ',', '')

   It matters because ExtraData is the one free-text field in a 39-column
   positional CSV push. A comma surviving into it is the failure the escaping
   exists to prevent, and it does not fail loudly — it shifts every field after
   it, for that one lead, in whatever consumes the file.

   EXTRADATA is built by VW_MTN_SAVE_HLL_LOAD out of ASPU, CURR_TARIFF_NM, three
   recommendations and CONTACT_AS. The prep procedure strips commas from the
   recommendations; nothing strips them from CURR_TARIFF_NM or CONTACT_AS. So
   this is the only line standing between a tariff name with a comma in it and a
   shifted row. Section 4 counts how many leads currently carry one.

   -----------------------------------------------------------------------------
   THE 39 COLUMNS ARE POSITIONAL AND UNCHANGED

   SP_SYNC_TO_SQLSERVER_LARGE inserts by POSITION, not by name. The view's
   SELECT order, the column list in the config, and the column order of
   Upload.TempUpload must all agree item for item. Nothing in SQL complains if
   they slip; the leads simply land in the wrong fields.

   So the SELECT list below is your view's, in your order, with only the REPLACE
   corrected. I checked it against lib/silversurfer-push.ts, which holds the
   same 39-column contract for Extend Expired Leads: same names, same order.

   THREE ALIASES DELIBERATELY DISAGREE WITH THE TARGET COLUMN NAMES —
   CreatedByUserId/UpdatedByUserId, CreatedOnDate/UpdatedOnDate,
   HLL_ID/HistoryLeadId. Because the insert is positional the aliases are
   documentary only. That disagreement is in the working extend path too, and
   renaming them would be churn on a production route. Left alone.

   -----------------------------------------------------------------------------
   FOUR THINGS I DID NOT CHANGE, BUT YOU SHOULD KNOW

   A. THIS VIEW DOES NOT FILTER ON ESTATUS. The CXM dialler view does
      (`AND ESTATUS is null`); this one does not. So every lead the pipeline
      excluded — DNC, INVALID ID, DUPLICATE LEAD, Incorrect Cell Number — is
      still pushed to SilverSurfer.

      Whether that is a bug depends on what SilverSurfer is for. If it is the
      record of what was loaded, it is correct. If it feeds an agent, then DNC
      leads are reachable through it and that is a compliance problem, not a
      data-quality one. Section 3 has the one-line change and the count, so you
      can decide with a number in front of you. I have not made the change:
      it would drop rows from a production push.

   B. LeadExpiry + 5. Yours, kept. The lead lives five days longer in
      SilverSurfer than the LEADEXPIRY the HLL recorded — presumably slack for
      the hand-off. Worth knowing it exists, because the app's own Extend
      Expired Leads path writes CURRENT_DATE() + 10 and the batch-upload
      re-push writes the stored LEADEXPIRY, so there are now three different
      expiry rules in play for the same table.

   C. THE DE-DUPLICATION ORDERS BY THE COLUMN IT PARTITIONS BY.
          QUALIFY ROW_NUMBER() OVER (PARTITION BY IDNUMBER ORDER BY IDNUMBER DESC) = 1
      Every row in a group ties, so Snowflake may keep any of them. Re-run on
      unchanged data and a different one can win. The dialler view has the same
      shape but orders by SCORE DESC, which is a real preference. Making this
      one match would be one line — `ORDER BY SCORE DESC` — and section 5 says
      how many leads it would affect. Not changed, because which duplicate goes
      to SilverSurfer is a distribution decision.

   D. OptInStatus IS PUSHED AS NULL, on every row.
      SP_OPTINSTATUS_UPDATE(11204) runs two steps earlier and fills the HLL's
      OPTINSTATUS column; the CXM view reads it and translates it into text.
      This view throws it away. If SilverSurfer needs the opt-in state, the last
      column becomes `OPTINSTATUS` instead of `CAST(null AS VARCHAR(50))` and
      nothing else moves — the position is already right. Left as you wrote it,
      because a column going from always-NULL to populated can change behaviour
      on the SQL Server side and that is not mine to trigger.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the view

   COPY GRANTS, so re-running this keeps the app's SELECT.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.DISTRIBUTION.VW_AD_MTNSAVESOUTBOUNDSILVERSURFER
COPY GRANTS
AS
SELECT * FROM (
    SELECT
     CAST(null AS VARCHAR(50))                              AS CustomerCode          --  1
    ,CAMPAIGNID                                             AS CampaignId            --  2
    ,IDNUMBER                                               AS IdNumber              --  3
    -- CELLNUMBER first, falling back to CONTACTNUMBER1 when the 0-prefixed tail
    -- comes out as just '0' — i.e. when CELLNUMBER is empty.
    ,CASE WHEN CONCAT('0', RIGHT(CELLNUMBER, 9)) = '0'
          THEN CONCAT('0', RIGHT(CONTACTNUMBER1, 9))
          ELSE CONCAT('0', RIGHT(CELLNUMBER, 9)) END        AS CellNumber            --  4
    ,CUSTOMERNAME                                           AS CustomerName          --  5
    ,LASTNAME                                               AS LastName              --  6
    ,CAST(null AS VARCHAR(50))                              AS Tariff                --  7
    ,DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER1) AS ContactNumber1 --  8
    ,DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER2) AS ContactNumber2 --  9
    ,DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX(CONTACTNUMBER3) AS ContactNumber3 -- 10
    ,CAST(null AS VARCHAR(50))                              AS ContactNumber4        -- 11
    ,CAST(null AS VARCHAR(50))                              AS AvgSpend              -- 12
    ,CAST(null AS VARCHAR(50))                              AS HandsetType           -- 13
    ,CAST(null AS VARCHAR(50))                              AS HandsetCost           -- 14
    ,CAST(null AS VARCHAR(50))                              AS DelAdd                -- 15
    ,EMAIL                                                  AS Email                 -- 16
    ,CAST(null AS VARCHAR(50))                              AS ContractDate          -- 17
    ,CAST(null AS VARCHAR(50))                              AS AllocateUser          -- 18
    ,CAST(null AS VARCHAR(50))                              AS AllocateDate          -- 19
    ,CAST(null AS VARCHAR(50))                              AS AllocateTimeFrom      -- 20
    ,CAST(null AS VARCHAR(50))                              AS AllocateTimeTo        -- 21
    ,LEADEXPIRY + 5                                         AS LeadExpiry            -- 22  note B
    ,BATCHNAME                                              AS BatchName             -- 23
    -- THE FIX. Was replace(EXTRADATA,''), which deletes the empty string and so
    -- does nothing at all. Strips commas, as the extend view does.
    ,REPLACE(EXTRADATA, ',', '')                            AS ExtraData             -- 24
    ,CAST(null AS VARCHAR(50))                              AS SystemMessage         -- 25
    ,CAST(null AS VARCHAR(50))                              AS CreatedByUserId       -- 26  → UpdatedByUserId
    ,CURRENT_DATE()                                         AS CreatedOnDate         -- 27  → UpdatedOnDate
    ,CAST(null AS VARCHAR(50))                              AS Affordability         -- 28
    ,ACCOUNTNUMBER                                          AS AccountNumber         -- 29
    ,2                                                      AS LeadSystemTypeId      -- 30
    ,BRANCHCODE                                             AS BranchCode            -- 31
    ,BANK                                                   AS Bank                  -- 32
    ,BANKACCOUNTTYPE                                        AS BankAccountType       -- 33
    ,CAST(null AS VARCHAR(50))                              AS AccountFirstName      -- 34
    ,CAST(null AS VARCHAR(50))                              AS AccountLastName       -- 35
    ,CAST(null AS VARCHAR(50))                              AS LeadSourceId          -- 36
    ,SOURCEORDERID                                          AS SourceOrderId         -- 37
    ,HLL_ID                                                                          -- 38  → HistoryLeadId
    ,CAST(null AS VARCHAR(50))                              AS OptInStatus           -- 39  note D
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
    WHERE CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
      AND CAMPAIGNID IN (11204)
      -- note A: no ESTATUS filter. See section 3.
)
WHERE CELLNUMBER IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY IDNUMBER ORDER BY IDNUMBER DESC) = 1;   -- note C

/* THE OUTER `WHERE CELLNUMBER IS NOT NULL` READS THE INNER COLUMN, NOT THE
   ALIAS. The inner SELECT aliases the case expression as CellNumber, so the
   outer filter resolves against the underlying CELLNUMBER — which is why a
   lead with a blank CELLNUMBER but a usable CONTACTNUMBER1 is dropped here even
   though the case expression was written to rescue it. Yours, unchanged: it
   only ever removes leads, never adds any, and changing it would grow the push.
   Section 5 counts how many that is. */


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   All in 00-grants.sql section 7 — SELECT on this view, and USAGE on
   SF_PHONE_NUMBER_FIX. A missing function grant fails as "Unknown user-defined
   function", which reads exactly like a missing view and sends you looking in
   the wrong place.

   COPY GRANTS above, so re-running section 1 keeps them.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 3 — note A: the excluded leads that are pushed anyway

   Run this BEFORE the first sync. The first number is what you are sending.
-------------------------------------------------------------------------------- */

SELECT IFNULL(ESTATUS, '(eligible)')                         AS ESTATUS,
       COUNT(*)                                              AS LEADS_IN_THE_PUSH
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE)
   AND CELLNUMBER IS NOT NULL
 GROUP BY 1
 ORDER BY LEADS_IN_THE_PUSH DESC;

/* If the DNC row in that result is not zero, DNC leads are being pushed to
   SilverSurfer. Add this to the inner WHERE and re-run section 1:

       AND ESTATUS IS NULL

   or, to stop only the compliance one and keep the rest of the record:

       AND (ESTATUS IS NULL OR ESTATUS <> 'DNC')

   The IS NULL half of that second form is not optional. `ESTATUS <> 'DNC'` on
   its own is UNKNOWN for an unlabelled row, so it would drop every ELIGIBLE
   lead and push only the excluded ones — the exact inverse of the intent, with
   no error. */


/* -----------------------------------------------------------------------------
   SECTION 4 — the fix, sized

   How many leads currently carry a comma in EXTRADATA. Every one of them is a
   row whose fields shift after ExtraData in whatever reads Upload.TempUpload —
   and under `replace(EXTRADATA,'')` every one of them went through.

   Run it after the load. Zero means the defect never bit; it does not mean the
   fix is unnecessary, because one comma in one tariff name next month would.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                  AS LEADS_TODAY,
       COUNT_IF(EXTRADATA ILIKE '%,%')           AS EXTRADATA_WITH_A_COMMA,
       MAX(LENGTH(EXTRADATA))                    AS LONGEST_EXTRADATA
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE);

-- And where the commas come from, so they can be stopped at source if it is
-- always the same field. The recommendations are already stripped by the prep
-- procedure; these two are not.
SELECT COUNT_IF(UDM2 ILIKE '%,%')  AS CURR_TARIFF_NM_WITH_COMMA,
       COUNT_IF(UDM9 ILIKE '%,%')  AS CONTACT_AS_WITH_COMMA,
       COUNT_IF(UDM1 ILIKE '%,%')  AS ASPU_WITH_COMMA
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE);


/* -----------------------------------------------------------------------------
   SECTION 5 — notes C and the outer WHERE, sized

   DROPPED_BY_DEDUPE is how many leads the arbitrary QUALIFY discards.
   RESCUABLE is how many are dropped for a blank CELLNUMBER despite having a
   usable CONTACTNUMBER1 — the leads the CellNumber case expression was written
   to save and the outer WHERE removes anyway.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                                     AS LEADS_TODAY,
       COUNT(*) - COUNT(DISTINCT IDNUMBER)                          AS DROPPED_BY_DEDUPE,
       COUNT_IF(CELLNUMBER IS NULL AND CONTACTNUMBER1 IS NOT NULL)  AS RESCUABLE
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11204
   AND CAST(CREATEDONDATE AS DATE) = CAST(CURRENT_DATE() AS DATE);


/* -----------------------------------------------------------------------------
   SECTION 6 — the sync, and the one question still open about it

   The config in sp-mtn-save-hll-load.sql section 4 reproduces your CALL
   exactly: this view, Upload.TempUpload, the same 39 names in the same order,
   batch size 10000. Run it as Manual → step 5.

   IT IS FIRE AND FORGET. The app submits the statement asynchronously and
   records a handle, because the push can take hours; the step reports
   "submitted", not "finished". TSK_DISTRIBUTION_SYNC_RUNS is what says it
   finished.

   STILL UNANSWERED, AND IT MATTERS HERE: whether Upload.TempUpload
   DE-DUPLICATES. If it does not, running the sync twice on one load pushes the
   same batch twice, and there is nothing on this side to stop it. Before you
   re-run a sync that may already have succeeded, check the SQL Server side —
   or check the row count for the batch name first. Every other campaign in this
   repo has the same exposure; MTN Save is just the one where you are most
   likely to re-run after a partial failure.

   `execute task DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_WEEKLY_UCONNECT_TRIPLESAVE`
   from the end of your runbook is NOT part of this pipeline and is not in this
   folder. It is a different campaign's weekly task that happens to live at the
   bottom of the same worksheet. Run it, or do not, independently of MTN Save.
-------------------------------------------------------------------------------- */
