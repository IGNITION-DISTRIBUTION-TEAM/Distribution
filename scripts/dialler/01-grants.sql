/* =============================================================================
   Dialler campaign mapping — grants, the map table, and the downstream view
   -----------------------------------------------------------------------------
   Run 00-discover-columns.sql first. If it showed no columns for either source,
   the cause is a missing grant and section 1 here is the fix.

   The app READS both campaign sources and WRITES only its own table, in its own
   schema. Nothing here grants write access to SilverSurfer or Yaxxa — the
   mapping is the app's own record of a decision a person made, not a change to
   either system.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — read the two campaign sources

   Run as ACCOUNTADMIN. Safe to re-run.

   USAGE ON SCHEMA matters as much as SELECT: without it every object inside is
   invisible however it is granted, and Snowflake reports that identically to
   the object not existing. The app's column probe would then come back empty
   and the screen would say it could not resolve the columns — which is the
   right message for a different cause, so check the grants before editing the
   candidate lists.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                          TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON SCHEMA DATAWAREHOUSE.SILVERSURFER               TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON SCHEMA DATAWAREHOUSE.YAXXA_DW_REPLICATION       TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER
  TO ROLE SVC_VERCEL_APP_ROLE;

/* If CAMPAIGN_MASTER turns out to be a VIEW rather than a table, the grant
   above fails — use GRANT SELECT ON VIEW instead. 00-discover-columns.sql
   section 2 tells you which it is. */


/* -----------------------------------------------------------------------------
   SECTION 2 — the map table

   The app creates this itself on first use (CREATE TABLE IF NOT EXISTS in
   lib/dialler-campaign-map.ts), so this section is for a fresh environment and
   for the grants, which the app cannot give itself.

   THE PRIMARY KEY IS THE YAXXA CAMPAIGN, NOT THE PAIR. That is what encodes the
   agreed cardinality: one SilverSurfer campaign feeds many Yaxxa campaigns, and
   a Yaxxa campaign belongs to exactly one SilverSurfer campaign. Keying on the
   pair would permit a Yaxxa campaign with two parents, which is the one state
   the whole design exists to prevent.

   Snowflake does not ENFORCE primary keys, so that constraint is documentation
   — 00-discover-columns.sql section 4b is what actually checks it, and the
   screen shows the result as an error banner.

   SS_TITLE and YAXXA_NAME are snapshots taken when the mapping is made. The
   live name always wins for display; these exist so a mapping whose campaign
   has since been deleted still reads as something a person recognises instead
   of a bare id.
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP (
  SS_CAMPAIGNID    VARCHAR       NOT NULL,
  SS_TITLE         VARCHAR,
  YAXXA_CAMPAIGNID VARCHAR       NOT NULL,
  YAXXA_NAME       VARCHAR,
  CREATED_AT       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY       VARCHAR,

  CONSTRAINT PK_TSK_CAMPAIGN_DIALLER_MAP PRIMARY KEY (YAXXA_CAMPAIGNID)
);

GRANT USAGE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION         TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 3 — the view downstream joins to

   The mapping is only worth keeping if something can use it, and a consumer
   should not have to know the app's table layout or re-derive the live names.

   IS_STALE is the point of it. A mapping whose campaign has been deactivated
   still has a row; this lets a report decide for itself whether to trust it
   rather than silently dropping it or silently including it.

   COLUMN NAMES BELOW ASSUME what 00-discover-columns.sql sections 1 and 2
   found. If either source uses different id or name columns, correct the two
   joins and the two IFNULLs — this view is the only SQL that hard-codes them,
   because the app resolves them at run time and a view cannot.
-------------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP
COPY GRANTS
AS
SELECT m.SS_CAMPAIGNID,
       IFNULL(s.TITLE, m.SS_TITLE)                AS SS_TITLE,
       m.YAXXA_CAMPAIGNID,
       IFNULL(y.CAMPAIGN_NAME, m.YAXXA_NAME)      AS YAXXA_NAME,
       (s.CAMPAIGNID IS NULL OR y.CAMPAIGN_ID IS NULL) AS IS_STALE,
       m.CREATED_BY,
       m.CREATED_AT
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_DIALLER_MAP m
  LEFT JOIN DATAWAREHOUSE.SILVERSURFER.CAMP_CAMPAIGN s
    ON CAST(s.CAMPAIGNID AS VARCHAR) = m.SS_CAMPAIGNID
   AND s.ACTIVE = 1
  LEFT JOIN DATAWAREHOUSE.YAXXA_DW_REPLICATION.CAMPAIGN_MASTER y
    ON CAST(y.CAMPAIGN_ID AS VARCHAR) = m.YAXXA_CAMPAIGNID;

GRANT SELECT ON VIEW
  DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP
  TO ROLE SVC_VERCEL_APP_ROLE;

/* Grant it to whichever role your reporting runs as as well — the view is the
   supported way to consume this, and joining to the base table directly means
   re-deriving IS_STALE and the live names in every consumer. */


/* -----------------------------------------------------------------------------
   SECTION 4 — grant people the department

   "dialler" is already a valid department id, so it appears in Settings without
   any SQL here. This is only if you would rather do it directly.

   The department grant is the whole authorisation boundary for this screen:
   anyone holding it can re-point any dialler campaign at any SilverSurfer
   campaign. Every change records CREATED_BY.
-------------------------------------------------------------------------------- */

SELECT AD_EMAIL, CREATED_AT, CREATED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
 WHERE DEPARTMENT = 'dialler'
 ORDER BY AD_EMAIL;


/* -----------------------------------------------------------------------------
   SECTION 5 — confirm

   1. Re-run 00-discover-columns.sql sections 1 and 2. Columns should now list.
   2. Open Dialler → Campaign mapping. The "Where this reads from" card names
      the id and name column resolved on each side — that is the real test that
      the grants worked, because the probe runs as the app's own role.
   3. Attach one campaign, then:

        SELECT * FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_CAMPAIGN_DIALLER_MAP;

      One row, IS_STALE false, both names populated from the live sources.
-------------------------------------------------------------------------------- */
