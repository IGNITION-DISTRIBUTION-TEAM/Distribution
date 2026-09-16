-- VAS paid, telco declined — validation SQL for the Reporting → Customer
-- quality report of the same name.
--
-- Entirely READ-ONLY. Run section 1 FIRST: if the premise does not hold, every
-- number below is zero for a reason that has nothing to do with billing.
--
-- Reads the same object as the Quality mix report — whatever
-- QUALITY_MIX_SOURCE_TABLE points at, by default
-- DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE.
--
-- ┌─ THE QUESTION ──────────────────────────────────────────────────────────┐
-- │ On a first collection, was the VAS collected while the telco line was   │
-- │ declined? The customer is charged for the add-on but the service it     │
-- │ attaches to never billed.                                              │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- THE PAIR IS (CUSTOMER, PERIOD), NOT THE ACCOUNT ALONE. Two first collections
-- only describe the same event if they are the same customer AND the same
-- billing month. A VAS first billed in March against a telco first billed in
-- July is two different things, and pairing them reports a disagreement that
-- never happened.
--
-- ACCOUNTNO is the customer key available: the view omits IDNUMBER by design
-- (POPIA), so two accounts belonging to one person cannot be linked here.
--
-- DECLINED = any unpaid outcome (PAID_FLAG = 0), the same definition FID uses,
-- so these figures reconcile against Quality mix instead of being a second and
-- quieter standard. Disputes and suspensions count; section 4 breaks them out.


-- ============================================================================
-- 1. Does the premise hold? Run this before anything else.
-- ============================================================================
-- The report assumes each product bills on its OWN ROW, with VAS_BUTTON_FLAG
-- marking which side. If VAS_BUTTON_FLAG never varies within a customer and
-- period, there is nothing to compare and the report will be empty — which
-- looks identical to "no problems found".

WITH first_rows AS (
    SELECT
        ACCOUNTNO,
        TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
            TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)),
            TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)))), 'YYYY-MM') AS PERIOD,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0) AS VAS_FLAG
    FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
    WHERE COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1
      AND TRY_TO_DATE(TO_VARCHAR(SALESDATE)) >= DATEADD(MONTH, -6, CURRENT_DATE())
)
SELECT COUNT(*)                                        AS CUSTOMER_PERIODS,
       COUNT_IF(SIDES = 2)                             AS HAVE_BOTH_SIDES,
       COUNT_IF(SIDES = 1 AND HAS_VAS = 1)             AS VAS_ONLY,
       COUNT_IF(SIDES = 1 AND HAS_VAS = 0)             AS TELCO_ONLY,
       ROUND(100 * COUNT_IF(SIDES = 2) / NULLIF(COUNT(*), 0), 1) AS PCT_PAIRED
  FROM (
        SELECT ACCOUNTNO, PERIOD,
               COUNT(DISTINCT VAS_FLAG) AS SIDES,
               MAX(VAS_FLAG)            AS HAS_VAS
          FROM first_rows
         GROUP BY ACCOUNTNO, PERIOD
       );
-- HAVE_BOTH_SIDES near zero means STOP. Either the two products do not bill
-- separately, or VAS_BUTTON_FLAG is an account attribute rather than a row one,
-- and the report needs a different way to tell the sides apart.


-- ============================================================================
-- 2. The four quadrants
-- ============================================================================
-- These must sum to HAVE_BOTH_SIDES from section 1 over the same window. If
-- they do not, the pivot is dropping rows.

WITH ranked AS (
    SELECT
        ACCOUNTNO,
        TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
            TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)),
            TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)))), 'YYYY-MM') AS PERIOD,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0) AS VAS_FLAG,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0)       AS PAID,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(BILLED_AMOUNT)), 0)   AS AMOUNT,
        UNPAID_GROUP_DESCRIPTION                                AS REASON,
        -- PARTITIONED BY SIDE AS WELL AS CUSTOMER AND PERIOD. Partitioning on
        -- the account alone collapses the VAS and telco rows into whichever
        -- billed first — which is exactly what the Quality mix report does, and
        -- why its FTC/FID mixes the two. See section 5.
        ROW_NUMBER() OVER (
            PARTITION BY ACCOUNTNO,
                         TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
                             TRY_TO_DATE(TO_VARCHAR(BILLINGDATE)),
                             TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)))), 'YYYY-MM'),
                         COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0)
            ORDER BY TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)) NULLS LAST,
                     TRY_TO_DATE(TO_VARCHAR(BILLINGDATE))  NULLS LAST) AS RN
    FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
    WHERE COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1
      AND TRY_TO_DATE(TO_VARCHAR(SALESDATE)) >= DATEADD(MONTH, -6, CURRENT_DATE())
),
pairs AS (
    SELECT ACCOUNTNO, PERIOD,
           MAX(IFF(VAS_FLAG = 1, PAID, NULL))   AS VAS_PAID,
           MAX(IFF(VAS_FLAG = 0, PAID, NULL))   AS TELCO_PAID,
           MAX(IFF(VAS_FLAG = 1, AMOUNT, NULL)) AS VAS_AMOUNT,
           MAX(IFF(VAS_FLAG = 0, REASON, NULL)) AS TELCO_REASON
      FROM ranked
     WHERE RN = 1
     GROUP BY ACCOUNTNO, PERIOD
)
SELECT COUNT(*)                                                   AS PAIRS,
       COUNT_IF(VAS_PAID = 1 AND TELCO_PAID = 1)                  AS BOTH_PAID,
       COUNT_IF(VAS_PAID = 1 AND TELCO_PAID = 0)                  AS VAS_PAID_TELCO_DECLINED,
       COUNT_IF(VAS_PAID = 0 AND TELCO_PAID = 1)                  AS TELCO_PAID_VAS_DECLINED,
       COUNT_IF(VAS_PAID = 0 AND TELCO_PAID = 0)                  AS NEITHER_PAID,
       SUM(IFF(VAS_PAID = 1 AND TELCO_PAID = 0, VAS_AMOUNT, 0))   AS VAS_COLLECTED_ON_FAILED_TELCO
  FROM pairs
 WHERE VAS_PAID IS NOT NULL AND TELCO_PAID IS NOT NULL;
-- TELCO_PAID_VAS_DECLINED is the CONTROL. If it is close in size to
-- VAS_PAID_TELCO_DECLINED, this is general billing failure rather than anything
-- specific to VAS, and the headline should be read that way.


-- ============================================================================
-- 3. One customer, end to end
-- ============================================================================
-- Take an ACCOUNTNO from the report's drill-down and confirm the story: two
-- rows flagged first collection, in the same month, one VAS and one telco, with
-- different PAID_FLAGs.

SELECT ACCOUNTNO, POLICYNO, PRODUCTNAME, PRODUCT_GROUPS,
       VAS_BUTTON_FLAG, ISFIRSTCOLLECTION,
       SCHEDULEDATE, BILLINGDATE,
       PAID_FLAG, UNPAID_GROUP_DESCRIPTION, BANKRESPONSE,
       BILLED_AMOUNT, BILLED_AMOUNT_INCL_VAT
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
 WHERE ACCOUNTNO = '<PASTE AN ACCOUNTNO>'
 ORDER BY TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE));


-- ============================================================================
-- 4. Why the telco declined
-- ============================================================================
-- Reason is read off the TELCO row, since that is the side that failed. Taking
-- it from the account would return the VAS row's reason for half of them.
-- Re-run section 2's CTEs above, then:

/*
SELECT COALESCE(NULLIF(TRIM(TELCO_REASON), ''), '(none)') AS REASON,
       COUNT(*)            AS CUSTOMERS,
       SUM(VAS_AMOUNT)     AS VAS_COLLECTED
  FROM pairs
 WHERE VAS_PAID = 1 AND TELCO_PAID = 0
 GROUP BY 1
 ORDER BY CUSTOMERS DESC;
*/


-- ============================================================================
-- 5. Sizing the Quality mix defect this exposes
-- ============================================================================
-- quality-mix picks its first-collection row with PARTITION BY ACCOUNTNO alone.
-- Where a customer has both a VAS and a telco first collection, that picks
-- whichever billed first — so its FTC/FID is measured on the VAS for some
-- customers and the telco for others.
--
-- This counts how many accounts are affected and how often the two sides
-- DISAGREE, which is the size of the error. Where they agree it makes no
-- difference which was picked.

WITH ranked AS (
    SELECT ACCOUNTNO,
           COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0) AS VAS_FLAG,
           COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0)       AS PAID
      FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
     WHERE COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1
       AND TRY_TO_DATE(TO_VARCHAR(SALESDATE)) >= DATEADD(MONTH, -6, CURRENT_DATE())
)
SELECT COUNT(*)                                  AS ACCOUNTS_WITH_FIRST_COLLECTION,
       COUNT_IF(SIDES = 2)                       AS ACCOUNTS_WITH_BOTH_SIDES,
       COUNT_IF(SIDES = 2 AND OUTCOMES = 2)      AS ACCOUNTS_WHERE_SIDES_DISAGREE,
       ROUND(100 * COUNT_IF(SIDES = 2 AND OUTCOMES = 2) / NULLIF(COUNT(*), 0), 2)
                                                 AS PCT_OF_FTC_BASE_AT_RISK
  FROM (
        SELECT ACCOUNTNO,
               COUNT(DISTINCT VAS_FLAG) AS SIDES,
               COUNT(DISTINCT PAID)     AS OUTCOMES
          FROM ranked
         GROUP BY ACCOUNTNO
       );
-- PCT_OF_FTC_BASE_AT_RISK is how much of the published FTC/FID rate depends on
-- which product happened to bill first. Deciding what FTC should mean — the
-- telco only, or the account as a whole — is a business call, not a code fix.
