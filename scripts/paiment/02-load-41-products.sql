/* =============================================================================
   The 41 products that are always DISTRIBUTION / ONAIR
   -----------------------------------------------------------------------------
   The immediate fix, so executive reporting can be corrected today without
   waiting for the Paiment screen. Once that screen is live this file is
   history: the business maintains the mapping there and nobody edits SQL.

   Source: Mapping__Channel__Brand.xlsx, sheet "Unique Product Names", 41 rows,
   every one DISTRIBUTION / ONAIR. Confirmed against the business's answer to
   the direct question — "these 41 products are always DISTRIBUTION/ONAIR",
   whatever campaign the deal was sold under.

   RUN 00-resolve-and-diagnose.sql FIRST, at least section 2. If the
   full-history VIEW already reports DISTRIBUTION/ONAIR for the three test
   sales, the mapping is already correct and the table simply needs rebuilding —
   this file would change nothing and the real fix is a rebuild.

   -----------------------------------------------------------------------------
   TWO THINGS THIS FILE DOES ON PURPOSE

   1. IT WRITES TO THE TABLE, NOT THE VIEW. Those are BILLINGDATA_PRODUCTGROUPS
      and VW_BI_BILLING_PRODUCTGROUPS respectively — the table's name is not
      the view's minus a prefix, so read the MERGE target carefully rather than
      assuming. Both are confirmed. Section 1 of the diagnose script re-resolves
      them from GET_DDL if BI ever renames one, and PRODUCT_MAPPING in
      lib/billing-mappings.ts has to move with it.

   2. IT MATCHES ON TRIM(UPPER(...)), the same expression the full-history view
      joins on. Anything looser could leave two rows that both satisfy that
      join, and a duplicate there does not merely confuse the report — it
      DOUBLES that product's billing rows and overstates its revenue.

   One product name below carries an internal double space in the source
   workbook ("... x24 Months  (1Click)"). It is normalised to a single space
   here, because trim() does not touch internal whitespace and the row would
   otherwise never match anything. If the billing data genuinely carries two
   spaces for that product, this is the one row to check by hand.

   Re-runnable. It sets the two override columns and touches nothing else —
   PRODUCT_GROUP and VAS_BUTTON_FLAG are left exactly as they are.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — before

   Expect 0, or the count from a previous run. Anything unexpected means
   somebody else is editing this too.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                 AS PRODUCTS,
       COUNT_IF(BRAND_OVERRIDE = 'ONAIR')       AS ALREADY_ONAIR,
       COUNT_IF(CHANNEL_OVERRIDE IS NOT NULL)   AS ANY_CHANNEL_OVERRIDE
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS;


/* -----------------------------------------------------------------------------
   SECTION 2 — the 41

   WHEN NOT MATCHED inserts a mapping row for a product that has none, so a
   product missing from the mapping still gets its override. Those rows get a
   NULL PRODUCT_GROUP, which is correct — this file knows the channel and the
   brand, and inventing a product group would be a guess.
-------------------------------------------------------------------------------- */

MERGE INTO DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS t
USING (
  SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R259 PM x24 Months' AS PRODUCTNAME, 'DISTRIBUTION' AS CHANNEL_OVERRIDE, 'ONAIR' AS BRAND_OVERRIDE
  UNION ALL SELECT 'DSTV Explora Ultra Standalone @ R299 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'Mediabox Maverick 2 4K @ R199 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama @ R189 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection R239 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R219 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection R259 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE WITH R5000 LIFE COVER, RESCUE BOX, DECODER PROTECTION @ R239 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE WITH R5000 LIFE COVER; RESCUE BOX; DECODER PROTECTION @ R199 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora 3B + DStv Virtual Install Voucher Incl R5000 Life Cover; Rescue Box; Decoder Protection @ R199 PM x 24 Months Subscription', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE WITH R5000 LIFE COVER @ R189 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora 3B Standalone + Rescue Box & Decoder Protection @ R199 PM x 24 Months Subscription', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama Incl Rescue Box @ R99 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover, Rescue Box, Decoder Protection + R1000 Takealot Voucher @ R219 PM x24 Months (1Click)', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA INSTALLED WITH R5000 LIFE COVER, RESCUE BOX, DECODER PROTECTION @ R279 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R199 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone @ R179 x 24 months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE WITH R5000 LIFE COVER @ R169 PM x 24 MONTHS (DM)', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Installed With R5000 Life Cover + Decoder Protection @ R299 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora 3B Standalone + R5000 Life Cover, Rescue Box, Decoder Protection @ R199 PM x 24 Months Subscription', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE PLUS RESCUE BOX & DECODER PROTECTION @ R239 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R279 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama @ R99 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Installed With R5000 Life Cover + Decoder Protection @ R319 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R289 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama + Showmax for 12 Months @ R179 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama + Showmax for 12 Months @ R179 PM x24 Months (1Click)', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone @ R289 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Ultimate Streama + 12 Months Showmax @ R189 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone @ R319 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Streama @ R199 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Installed @ R380 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Ultimate Streama + 12 Months Showmax @ R179 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV EXPLORA ULTRA STANDALONE WITH R5000 LIFE COVER, RESCUE BOX, DECODER PROTECTION @ R199 PM x 24 MONTHS', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora 3B Installed + R5000 Life Cover, Rescue Box, Decoder Protection @ R239 PM x 24 Months Subscription', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone With R5000 Life Cover + Decoder Protection @ R239 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Standalone @ R239 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'Mecool KM7 Plus @ R219 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'Netogy Nova Pro @ R219 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Installed With R5000 Life Cover + Decoder Protection @ R279 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
  UNION ALL SELECT 'DSTV Explora Ultra Installed With R5000 Life Cover + Decoder Protection @ R329 PM x24 Months', 'DISTRIBUTION', 'ONAIR'
) s
   ON TRIM(UPPER(t.PRODUCTNAME)) = TRIM(UPPER(s.PRODUCTNAME))
 WHEN MATCHED THEN UPDATE SET
        t.CHANNEL_OVERRIDE = s.CHANNEL_OVERRIDE,
        t.BRAND_OVERRIDE   = s.BRAND_OVERRIDE
 WHEN NOT MATCHED THEN INSERT (PRODUCTNAME, CHANNEL_OVERRIDE, BRAND_OVERRIDE)
                      VALUES (s.PRODUCTNAME, s.CHANNEL_OVERRIDE, s.BRAND_OVERRIDE);


/* -----------------------------------------------------------------------------
   SECTION 3 — after

   ALREADY_ONAIR should now be 41. If it is fewer, section 4 says which are
   missing.
-------------------------------------------------------------------------------- */

SELECT COUNT(*)                                 AS PRODUCTS,
       COUNT_IF(BRAND_OVERRIDE = 'ONAIR')       AS NOW_ONAIR,
       COUNT_IF(CHANNEL_OVERRIDE = 'DISTRIBUTION') AS NOW_DISTRIBUTION
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS;

-- 3b. The three test sales, straight from the live view logic. Both columns
--     should now read DISTRIBUTION and ONAIR.
SELECT ORDERREFERENCE, PRODUCTNAME, CAMPAIGNNAME, CHANNEL, BRAND
  FROM DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY
 WHERE ORDERREFERENCE IN ('MY-THEO-FIBRE1', 'MY-THEO-FIBRE2', 'MY-THEO-FIBRE3');

/* THEN REBUILD DATAWAREHOUSE.BI_SANCTION.BI_SANCTION_BILLINGDATA_FULL_HISTORY.
   The view is the logic; the table is what reporting reads, and it does not
   change until it is rebuilt. That rebuild is Data Engineering's step, not
   this file's. */


/* -----------------------------------------------------------------------------
   SECTION 4 — anything that did not take

   Empty is the answer you want. A row here is a product whose name in the
   mapping differs from the workbook by more than case and outer whitespace.
-------------------------------------------------------------------------------- */

SELECT PRODUCT, CHANNEL_OVERRIDE, BRAND_OVERRIDE
  FROM DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS
 WHERE UPPER(PRODUCT) LIKE '%EXPLORA ULTRA%'
    OR UPPER(PRODUCT) LIKE '%STREAMA%'
    OR UPPER(PRODUCT) LIKE '%MEDIABOX%'
 ORDER BY BRAND_OVERRIDE NULLS FIRST, PRODUCT;
