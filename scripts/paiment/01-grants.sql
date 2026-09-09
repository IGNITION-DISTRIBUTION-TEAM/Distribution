/* =============================================================================
   Paiment — grants and the audit table
   -----------------------------------------------------------------------------
   The app writes the billing product mapping straight into the BI table. That
   was a deliberate decision; this file provisions it and provisions the guard
   that makes its one real risk detectable.

   RUN 00-resolve-and-diagnose.sql SECTION 1 FIRST. The table name below is the
   conventional shape, not a verified fact — correct it here and in
   PRODUCT_MAPPING in lib/billing-mappings.ts if the resolve says otherwise.
   Everything else follows from those two names.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — let the app read and write the mapping

   Run as ACCOUNTADMIN. Safe to re-run.

   THIS IS A WIDER GRANT THAN THE APP HOLDS ANYWHERE ELSE. Everything the app
   writes today lives in DATAWAREHOUSE.LEADS_DISTRIBUTION, its own schema. This
   puts INSERT, UPDATE and DELETE on a table in BI — a schema owned by Data
   Engineering and read by executive reporting — into the hands of anyone
   granted the Paiment department.

   That is the shape you asked for, and it is workable, but it is worth being
   explicit about what it means:

     - a wrong value here changes reported revenue attribution, silently
     - a DELETE here reverts a product to campaign-based attribution, silently
     - if this table is ever reloaded from a file, that load wins and the
       business's edits vanish, silently

   The mitigations are all in section 2 and in the app: every write is mirrored
   to an audit table in the app's own schema, deletes need an explicit
   confirmation, and the screen compares the two on every load.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE      TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.BI     TO ROLE SVC_VERCEL_APP_ROLE;

-- The table the app edits.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  DATAWAREHOUSE.BI.BI_BILLING_PRODUCTGROUPS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The view over it, which the diagnostics read.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Read-only on the full history, for the diagnose script's view-vs-table
-- comparison and the "sold but unmapped" list. The app never writes here.
GRANT USAGE ON SCHEMA DATAWAREHOUSE.BI_SANCTION TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW
  DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.BI_SANCTION.BI_SANCTION_BILLINGDATA_FULL_HISTORY
  TO ROLE SVC_VERCEL_APP_ROLE;

-- The other two mappings, read-only for now. The Paiment screen will expose
-- them in a later pass; granting SELECT now costs nothing and lets the
-- diagnostics reason about the campaign fallback.
GRANT SELECT ON VIEW
  DATAWAREHOUSE.BI.VW_BI_BILLING_CHANNELCLASSIFICATION
  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW
  DATAWAREHOUSE.BI.VW_BI_BILLING_UNPAIDREASONS
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 2 — the audit table

   In LEADS_DISTRIBUTION, NOT in BI, and that placement is the entire point: a
   reload of the BI table cannot touch it. So "the business's edits disappeared"
   becomes a query rather than an argument, and because AFTER_JSON holds the
   whole intended row the mapping can be replayed from the log instead of being
   re-keyed from a spreadsheet.

   The app creates this itself on first write (CREATE TABLE IF NOT EXISTS in
   lib/billing-mappings.ts), so this section is here for a fresh environment and
   for the grants, which the app cannot give itself.
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_BILLING_MAPPING_AUDIT (
  AUDIT_ID      NUMBER AUTOINCREMENT START 1 INCREMENT 1,
  ACTION        VARCHAR       NOT NULL,   -- create | update | delete | import
  PRODUCT_NAME  VARCHAR       NOT NULL,
  BEFORE_JSON   VARCHAR,                  -- null on a create
  AFTER_JSON    VARCHAR,                  -- null on a delete
  CHANGED_BY    VARCHAR       NOT NULL,
  CHANGED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

GRANT USAGE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT, INSERT ON TABLE
  DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_BILLING_MAPPING_AUDIT
  TO ROLE SVC_VERCEL_APP_ROLE;

/* NO UPDATE AND NO DELETE ON THE AUDIT TABLE, deliberately. An append-only log
   is worth having; one the app can rewrite is not. */


/* -----------------------------------------------------------------------------
   SECTION 3 — grant people the department

   Access is per user in Settings, same as every other department. "paiment" is
   now a valid department id, so it appears in the picker there without any
   further SQL — this is here only if you would rather do it directly.

   The department grant is the whole authorisation boundary for this screen:
   anyone holding it can change any product's channel and brand. Grant it to the
   billing people who own the mapping, not to everyone who wants to look.
-------------------------------------------------------------------------------- */

-- INSERT INTO DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
--   (AD_EMAIL, DEPARTMENT, CREATED_BY)
-- SELECT LOWER(TRIM('firstname.lastname@ignitiongroup.co.za')), 'paiment', CURRENT_USER()
--  WHERE NOT EXISTS (
--    SELECT 1 FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
--     WHERE LOWER(AD_EMAIL) = LOWER(TRIM('firstname.lastname@ignitiongroup.co.za'))
--       AND DEPARTMENT = 'paiment');

-- Who has it now:
SELECT AD_EMAIL, CREATED_AT, CREATED_BY
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
 WHERE DEPARTMENT = 'paiment'
 ORDER BY AD_EMAIL;


/* -----------------------------------------------------------------------------
   SECTION 4 — confirm the app can actually reach it

   INFORMATION_SCHEMA shows only what the CURRENT role can see, so run this as
   ACCOUNTADMIN and it tells you what exists — not what the app can reach. The
   definitive test is the app's own session:

     /api/distribution/snowflake-identity?object=DATAWAREHOUSE.BI.BI_BILLING_PRODUCTGROUPS

   and then simply opening the Paiment screen. A missing grant surfaces there as
   a message naming this file, rather than as a raw Snowflake error.
-------------------------------------------------------------------------------- */

SHOW GRANTS ON TABLE DATAWAREHOUSE.BI.BI_BILLING_PRODUCTGROUPS;
SHOW GRANTS ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_BILLING_MAPPING_AUDIT;
