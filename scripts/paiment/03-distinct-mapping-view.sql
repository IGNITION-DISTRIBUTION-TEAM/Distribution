/* =============================================================================
   A DISTINCT product mapping, so the billing join stops fanning out
   -----------------------------------------------------------------------------
   The mapping the full-history view joins to is not distinct. 795 product names
   appear more than once — 996 rows more than there should be — and the join is

       LEFT JOIN ...VW_BI_BILLING_PRODUCTGROUPS PG
              ON trim(upper(PG.PRODUCT)) = trim(upper(fs.PRODUCTNAME))

   so every billing row for a duplicated product is multiplied by however many
   mapping rows carry that name.

   READ THAT AGAIN, BECAUSE THE NUMBER IS NOT 996. It is 996 extra COPIES of
   however many sales each of those products has. A product with 4,000 sales and
   one surplus mapping row contributes 4,000 phantom billing rows on its own.
   Section 2 measures the real figure; it is the one that has been in executive
   reporting.

   NOTHING HERE DELETES ANYTHING. A view presents one row per product, Data
   Engineering repoints the full-history join at it (one line, section 4), and
   the surplus rows stay in the base table where the Paiment screen can still
   see and fix them.

   -----------------------------------------------------------------------------
   RUN 00-resolve-and-diagnose.sql SECTION 1c FIRST. IT GATES SECTION 3.

   The tie-break below assumes BILLINGDATA_PRODUCTGROUPS has only the five
   columns the app knows about. If it also carries something like a load date or
   a source system, then these rows are NOT duplicates in the table's own terms
   — only from the point of view of a join keyed on the product name — and the
   ORDER BY should prefer the NEWEST row rather than the most-populated one.
   That is one line, and section 3 marks it.

   -----------------------------------------------------------------------------
   NOT ALL 996 ARE THE SAME PROBLEM

     identical duplicates   collapsing them is free. The join is multiplying
                            billing rows for no reason at all.
     conflicting duplicates two rows for one product disagreeing about group,
                            VAS flag or an override. A distinct view has to PICK
                            ONE, so these are real decisions and section 1
                            counts them.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — how many of the 795 actually disagree?

   Per duplicated name: how many rows, and how many DISTINCT COMBINATIONS of the
   four mapped columns. DISTINCT_SHAPES = 1 means exact copies. More than 1 is a
   conflict, and the view's tie-break will decide it for you unless a person
   does first.

   Read the totals row first. If CONFLICTING is a handful, fix those in the
   Paiment screen this afternoon and the view is belt-and-braces. If it is most
   of the 795, the view is doing real work and the base table needs a cleanup
   after it.
-------------------------------------------------------------------------------- */

WITH D AS (
    SELECT TRIM(UPPER(PRODUCTNAME)) AS PRODUCT_KEY,
           COUNT(*)                 AS ROWS_FOUND,
           COUNT(DISTINCT
                 IFNULL(PRODUCT_GROUP,    '~') || '|' ||
                 IFNULL(VAS_BUTTON_FLAG,  '~') || '|' ||
                 IFNULL(CHANNEL_OVERRIDE, '~') || '|' ||
                 IFNULL(BRAND_OVERRIDE,   '~')) AS DISTINCT_SHAPES
      FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
     GROUP BY 1
    HAVING COUNT(*) > 1
)
SELECT COUNT(*)                                  AS DUPLICATED_NAMES,
       SUM(ROWS_FOUND)                           AS ROWS_THEY_OCCUPY,
       SUM(ROWS_FOUND) - COUNT(*)                AS SURPLUS_ROWS,
       SUM(IFF(DISTINCT_SHAPES > 1, 1, 0))       AS CONFLICTING,
       SUM(IFF(DISTINCT_SHAPES = 1, 1, 0))       AS EXACT_COPIES
  FROM D;

-- 1b. The conflicts themselves, worst first. THESE are the ones a person has to
--     decide; everything else the view collapses safely.
WITH D AS (
    SELECT TRIM(UPPER(PRODUCTNAME)) AS PRODUCT_KEY,
           COUNT(*)                 AS ROWS_FOUND,
           COUNT(DISTINCT
                 IFNULL(PRODUCT_GROUP,    '~') || '|' ||
                 IFNULL(VAS_BUTTON_FLAG,  '~') || '|' ||
                 IFNULL(CHANNEL_OVERRIDE, '~') || '|' ||
                 IFNULL(BRAND_OVERRIDE,   '~')) AS DISTINCT_SHAPES,
           LISTAGG(DISTINCT IFNULL(CHANNEL_OVERRIDE, '(none)'), ' | ') AS CHANNELS,
           LISTAGG(DISTINCT IFNULL(BRAND_OVERRIDE,   '(none)'), ' | ') AS BRANDS,
           LISTAGG(DISTINCT IFNULL(PRODUCT_GROUP,    '(none)'), ' | ') AS GROUPS
      FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
     GROUP BY 1
    HAVING COUNT(*) > 1
)
SELECT PRODUCT_KEY, ROWS_FOUND, DISTINCT_SHAPES, CHANNELS, BRANDS, GROUPS
  FROM D
 WHERE DISTINCT_SHAPES > 1
 ORDER BY DISTINCT_SHAPES DESC, ROWS_FOUND DESC, PRODUCT_KEY;


/* -----------------------------------------------------------------------------
   SECTION 2 — what the fan-out actually costs, in billing rows

   THE NUMBER THAT JUSTIFIES THE CHANGE. Run it BEFORE section 3 and write the
   answer down, then run it again after Data Engineering has repointed the join
   and rebuilt. The difference is the over-count that has been in the reporting.

   INFLATED counts what the current join produces; DISTINCT counts what it
   should. They are computed side by side from the same billing rows, so the
   comparison holds even as sales come in.
-------------------------------------------------------------------------------- */

WITH DUPES AS (
    SELECT TRIM(UPPER(PRODUCTNAME)) AS PRODUCT_KEY, COUNT(*) AS MAPPING_ROWS
      FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
     GROUP BY 1
)
SELECT COUNT(*)                                   AS BILLING_ROWS,
       SUM(IFNULL(d.MAPPING_ROWS, 1))             AS ROWS_AFTER_THE_JOIN,
       SUM(IFNULL(d.MAPPING_ROWS, 1)) - COUNT(*)  AS PHANTOM_ROWS,
       ROUND(100 * (SUM(IFNULL(d.MAPPING_ROWS, 1)) - COUNT(*)) / NULLIF(COUNT(*), 0), 2)
                                                  AS PCT_OVERSTATED
  FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY fs
  LEFT JOIN DUPES d
    ON d.PRODUCT_KEY = TRIM(UPPER(fs.PRODUCTNAME));

/* IFNULL(MAPPING_ROWS, 1) because a billing row whose product has NO mapping
   still survives the LEFT JOIN exactly once — an unmapped product is a
   different problem (00-resolve-and-diagnose.sql section 6) and must not be
   counted as inflation here.

   IF PCT_OVERSTATED IS NOT ~0, EVERY REVENUE FIGURE DERIVED FROM THE
   FULL-HISTORY TABLE IS HIGH BY ROUGHLY THAT MUCH, and has been for as long as
   the duplicates have existed. That is worth telling whoever owns the executive
   pack BEFORE the number changes under them.

   2b. Which products contribute most of it — the shortlist worth fixing by hand
   even before the view goes in. */

WITH DUPES AS (
    SELECT TRIM(UPPER(PRODUCTNAME)) AS PRODUCT_KEY, COUNT(*) AS MAPPING_ROWS
      FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
     GROUP BY 1 HAVING COUNT(*) > 1
)
SELECT TRIM(UPPER(fs.PRODUCTNAME))              AS PRODUCT_KEY,
       COUNT(*)                                 AS BILLING_ROWS,
       MAX(d.MAPPING_ROWS)                      AS MAPPING_ROWS,
       COUNT(*) * (MAX(d.MAPPING_ROWS) - 1)     AS PHANTOM_ROWS
  FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY fs
  JOIN DUPES d ON d.PRODUCT_KEY = TRIM(UPPER(fs.PRODUCTNAME))
 GROUP BY 1
 ORDER BY PHANTOM_ROWS DESC
 LIMIT 25;


/* -----------------------------------------------------------------------------
   SECTION 3 — the distinct view

   One row per TRIM(UPPER(PRODUCTNAME)) — the JOIN'S OWN KEY, so distinctness is
   defined exactly the way the join reads it. Defining it any other way would
   leave rows that still collide at join time.

   THE TIE-BREAK IS A DECISION, NOT A DETAIL:

     1. An OVERRIDDEN row always beats a blank one. Otherwise an arbitrary pick
        could silently discard the very override the business set, which is the
        failure this entire feature exists to prevent.
     2. Then the remaining columns, so the winner is DETERMINISTIC. A bare
        ORDER BY on the name would leave Snowflake free to return a different
        row each run, and reporting that changes without the data changing is
        worse than reporting that is consistently wrong.

   It cannot resolve a genuine disagreement correctly — nothing can. Section 1b
   lists those; a person decides them in the Paiment screen, and until they do
   this view at least picks the same way every time.

   IF SECTION 1c OF THE DIAGNOSE SCRIPT SHOWED EXTRA COLUMNS — a load date, a
   source — replace the first ORDER BY term with that column DESC, so the newest
   row wins. That is a better rule when it is available.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.BI.VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT
COPY GRANTS
AS
SELECT PRODUCTNAME       AS PRODUCT,
       PRODUCTNAME,
       PRODUCT_GROUP,
       VAS_BUTTON_FLAG,
       CHANNEL_OVERRIDE,
       BRAND_OVERRIDE
  FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
QUALIFY ROW_NUMBER() OVER (
          PARTITION BY TRIM(UPPER(PRODUCTNAME))
          ORDER BY IFF(CHANNEL_OVERRIDE IS NULL AND BRAND_OVERRIDE IS NULL, 1, 0),
                   CHANNEL_OVERRIDE NULLS LAST,
                   BRAND_OVERRIDE   NULLS LAST,
                   PRODUCT_GROUP    NULLS LAST,
                   VAS_BUTTON_FLAG  NULLS LAST
        ) = 1;

/* BOTH `PRODUCT` AND `PRODUCTNAME` ARE EXPOSED, deliberately. The existing
   full-history join reads PG.PRODUCT — that is what VW_BI_BILLING_PRODUCTGROUPS
   calls it — so exposing the same alias means section 4 is a one-word change
   and not a rewrite of the join condition. PRODUCTNAME rides along for anything
   that prefers the base table's spelling. */

GRANT SELECT ON VIEW
  DATAWAREHOUSE.BI.VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 4 — the one line Data Engineering changes

   In DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY:

     -  LEFT JOIN "DATAWAREHOUSE"."BI"."VW_BI_BILLING_PRODUCTGROUPS" PG
     +  LEFT JOIN "DATAWAREHOUSE"."BI"."VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT" PG
             ON trim(upper(PG.PRODUCT)) = trim(upper(fs.PRODUCTNAME))

   THE JOIN CONDITION DOES NOT CHANGE. Neither does
   `coalesce(pg.brand_override, cc.brand)` or `coalesce(pg.channel_override,
   cc.channel)` — the view exposes the same column names, which is the whole
   point of section 3's aliasing.

   Then rebuild BI_SANCTION_BILLINGDATA_FULL_HISTORY. The view is the logic; the
   table is what reporting reads, and it does not change until it is rebuilt.
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 5 — verification

   5a. THE VIEW IS ACTUALLY DISTINCT. These two must be equal, exactly. If they
       are not, the tie-break is not partitioning on the same key the join uses.
-------------------------------------------------------------------------------- */

SELECT (SELECT COUNT(*) FROM DATAWAREHOUSE.BI.VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT)
         AS ROWS_IN_VIEW,
       (SELECT COUNT(DISTINCT TRIM(UPPER(PRODUCTNAME)))
          FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS)
         AS DISTINCT_NAMES_IN_TABLE;

-- 5b. NO PRODUCT LOST AN OVERRIDE TO THE TIE-BREAK. Empty is the answer you
--     want: a product that had an override on ANY of its rows must still have
--     one in the view. This is what rule 1 of the tie-break buys, and it is
--     worth proving rather than trusting.
WITH HAD AS (
    SELECT TRIM(UPPER(PRODUCTNAME)) AS PRODUCT_KEY
      FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS
     WHERE CHANNEL_OVERRIDE IS NOT NULL OR BRAND_OVERRIDE IS NOT NULL
     GROUP BY 1
)
SELECT h.PRODUCT_KEY
  FROM HAD h
  JOIN DATAWAREHOUSE.BI.VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT v
    ON TRIM(UPPER(v.PRODUCTNAME)) = h.PRODUCT_KEY
 WHERE v.CHANNEL_OVERRIDE IS NULL
   AND v.BRAND_OVERRIDE IS NULL;

-- 5c. The 41 DISTRIBUTION/ONAIR products still resolve that way through the
--     view. This is the original reporting fix, and it must survive.
SELECT COUNT(*)                                        AS OVERRIDDEN_PRODUCTS,
       COUNT_IF(CHANNEL_OVERRIDE = 'DISTRIBUTION')     AS DISTRIBUTION,
       COUNT_IF(BRAND_OVERRIDE   = 'ONAIR')            AS ONAIR
  FROM DATAWAREHOUSE.BI.VW_BILLINGDATA_PRODUCTGROUPS_DISTINCT
 WHERE CHANNEL_OVERRIDE IS NOT NULL OR BRAND_OVERRIDE IS NOT NULL;

-- 5d. After section 4 and the rebuild: re-run section 2. PHANTOM_ROWS should be
--     0 and PCT_OVERSTATED 0.00.

/* -----------------------------------------------------------------------------
   SECTION 6 — what this does NOT fix

   THE VIEW STOPS THE FAN-OUT. It does not make the mapping correct.

   1. THE CONFLICTS FROM SECTION 1b ARE STILL UNRESOLVED. The view picks
      deterministically, which is better than arbitrarily, but for a product
      whose rows disagree about the brand it is still picking rather than
      knowing. Work through that list in the Paiment screen.

   2. NEAR-DUPLICATES ARE UNTOUCHED, and there appear to be plenty. From the
      screen's own examples:

          MY HOME PREMIUM WITH LIFE ELITE MOBILE @ R179
          MY HOME PREMIUM WITH LIFE ELITE MOBILE@179

      Those are two DIFFERENT keys — a distinct view treats them as two
      products, because to the join they are. Whether they are the same product
      written twice is a business question, and if they are, one of them is
      matching no billing rows at all while the other carries everything. This
      finds them:

        SELECT a.PRODUCTNAME, b.PRODUCTNAME
          FROM DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS a
          JOIN DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS b
            ON REGEXP_REPLACE(UPPER(a.PRODUCTNAME), '[^A-Z0-9]', '')
             = REGEXP_REPLACE(UPPER(b.PRODUCTNAME), '[^A-Z0-9]', '')
           AND TRIM(UPPER(a.PRODUCTNAME)) < TRIM(UPPER(b.PRODUCTNAME))
         ORDER BY 1;

      Strip every non-alphanumeric character and the two above collapse to one.
      Run it; the count will probably be uncomfortable.

   3. THE UPSTREAM CAUSE IS UNTOUCHED. A mapping keyed on a free-text product
      name will keep acquiring duplicates, near-duplicates and disagreements for
      as long as it is keyed on a free-text product name. The durable fix is a
      product identifier, and that is a conversation with whoever owns the
      product catalogue rather than a change to this view.
-------------------------------------------------------------------------------- */
