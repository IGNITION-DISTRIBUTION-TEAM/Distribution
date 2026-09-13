/* =============================================================================
   Dialler campaign mapping — what is actually in the two tables
   -----------------------------------------------------------------------------
   The mapper links active SilverSurfer campaigns to Yaxxa dialler campaigns:

       DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN          (ACTIVE = 1)
       DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER

   NEITHER HAS BEEN READ BY THIS APP BEFORE, so the screen does not assume their
   column names — it probes INFORMATION_SCHEMA at load, takes the first match
   from an ordered candidate list, and prints what it resolved at the top of the
   page. Sections 1 and 2 are how you check that it chose correctly.

   If it chose wrong, the fix is one edit to idCandidates / labelCandidates in
   lib/dialler-campaign-map.ts. If it resolved NOTHING, the app's role is
   probably missing SELECT — run 01-grants.sql.

   Read-only throughout. Nothing here writes.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — SilverSurfer campaigns

   Looking for an id column and a human-readable name column. The app tries, in
   order:

     id     CAMPAIGNID, CAMPAIGN_ID, CAMPID, ID
     name   TITLE, CAMPAIGNNAME, CAMPAIGN_NAME, NAME, DESCRIPTION

   It also assumes ACTIVE = 1 is a valid filter, because that is the query you
   gave. 1c checks that column exists and what it holds.
-------------------------------------------------------------------------------- */

SELECT ORDINAL_POSITION AS POS, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'SILVERSURFER'
   AND TABLE_NAME   = 'CAMP_CAMPAIGN'
 ORDER BY ORDINAL_POSITION;

-- 1b. A few rows, to see which column actually reads like a campaign name.
--     A column called TITLE holding nulls is worse than no TITLE at all.
SELECT * FROM DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN WHERE ACTIVE = 1 LIMIT 10;

-- 1c. How many are active, and is ACTIVE the flag it looks like?
SELECT ACTIVE, COUNT(*) AS CAMPAIGNS
  FROM DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN
 GROUP BY ACTIVE
 ORDER BY CAMPAIGNS DESC;


/* -----------------------------------------------------------------------------
   SECTION 2 — Yaxxa campaigns. RESOLVED; this is now a re-check.

     id     CAMP_ID
     name   CAMP_NAME
     shown  CAMP_STATUS, CAMP_TYPE, CAMP_DIALER, CAMP_DESC
     scope  TENANT_ID = 1002 AND IFNULL(_EDGE_DELETED, FALSE) = FALSE

   The first attempt guessed CAMPAIGN_ID and CAMPAIGN_NAME and resolved neither.
   The screen said so, naming every candidate it had tried — which is the whole
   reason the probe exists rather than a hard-coded guess.

   THREE THINGS THE REAL TABLE TURNED UP, all of which changed the design:

   1. TENANT_ID. The dialler is MULTI-TENANT. 1000 and 1001 carry Internal,
      inbound_camp, outbound_camp and auto_camp; the real work is on 1002.
      Mapping a SilverSurfer campaign to another tenant's test campaign would be
      quietly wrong rather than an error, so the picker is scoped. 2d checks
      whether that scope is still right.

   2. CAMP_STATUS, holding Y, X and N. NOT filtered on, because nobody has
      confirmed what they mean — Y clusters on newer ids and X on older, which
      is suggestive and not evidence. The status is displayed on every row
      instead. 2e is the query that would settle it.

   3. CAMP_NAME IS NOT UNIQUE. "VC CVM Upgrades" is CAMP_ID 47, 78 and 81.
      The picker prints the id beside the name for exactly this reason. 2f
      lists them.

   Run 2a and 2b again if Yaxxa ever changes shape; the screen's "Where this
   reads from" card is the faster check day to day.
-------------------------------------------------------------------------------- */

SELECT ORDINAL_POSITION AS POS, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'YAXXA_DW_REPLICATION'
   AND TABLE_NAME   = 'CAMPAIGN_MASTER'
 ORDER BY ORDINAL_POSITION;

SELECT * FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER LIMIT 10;

-- 2c. How many, and is CAMP_ID actually unique? The mapping keys on it, so a
--     repeated id would make "which campaign is this" ambiguous.
SELECT COUNT(*) AS ROWS_TOTAL, COUNT(DISTINCT CAMP_ID) AS DISTINCT_IDS
  FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER;

-- 2d. The tenants, so the 1002 scope can be sanity-checked. If real campaigns
--     appear under another tenant, the filter in lib/dialler-campaign-map.ts
--     needs widening — the picker will simply not show them until it does.
SELECT TENANT_ID,
       COUNT(*)                                   AS CAMPAIGNS,
       LISTAGG(DISTINCT CAMP_NAME, ' | ')
         WITHIN GROUP (ORDER BY CAMP_NAME)        AS SAMPLE_NAMES
  FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER
 GROUP BY TENANT_ID
 ORDER BY CAMPAIGNS DESC;

-- 2e. WHAT DOES CAMP_STATUS MEAN? Still open. If Y turns out to be the only
--     live value, it becomes a filter in YAXXA_SOURCE.activeFilter and the
--     picker gets shorter. Until then every campaign is offered with its
--     status shown, which is the safer way round.
SELECT CAMP_STATUS,
       COUNT(*)                                        AS CAMPAIGNS,
       MIN(CAMP_ID)                                    AS LOWEST_ID,
       MAX(CAMP_ID)                                    AS HIGHEST_ID,
       COUNT_IF(DELETED_AT IS NOT NULL)                AS SOFT_DELETED
  FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER
 WHERE TENANT_ID = 1002
 GROUP BY CAMP_STATUS
 ORDER BY CAMPAIGNS DESC;

-- 2f. DUPLICATE CAMPAIGN NAMES. Not a fault — a dialler may well run the same
--     campaign several ways — but it means the NAME cannot identify a campaign,
--     which is why the picker shows the id and why the mapping stores the id.
SELECT CAMP_NAME,
       COUNT(*)                                        AS COPIES,
       LISTAGG(CAMP_ID, ', ') WITHIN GROUP (ORDER BY CAMP_ID) AS IDS,
       LISTAGG(DISTINCT CAMP_DIALER, ', ')             AS DIALLER_MODES
  FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER
 WHERE TENANT_ID = 1002
 GROUP BY CAMP_NAME
HAVING COUNT(*) > 1
 ORDER BY COPIES DESC, CAMP_NAME;


/* -----------------------------------------------------------------------------
   SECTION 3 — TWO SILVERSURFER CAMPAIGN TABLES, AND THEY MAY DISAGREE

   Worth knowing before anyone maps anything.

   This mapper reads SILVERSURFER.CAMP_CAMPAIGN, the table you named. But
   app/api/campaigns/route.ts — which fills the campaign picker in Distribution
   → Settings — reads a DIFFERENT one:

       DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN (CAMPAIGNID, TITLE)

   If the two disagree about which campaigns are active, then two screens in
   this portal answer the same question differently, and that surfaces months
   later in an argument about a number rather than as an error.

   Empty results from 3b and 3c mean they agree and there is nothing to do.
-------------------------------------------------------------------------------- */

SELECT 'SILVERSURFER.CAMP_CAMPAIGN'        AS SOURCE, COUNT(*) AS ACTIVE_CAMPAIGNS
  FROM DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN WHERE ACTIVE = 1
UNION ALL
SELECT 'SILVERSURFER_CAMP_HEVO.CAMPAIGN', COUNT(*)
  FROM DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN WHERE ACTIVE = 1;

/* 3b and 3c assume both carry CAMPAIGNID. If section 1 showed a different id
   column on CAMP_CAMPAIGN, substitute it. */

-- 3b. Active here, but not in the table the Distribution picker uses.
SELECT a.CAMPAIGNID
  FROM DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN a
 WHERE a.ACTIVE = 1
   AND NOT EXISTS (SELECT 1 FROM DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN b
                    WHERE b.CAMPAIGNID = a.CAMPAIGNID AND b.ACTIVE = 1);

-- 3c. And the other way round.
SELECT b.CAMPAIGNID, b.TITLE
  FROM DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN b
 WHERE b.ACTIVE = 1
   AND NOT EXISTS (SELECT 1 FROM DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN a
                    WHERE a.CAMPAIGNID = b.CAMPAIGNID AND a.ACTIVE = 1);


/* -----------------------------------------------------------------------------
   SECTION 4 — the mappings that have gone stale

   THE ONE THAT ROTS QUIETLY. Campaigns get deactivated and replaced constantly,
   and a mapping pointing at a campaign that no longer exists keeps matching
   nothing — until a report comes up short and nobody knows why.

   The screen shows a count; this lists them. The SS_TITLE and YAXXA_NAME
   columns are snapshots taken when the mapping was made, which is the only
   reason a row whose campaign has vanished still reads as something a person
   recognises rather than a bare id.

   Empty is the healthy answer. Nothing to run until the app has been used.
-------------------------------------------------------------------------------- */

SELECT m.SS_CAMPAIGNID,
       m.SS_TITLE,
       m.YAXXA_CAMPAIGNID,
       m.YAXXA_NAME,
       IFF(s.CAMPAIGNID IS NULL, 'gone or inactive', '')  AS SILVERSURFER_SIDE,
       m.CREATED_BY,
       m.CREATED_AT
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP m
  LEFT JOIN DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN s
    ON CAST(s.CAMPAIGNID AS VARCHAR) = m.SS_CAMPAIGNID
   AND s.ACTIVE = 1
 WHERE s.CAMPAIGNID IS NULL
 ORDER BY m.SS_TITLE, m.YAXXA_NAME;

-- 4b. A Yaxxa campaign claimed by two SilverSurfer campaigns. Should be
--     impossible — YAXXA_CAMPAIGNID is the primary key — but SNOWFLAKE DOES NOT
--     ENFORCE PRIMARY KEYS, so the constraint that encodes the entire
--     one-to-many cardinality is documentation unless something checks it.
SELECT YAXXA_CAMPAIGNID,
       COUNT(*) AS ROWS_FOUND,
       LISTAGG(DISTINCT SS_CAMPAIGNID, ', ') AS CLAIMED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP
 GROUP BY 1 HAVING COUNT(*) > 1
 ORDER BY ROWS_FOUND DESC;


/* -----------------------------------------------------------------------------
   SECTION 5 — what to do with what you found

   1. Sections 1 and 2 name the real columns. Open Dialler → Campaign mapping
      and compare against the "Where this reads from" card at the top. If they
      differ, correct idCandidates / labelCandidates in
      lib/dialler-campaign-map.ts — the list is ordered and the first match
      wins, so putting the right name first is enough.

   2. Section 2e is the open question: what Y, X and N mean on CAMP_STATUS. If
      only one of them is live, say so and YAXXA_SOURCE.activeFilter takes it —
      the picker gets shorter and nothing else changes. Until then every
      campaign is offered with its status shown, which errs towards showing too
      much rather than hiding something mappable.

   3. If section 3 returned rows, two screens in this portal disagree about
      which campaigns are active. That is worth settling before the mapping is
      built on top of one of them.
-------------------------------------------------------------------------------- */
