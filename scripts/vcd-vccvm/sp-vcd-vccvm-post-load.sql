/* =============================================================================
   VC CVM UPGRADES — post-load HLL cleanup
   -----------------------------------------------------------------------------
   Your nine statements as one procedure, in the same order and with the same
   effect, plus a row count per statement in the return value.

   THIS IS AN UPDATE-HLL PROCEDURE, unlike SP_VCD_VCCVM_PREP. It works on rows
   already in TM_HLL_HISTORYLEADSLOADED, so it runs after the load:

       upload → TM_VCD_VCCVMDISTRIBUTION
       SP_VCD_VCCVM_PREP(11058, 90, 6)                    source procedure
       VW_VCD_VCCVM_HLL_LOAD → HLL                        load into HLL
       SP_VCD_VCCVM_POST_LOAD()                           ← this, update-HLL

   Settings → Campaign automation → Update-HLL procedures:
       DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_POST_LOAD

   NO PARAMETERS, DELIBERATELY. Three things in here are per-campaign strings —
   the DNC cluster 'CL3', and the campaign names 'VC CVM Upgrades' and 'VC CVM'
   — and the app's config field accepts only letters, digits, commas and spaces
   between the brackets, so a string argument cannot be typed into Settings at
   all. Parameters that can only ever be passed from a worksheet would make this
   look reusable while being unusable from the app. Section 2 marks the four
   places to edit when cloning it for another campaign, and section 6 has the
   alternative if that copy-and-edit gets old.

   -----------------------------------------------------------------------------
   WHAT I CHANGED

   Nothing about the logic. Only:
     · getdate() → CURRENT_DATE, and campaignid = '11058' → 11058, so the same
       comparison is not written three ways across nine statements.
     · CAST(CREATEDONDATE AS DATE) everywhere, which statement 6 already did and
       the others did not. Identical while CREATEDONDATE is a DATE — which it
       is, the app writes CURRENT_DATE — and correct if it ever becomes a
       timestamp, where a bare = would silently match nothing.
     · Row counts returned per statement.

   -----------------------------------------------------------------------------
   FIVE DEFECTS. THE FIRST TWO CHANGE WHO GETS CALLED.

   1. EVERY LEAD WITH A BLANK UDM4 IS CLASSIFIED AS DATA.
      The Voice test is eleven NOT LIKEs against UDM4. When UDM4 is NULL each
      one is UNKNOWN, not TRUE, so the row is not set to 'Voice' — and the very
      next statement sets everything still NULL to 'Data'. A missing package
      description therefore does not read as "unknown", it reads as "Data", and
      the agent gets a data pitch for a lead nobody has classified.

      UDM4 is CURR_DEAL_DESC off the VC CVM view, which is exactly the field
      SP_VCD_VCCVM_PREP found unreliable enough to need a length check on the
      commitment date next to it. Section 3a counts it.

      One line fixes it, and it is a real decision rather than a typo — 'Data'
      as the catch-all may be what you want commercially:

          AND UDM4 IS NOT NULL          -- added to the Voice statement
          -- then a third statement for the remainder:
          --   SET UDM29 = 'Unknown' WHERE UDM29 IS NULL AND UDM4 IS NULL

   2. LIKE IS CASE-SENSITIVE IN SNOWFLAKE, SO THE PATTERNS MISS.
      '%GB%' does not match "5 Gb Data". '%Gig%' does not match "Mygig" — which
      is presumably why '%Mygig%' is in the list separately, patching one case
      variant by hand while the rest go unpatched. Any data deal whose
      description is not capitalised the way these eleven patterns expect is
      classified VOICE.

      ILIKE is the case-insensitive form and the fix is mechanical — eleven
      NOT LIKE become NOT ILIKE, and '%Mygig%' becomes redundant. I have not
      done it, because it moves leads from Voice to Data and that changes what
      agents pitch. Section 3b counts exactly how many before you decide.

   3. THE SECOND DNC LIST IS ALMOST ENTIRELY IGNORED.
          AND LEN(PHONENUMBER) = 9
      on TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC keeps only nine-character numbers and
      drops every one stored with its leading zero. The select already takes
      RIGHT(PHONENUMBER, 9), so the length filter buys nothing and costs every
      10-digit entry on that list. If those are the majority, that DNC list is
      barely being applied — and this is the check that keeps you off the phone
      to people who asked not to be called. LEN(PHONENUMBER) >= 9 is almost
      certainly what was meant. Section 3c shows the split before you change it.

   4. NUMBER ENRICHMENT STOPS DEAD IF CONTACTNUMBER1 STAYS EMPTY.
      Statement 8 requires cell2 <> CONTACTNUMBER1 and statement 9 requires
      cell3 <> CONTACTNUMBER1 as well. When CONTACTNUMBER1 is NULL those
      comparisons are UNKNOWN, so neither fires — and CONTACTNUMBER1 is NULL
      precisely when statement 7 could not fill it. One missing cell1 therefore
      costs you cell2 and cell3 too.

      It compounds with the load: CELLNUMBER on this campaign comes from
      MSISDN_MAH, and every enrichment statement also tests cell? <> CELLNUMBER.
      A lead with a blank MSISDN_MAH gets no alternate numbers at all, from any
      of the three. Section 3d counts them. COALESCE(x, '') on each comparison
      is the fix, in six places.

   5. WHICH CREDIT SCORE YOU GET IS ARBITRARY IF CREDITRISK HAS DUPLICATES.
      An UPDATE ... FROM that matches several source rows takes one of them, and
      Snowflake does not say which. Section 3e checks whether IDNO repeats.

   -----------------------------------------------------------------------------
   ONE THING THAT IS NOT A DEFECT BUT IS WORTH KNOWING

   THIS TOUCHES FOUR CAMPAIGNS, NOT ONE. Statements 1, 2, and 6 through 9 are
   scoped to 11091, 11058, 11100 and 11038. Run from the VC CVM automation, it
   edits today's leads on three other campaigns as well. That is what your
   script does and I have kept it, but it means the VC CVM run owns the number
   enrichment and the score refresh for all four — and if another campaign's
   automation runs its own copy, whichever goes first wins the score, because
   statement 6 only fills rows where ESTATUS IS NULL.

   To scope it to VC CVM alone, replace CAMPAIGNS in each of those statements
   with 11058. Section 4 counts what the other three contribute.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the procedure
-------------------------------------------------------------------------------- */

CREATE OR REPLACE PROCEDURE
    DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_POST_LOAD()
RETURNS VARCHAR(16777216)
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    n_na          NUMBER DEFAULT 0;
    n_dupnum      NUMBER DEFAULT 0;
    n_voice       NUMBER DEFAULT 0;
    n_data        NUMBER DEFAULT 0;
    n_dnc         NUMBER DEFAULT 0;
    n_score       NUMBER DEFAULT 0;
    n_cell1       NUMBER DEFAULT 0;
    n_cell2       NUMBER DEFAULT 0;
    n_cell3       NUMBER DEFAULT 0;
    msg           VARCHAR DEFAULT '';
BEGIN

    -- ------------------------------------------------ tidy CONTACTNUMBER2
    -- 'N/A' is not a phone number.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED c
       SET c.CONTACTNUMBER2 = NULL
     WHERE c.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND CAST(c.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND c.CONTACTNUMBER2 = 'N/A';
    n_na := SQLROWCOUNT;

    -- A second copy of the primary number is not a second number.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED c
       SET c.CONTACTNUMBER2 = NULL
     WHERE c.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND CAST(c.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND c.CELLNUMBER = c.CONTACTNUMBER2;
    n_dupnum := SQLROWCOUNT;

    -- ------------------------------------------------- voice vs data deals
    -- Defect 1 and 2 both live in this statement: a NULL UDM4 falls through to
    -- 'Data' below, and LIKE is case-sensitive so mis-capitalised data deals
    -- are labelled Voice. Left exactly as written.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
       SET UDM29 = 'Voice'
     WHERE CAMPAIGNID = 11058
       AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND UDM4 NOT LIKE '%MB%'
       AND UDM4 NOT LIKE '%GB%'
       AND UDM4 NOT LIKE '%Meg%'
       AND UDM4 NOT LIKE '%Gib%'
       AND UDM4 NOT LIKE '%Gig%'
       AND UDM4 NOT LIKE '%Mygig%'
       AND UDM4 NOT LIKE '%BES%'
       AND UDM4 NOT LIKE '%BIS%'
       AND UDM4 NOT LIKE '%Data Messenger%'
       AND UDM4 NOT LIKE '%Business%'
       AND UDM4 NOT LIKE '%Corporate%';
    n_voice := SQLROWCOUNT;

    -- Everything not Voice is Data — including everything with no UDM4 at all.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
       SET UDM29 = 'Data'
     WHERE CAMPAIGNID = 11058
       AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND UDM29 IS NULL;
    n_data := SQLROWCOUNT;

    -- ------------------------------------------------------------- DNC check
    -- Runs before the score refresh, which skips labelled rows — so a DNC lead
    -- deliberately gets no score.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
       SET ESTATUS = 'DNC'
     WHERE CAMPAIGNID = 11058
       AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND RIGHT(CELLNUMBER, 9) IN (
               SELECT RIGHT(PHONENUMBER, 9)
                 FROM DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC
                WHERE CLUSTER = 'CL3'
                  AND CAMPAIGN IN ('GLOBAL', 'VC CVM Upgrades')
               UNION ALL
               -- Defect 3: LEN(PHONENUMBER) = 9 drops every entry stored with a
               -- leading zero, and RIGHT(...) makes the filter pointless anyway.
               SELECT DISTINCT RIGHT(PHONENUMBER, 9)
                 FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
                WHERE CAMPAIGN_NAME = 'VC CVM'
                  AND LEN(PHONENUMBER) = 9
           );
    n_dnc := SQLROWCOUNT;

    -- ------------------------------------------------- score and score group
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
       SET a.SCORE = s.SCORE3,
           a.SCOREGROUP = s.SCOREGROUP3
      FROM DATAWAREHOUSE.DW_XDS.CREDITRISK s
     WHERE CAST(a.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND a.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND a.ESTATUS IS NULL
       AND a.IDNUMBER = s.IDNO;
    n_score := SQLROWCOUNT;

    -- ---------------------------------------------------- number enrichment
    -- Defect 4: each statement depends on the previous one having succeeded,
    -- because a NULL on the right of <> makes the whole predicate UNKNOWN.
    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
       SET a.CONTACTNUMBER1 = b.CELL1
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.IDNUMBER = b.IDENTIFIERNUMBER
       AND a.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND CAST(a.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND b.CELL1 <> a.CELLNUMBER
       AND a.CONTACTNUMBER1 IS NULL
       AND LEN(b.CELL1) >= 9;
    n_cell1 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
       SET a.CONTACTNUMBER2 = b.CELL2
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.IDNUMBER = b.IDENTIFIERNUMBER
       AND a.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND CAST(a.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND b.CELL2 <> a.CELLNUMBER
       AND b.CELL2 <> a.CONTACTNUMBER1
       AND a.CONTACTNUMBER2 IS NULL
       AND LEN(b.CELL2) >= 9;
    n_cell2 := SQLROWCOUNT;

    UPDATE DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED a
       SET a.CONTACTNUMBER3 = b.CELL3
      FROM DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE b
     WHERE a.IDNUMBER = b.IDENTIFIERNUMBER
       AND a.CAMPAIGNID IN (11091, 11058, 11100, 11038)
       AND CAST(a.CREATEDONDATE AS DATE) = CURRENT_DATE()
       AND b.CELL3 <> a.CELLNUMBER
       AND b.CELL3 <> a.CONTACTNUMBER1
       AND b.CELL3 <> a.CONTACTNUMBER2
       AND a.CONTACTNUMBER3 IS NULL
       AND LEN(b.CELL3) >= 9;
    n_cell3 := SQLROWCOUNT;

    -- ------------------------------------------------------------------ summary
    msg := 'VC CVM post-load done — '
        || 'contactnumber2 N/A cleared ' || n_na
        || ' | duplicate of cell cleared ' || n_dupnum
        || ' | voice '        || n_voice
        || ' | data '         || n_data
        || ' | DNC '          || n_dnc
        || ' | score '        || n_score
        || ' | cell1/2/3 enriched ' || n_cell1 || '/' || n_cell2 || '/' || n_cell3;

    RETURN msg;

END;
$$;


/* -----------------------------------------------------------------------------
   SECTION 2 — grants, and what to edit when cloning this

   CREATE OR REPLACE PROCEDURE drops its grants and has no COPY GRANTS clause,
   so re-run this every time you replace the procedure above. You have already
   been caught by that once on SP_VCD_VCCVM_PREP.
-------------------------------------------------------------------------------- */

GRANT USAGE ON PROCEDURE
  DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SP_VCD_VCCVM_POST_LOAD()
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The owner role needs SELECT on the three objects it reads, beyond the HLL
-- table it updates:
--   DATAWAREHOUSE.DISTRIBUTION.VW_CXM_CLUSTER_1_3_CAMPAIGN_DNC
--   DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
--   DATAWAREHOUSE.DW_XDS.CREDITRISK
--   DATAWAREHOUSE.DW_XDS.VW_DEMOGRAPHIC_TELEPHONE

/* TO CLONE FOR ANOTHER CAMPAIGN, four edits and a new name:
     1. CAMPAIGNID = 11058           in the Voice, Data and DNC statements
     2. CLUSTER = 'CL3'              the CXM DNC cluster
     3. CAMPAIGN IN ('GLOBAL', 'VC CVM Upgrades')   the CXM campaign names
     4. CAMPAIGN_NAME = 'VC CVM'     the CCS campaign name
   The four-campaign list in the other statements is shared and stays as is —
   see "this touches four campaigns" in the header before you decide. */


/* -----------------------------------------------------------------------------
   SECTION 3 — size each defect before changing anything

   Run these against today's loaded rows, after the load and before or after
   this procedure as noted.
-------------------------------------------------------------------------------- */

-- 3a. Defect 1 — leads with no UDM4, which become 'Data' by default.
SELECT COUNT(*)                                           AS LEADS_TODAY,
       COUNT_IF(UDM4 IS NULL OR TRIM(UDM4) = '')          AS NO_PACKAGE_DESC,
       ROUND(100 * COUNT_IF(UDM4 IS NULL OR TRIM(UDM4) = '') / NULLIF(COUNT(*), 0), 1)
                                                          AS PCT
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE();

-- 3b. Defect 2 — how many leads LIKE calls Voice that ILIKE would call Data.
--     This is the exact size of the case-sensitivity bug.
WITH t AS (
  SELECT UDM4
    FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
   WHERE CAMPAIGNID = 11058
     AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
     AND UDM4 IS NOT NULL
)
SELECT COUNT(*) AS WOULD_MOVE_VOICE_TO_DATA
  FROM t
 WHERE     (UDM4 NOT LIKE '%MB%' AND UDM4 NOT LIKE '%GB%' AND UDM4 NOT LIKE '%Meg%'
        AND UDM4 NOT LIKE '%Gib%' AND UDM4 NOT LIKE '%Gig%' AND UDM4 NOT LIKE '%Mygig%'
        AND UDM4 NOT LIKE '%BES%' AND UDM4 NOT LIKE '%BIS%'
        AND UDM4 NOT LIKE '%Data Messenger%' AND UDM4 NOT LIKE '%Business%'
        AND UDM4 NOT LIKE '%Corporate%')
   AND NOT (UDM4 NOT ILIKE '%MB%' AND UDM4 NOT ILIKE '%GB%' AND UDM4 NOT ILIKE '%Meg%'
        AND UDM4 NOT ILIKE '%Gib%' AND UDM4 NOT ILIKE '%Gig%'
        AND UDM4 NOT ILIKE '%BES%' AND UDM4 NOT ILIKE '%BIS%'
        AND UDM4 NOT ILIKE '%Data Messenger%' AND UDM4 NOT ILIKE '%Business%'
        AND UDM4 NOT ILIKE '%Corporate%');

-- And the descriptions themselves, to judge the patterns against real data.
SELECT UDM4, COUNT(*) AS LEADS
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
 GROUP BY 1
 ORDER BY LEADS DESC
 LIMIT 60;

-- 3c. Defect 3 — how much of the CCS DNC list the length filter discards.
SELECT COUNT(*)                          AS ROWS_FOR_THIS_CAMPAIGN,
       COUNT_IF(LEN(PHONENUMBER) = 9)    AS KEPT_BY_CURRENT_FILTER,
       COUNT_IF(LEN(PHONENUMBER) <> 9)   AS DISCARDED,
       COUNT_IF(LEN(PHONENUMBER) >= 9)   AS KEPT_BY_PROPOSED_FILTER
  FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
 WHERE CAMPAIGN_NAME = 'VC CVM';

-- The number that matters: extra leads that would be marked DNC if the filter
-- were >= 9. Every one of these is currently being called.
SELECT COUNT(*) AS LEADS_MISSED_BY_THE_LENGTH_FILTER
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED h
 WHERE h.CAMPAIGNID = 11058
   AND CAST(h.CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND h.ESTATUS IS DISTINCT FROM 'DNC'
   AND RIGHT(h.CELLNUMBER, 9) IN (
         SELECT RIGHT(PHONENUMBER, 9)
           FROM DATAWAREHOUSE.DISTRIBUTION.TM_CCS_CLUSTER_1_9_CAMPAIGN_DNC
          WHERE CAMPAIGN_NAME = 'VC CVM'
            AND LEN(PHONENUMBER) <> 9);

-- 3d. Defect 4 — leads that can never be enriched because CELLNUMBER or
--     CONTACTNUMBER1 is NULL, so every <> against it is UNKNOWN.
SELECT COUNT(*)                                                   AS LEADS_TODAY,
       COUNT_IF(CELLNUMBER IS NULL OR TRIM(CELLNUMBER) = '')      AS BLANK_CELLNUMBER,
       COUNT_IF(CONTACTNUMBER1 IS NULL)                           AS BLANK_CONTACT1,
       COUNT_IF(CONTACTNUMBER1 IS NULL AND CONTACTNUMBER2 IS NULL
                AND CONTACTNUMBER3 IS NULL)                       AS NO_ALTERNATES_AT_ALL
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID IN (11091, 11058, 11100, 11038)
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE();

-- 3e. Defect 5 — does CREDITRISK hold more than one row per ID?
SELECT COUNT(*) AS IDS_WITH_SEVERAL_ROWS, MAX(c) AS MAX_ROWS_PER_ID
  FROM (SELECT IDNO, COUNT(*) AS c
          FROM DATAWAREHOUSE.DW_XDS.CREDITRISK
         GROUP BY IDNO
        HAVING COUNT(*) > 1);


/* -----------------------------------------------------------------------------
   SECTION 4 — what the other three campaigns contribute

   If these are all zero, the four-campaign scope costs nothing today and the
   question is moot. If they are not, the VC CVM run is editing other
   campaigns' leads.
-------------------------------------------------------------------------------- */

SELECT CAMPAIGNID, COUNT(*) AS LEADS_TODAY
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID IN (11091, 11058, 11100, 11038)
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
 GROUP BY CAMPAIGNID
 ORDER BY CAMPAIGNID;


/* -----------------------------------------------------------------------------
   SECTION 5 — confirm the run did what the return value says
-------------------------------------------------------------------------------- */

SELECT UDM29                                        AS VOICE_OR_DATA,
       COUNT(*)                                     AS LEADS,
       COUNT_IF(ESTATUS = 'DNC')                    AS DNC,
       COUNT_IF(SCORE IS NOT NULL)                  AS HAS_SCORE,
       COUNT_IF(CONTACTNUMBER1 IS NOT NULL)         AS HAS_CONTACT1,
       COUNT_IF(CONTACTNUMBER2 IS NOT NULL)         AS HAS_CONTACT2,
       COUNT_IF(CONTACTNUMBER3 IS NOT NULL)         AS HAS_CONTACT3
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
 GROUP BY UDM29
 ORDER BY LEADS DESC;

-- UDM29 should have no NULLs left after this runs. Any that remain mean the
-- Data catch-all did not fire and something is wrong with the ordering.
SELECT COUNT(*) AS UNCLASSIFIED
  FROM DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED
 WHERE CAMPAIGNID = 11058
   AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
   AND UDM29 IS NULL;


/* -----------------------------------------------------------------------------
   SECTION 6 — if editing SQL per campaign gets old

   The four things section 2 asks you to edit are data, not logic. They belong
   in a small driver table:

     CREATE TABLE DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.TM_HLL_POST_LOAD_RULES (
       CAMPAIGNID        NUMBER,
       DNC_CLUSTER       VARCHAR,   -- 'CL3'
       CXM_CAMPAIGNS     VARCHAR,   -- 'GLOBAL,VC CVM Upgrades'
       CCS_CAMPAIGN_NAME VARCHAR,   -- 'VC CVM'
       CLASSIFY_DEALS    BOOLEAN    -- run the Voice/Data split
     );

   One procedure then joins to it and every campaign is a row rather than a
   copy of this file — which also means a fix to any of the five defects lands
   everywhere at once instead of in whichever copies someone remembers. Worth
   doing at the third campaign, not the second. Say the word.
-------------------------------------------------------------------------------- */
