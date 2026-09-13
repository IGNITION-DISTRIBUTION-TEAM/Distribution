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
   SECTION 2 — Yaxxa campaigns

   Same question, and this one is the bigger unknown: nothing in this repo has
   ever referenced YAXXA_DW_REPLICATION. Candidates tried, in order:

     id     CAMPAIGN_ID, CAMPAIGNID, ID, CAMPAIGN_CODE, CAMPAIGNCODE
     name   CAMPAIGN_NAME, CAMPAIGNNAME, NAME, TITLE, DESCRIPTION, CAMPAIGN_DESC

   NO ACTIVE FILTER IS APPLIED to this side, deliberately — CAMPAIGN_MASTER may
   have no such column, and a filter that excludes everything is worse than no
   filter. If 2a shows an active or status column, say so and it can be added.
-------------------------------------------------------------------------------- */

SELECT ORDINAL_POSITION AS POS, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'YAXXA_DW_REPLICATION'
   AND TABLE_NAME   = 'CAMPAIGN_MASTER'
 ORDER BY ORDINAL_POSITION;

SELECT * FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER LIMIT 10;

-- 2c. How many, and is the id actually unique? The mapping keys on it, so a
--     repeated id would make "which campaign is this" ambiguous.
SELECT COUNT(*) AS ROWS_TOTAL FROM DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER;


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

   2. If section 2 showed an active or status column on CAMPAIGN_MASTER, the
      Yaxxa list is currently showing retired campaigns too. Say so and
      YAXXA_SOURCE.activeFilter takes one.

   3. If section 3 returned rows, two screens in this portal disagree about
      which campaigns are active. That is worth settling before the mapping is
      built on top of one of them.
-------------------------------------------------------------------------------- */
