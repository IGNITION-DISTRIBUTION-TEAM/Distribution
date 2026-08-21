-- Customer quality mix (FTC / FID) — source view, extract, and validation.
--
-- The Reporting department's quality mix report reads ONE object, named by the
-- QUALITY_MIX_SOURCE_TABLE env var. This script builds that object as a lean
-- view over the billing/collections table, grants it to the app role, and gives
-- you a 6-month extract query plus checks to validate the numbers in Snowflake
-- independently of the app.
--
-- ┌─ BEFORE RUNNING ────────────────────────────────────────────────────────┐
-- │ Replace <SOURCE_DB>.<SOURCE_SCHEMA>.<SOURCE_OBJECT> everywhere below    │
-- │ with the table/view the billing extract came from (the one whose        │
-- │ columns include ACCOUNTNO, ISFIRSTCOLLECTION, PAID_FLAG, SCORE).        │
-- │ Also replace SVC_VERCEL_APP_ROLE if the app connects as another role    │
-- │ (SNOWFLAKE_ROLE env var).                                              │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- Grain of the source: ONE ROW PER COLLECTION ATTEMPT, many rows per account.
--
-- Definitions (confirmed by the business):
--   FTC = the first collection was paid in full
--   FID = the exact inverse of FTC
-- So on the matured base they are complementary; disputes and suspensions count
-- as defaults.
--
-- Deliberate choices, each from checking the sample extract:
--   * Score bands are derived from the raw SCORE in 50-point buckets, NOT from
--     SCOREGROUP. SCOREGROUP holds percentile labels ("662 to 672",
--     "887 to 907") that cross the round boundaries the business talks in —
--     887 to 907 straddles 900 — so "650-699" cannot be built from it.
--   * The first collection is the EARLIEST ISFIRSTCOLLECTION row per account,
--     not the flag alone: the sample had an account with two rows flagged.
--   * Outcome comes from PAID_FLAG / UNPAID_GROUP_DESCRIPTION, not BANKRESPONSE,
--     which is inconsistently coded ('SUCCESSFUL', '000 - SUCCESSFUL',
--     '00 - ACCP' all mean paid, across 12 variants in 100 rows).
--   * PRODUCTPRICE is NOT the amount due — billed amounts legitimately differ
--     from it (pro-rata, plan changes, discounts). Use BILLED_AMOUNT_INCL_VAT
--     for money.
--
-- POPIA: the view deliberately omits ACCOUNTNAME, FIRSTNAME, LASTNAME and
-- IDNUMBER. ACCOUNTNO is a system key and is enough to join on. Do not add
-- personal fields — the report never needs them.


-- ============================================================================
-- 1. The view the app reads
-- ============================================================================
-- Column names match the source exactly so the app needs no mapping. Keep them
-- as-is if you edit this.

CREATE OR REPLACE VIEW DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE AS
SELECT
    -- keys / grain
    ACCOUNTNO,
    POLICYNO,

    -- sale attributes (constant across an account's billing rows)
    SALESDATE,
    SCORE,
    SCOREGROUP,                 -- kept for reference; the report does not band on it
    PRODUCT_GROUPS,
    PRODUCTNAME,
    PRODUCTPRICE,
    BRAND,
    CAMPAIGNNAME,
    CHANNEL,
    VAS_BUTTON_FLAG,

    -- collection attempt
    ISFIRSTCOLLECTION,
    FIRSTBILLED,
    SCHEDULEDATE,
    BILLINGDATE,
    PAID_FLAG,
    UNPAID_FLAG,
    UNPAID_GROUP_DESCRIPTION,
    BANKRESPONSE,               -- kept for drill-down only
    TOTALFAILCOUNT,

    -- money: use these, not PRODUCTPRICE
    BILLED_AMOUNT,
    BILLED_AMOUNT_INCL_VAT,

    -- likely predictive features for the rolling score view
    BANKNAME,
    PREFERREDDEBITDAY,
    BILLINGDAY,
    POLICYSTATUS
FROM <SOURCE_DB>.<SOURCE_SCHEMA>.<SOURCE_OBJECT>;

GRANT USAGE  ON DATABASE DATAWAREHOUSE                          TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE  ON SCHEMA   DATAWAREHOUSE.LEADS_DISTRIBUTION       TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Then set, and redeploy:
--   QUALITY_MIX_SOURCE_TABLE=DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE


-- ============================================================================
-- 2. Six-month extract (run + export to CSV if you want the file rather than
--    pointing the app at the view)
-- ============================================================================
-- Filters on SALE date, so a cohort is defined by when it was written. Note this
-- returns every collection attempt for those sales, including attempts that
-- fall after the window — that is intentional: a cohort's outcome is only
-- visible in later billing rows.

SELECT *
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
WHERE TRY_TO_DATE(TO_VARCHAR(SALESDATE)) >= DATEADD(MONTH, -6, CURRENT_DATE())
ORDER BY ACCOUNTNO, TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE));


-- ============================================================================
-- 3. Validation — FTC / FID by score band, straight in SQL
-- ============================================================================
-- Mirrors the app exactly. Run it and the numbers should equal what the report
-- shows for the same date range. If they differ, the app is wrong (or the view
-- changed) — this is the reference.

WITH scoped AS (
    SELECT *
    FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
    WHERE TRY_TO_DATE(TO_VARCHAR(SALESDATE))
          BETWEEN DATEADD(MONTH, -6, CURRENT_DATE()) AND CURRENT_DATE()
),
accounts AS (
    -- STRICTLY one row per account. BRAND and SCOREGROUP are taken with MAX()
    -- rather than added to the GROUP BY: they were constant per account in the
    -- sample, but if a single account ever carries two brands (cross-sell, or a
    -- brand rename mid-life) then grouping by them splits the account into two
    -- rows, both of which match the same first-collection row on ACCOUNTNO —
    -- double-counting that account's FTC/FID. MAX() cannot inflate.
    -- 0 scores and 0 prices are nulled so MAX() ignores placeholders.
    SELECT
        ACCOUNTNO,
        MIN(TRY_TO_DATE(TO_VARCHAR(SALESDATE)))                       AS SALE_DATE,
        MAX(NULLIF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)), 0))              AS SCORE_NUM,
        MAX(SCOREGROUP)                                               AS SCOREGROUP,
        MAX(REPLACE(BRAND, ' ', ''))                                  AS BRAND,
        MAX(COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0))  AS VAS_FLAG
    FROM scoped
    GROUP BY ACCOUNTNO
),
first_ranked AS (
    -- the FIRST collection: earliest scheduled attempt among the flagged rows.
    SELECT
        ACCOUNTNO,
        COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0) AS PAID,
        UNPAID_GROUP_DESCRIPTION                          AS REASON,
        ROW_NUMBER() OVER (
            PARTITION BY ACCOUNTNO
            ORDER BY TRY_TO_DATE(TO_VARCHAR(SCHEDULEDATE)) NULLS LAST,
                     TRY_TO_DATE(TO_VARCHAR(BILLINGDATE))  NULLS LAST
        ) AS RN
    FROM scoped
    WHERE COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1
),
firsts AS (
    SELECT ACCOUNTNO, PAID, REASON FROM first_ranked WHERE RN = 1
),
joined AS (
    SELECT
        a.ACCOUNTNO,
        a.SALE_DATE,
        a.VAS_FLAG,
        a.BRAND,
        a.SCOREGROUP AS BAND,           -- the business's own banding
        -- Kept alongside it: the round 50-point band. SCOREGROUP is percentile
        -- based ('662 to 672', '887 to 907') and its labels cross the round
        -- boundaries, so a question phrased as "650 to 699" cannot be answered
        -- from BAND alone — 887 to 907 even straddles 900.
        CASE
            WHEN a.SCORE_NUM IS NULL   THEN 'unknown'
            WHEN a.SCORE_NUM < 600     THEN '<600'
            WHEN a.SCORE_NUM >= 900    THEN '900+'
            ELSE TO_VARCHAR(FLOOR(a.SCORE_NUM / 50) * 50) || '-'
              || TO_VARCHAR(FLOOR(a.SCORE_NUM / 50) * 50 + 49)
        END AS BAND_50,
        f.PAID,
        f.REASON,
        IFF(f.ACCOUNTNO IS NULL, 1, 0) AS PENDING   -- no first collection yet
    FROM accounts a
    LEFT JOIN firsts f ON f.ACCOUNTNO = a.ACCOUNTNO
)
SELECT
    BRAND,
    BAND,
    BAND_50,
    COUNT(*)                                                AS ACCOUNTS,
    -- Mix within the brand — this is the one to read when asking "what share of
    -- THIS brand's sales came from that band".
    ROUND(100 * RATIO_TO_REPORT(COUNT(*)) OVER (PARTITION BY BRAND), 1)
                                                            AS MIX_PCT_IN_BRAND,
    -- Mix across everything, so brands are comparable against the whole book.
    ROUND(100 * RATIO_TO_REPORT(COUNT(*)) OVER (), 1)        AS MIX_PCT_OVERALL,
    SUM(IFF(PENDING = 0, 1, 0))                             AS MATURED_BASE,
    SUM(PENDING)                                            AS PENDING,
    SUM(IFF(PENDING = 0 AND PAID = 1, 1, 0))                AS FTC,
    SUM(IFF(PENDING = 0 AND PAID = 0, 1, 0))                AS FID,
    -- rates are over the MATURED base only; pending must never read as paid
    ROUND(100 * SUM(IFF(PENDING = 0 AND PAID = 1, 1, 0))
              / NULLIF(SUM(IFF(PENDING = 0, 1, 0)), 0), 1)  AS FTC_PCT,
    ROUND(100 * SUM(IFF(PENDING = 0 AND PAID = 0, 1, 0))
              / NULLIF(SUM(IFF(PENDING = 0, 1, 0)), 0), 1)  AS FID_PCT,
    ROUND(100 * SUM(IFF(VAS_FLAG = 1, 1, 0)) / COUNT(*), 1) AS VAS_PCT
FROM joined
GROUP BY BRAND, BAND, BAND_50
ORDER BY
    BRAND,
    -- score order, not alphabetical: '908+' would otherwise sort before '662 to 672'
    CASE BAND_50
        WHEN '<600' THEN 1 WHEN '600-649' THEN 2 WHEN '650-699' THEN 3
        WHEN '700-749' THEN 4 WHEN '750-799' THEN 5 WHEN '800-849' THEN 6
        WHEN '850-899' THEN 7 WHEN '900+' THEN 8 ELSE 9
    END,
    BAND;


-- ============================================================================
-- 4. Data quality checks — issues found in the sample; confirm at full volume
-- ============================================================================

-- 4a. Accounts with MORE THAN ONE row flagged as first collection. The report
--     de-duplicates to the earliest, but a large count here means the flag is
--     unreliable upstream and should be fixed.
SELECT ACCOUNTNO, COUNT(*) AS FLAGGED_ROWS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
WHERE COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1
GROUP BY ACCOUNTNO
HAVING COUNT(*) > 1
ORDER BY FLAGGED_ROWS DESC;

-- 4b. Missing or placeholder scores — these land in the 'unknown' band, so a
--     big number here means the mix chart understates real bands.
SELECT
    COUNT(*)                                                          AS ROWS_TOTAL,
    SUM(IFF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)) IS NULL, 1, 0))          AS SCORE_NOT_NUMERIC,
    SUM(IFF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)) = 0, 1, 0))              AS SCORE_ZERO,
    SUM(IFF(TRY_TO_DATE(TO_VARCHAR(SALESDATE)) IS NULL, 1, 0))        AS SALESDATE_MISSING,
    SUM(IFF(TRY_TO_NUMBER(TO_VARCHAR(PRODUCTPRICE)) = 0, 1, 0))       AS PRICE_ZERO
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE;

-- 4c. Does PAID_FLAG ever disagree with the status columns? It did not in the
--     sample. Any rows here mean the outcome field needs re-picking.
-- (ROWS is reserved in Snowflake, hence N_ROWS.)
SELECT PAID_FLAG, UNPAID_GROUP_DESCRIPTION, COUNT(*) AS N_ROWS
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE
WHERE (COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0) = 1
        AND UPPER(TRIM(UNPAID_GROUP_DESCRIPTION)) <> 'SUCCESSFUL')
   OR (COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0) = 0
        AND UPPER(TRIM(UNPAID_GROUP_DESCRIPTION)) = 'SUCCESSFUL')
GROUP BY 1, 2
ORDER BY N_ROWS DESC;

-- 4d. Can this feed express a PARTIAL settlement? In the sample the billed and
--     instructed amounts were always equal, so "paid in full" is taken from
--     PAID_FLAG. Rows here would mean a real collected-vs-due difference exists
--     and the FTC test should use it instead.
SELECT COUNT(*) AS ROWS_WHERE_BILLED_NE_INSTRUCTED
FROM <SOURCE_DB>.<SOURCE_SCHEMA>.<SOURCE_OBJECT>
WHERE TRY_TO_NUMBER(TO_VARCHAR(BILLED_AMOUNT_INCL_VAT))
      <> TRY_TO_NUMBER(TO_VARCHAR(DC_INSTRUCTEDAMOUNT))
  AND DC_INSTRUCTEDAMOUNT IS NOT NULL;
