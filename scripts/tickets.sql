-- Ticket system tables in DATAWAREHOUSE.LEADS_DISTRIBUTION.
--
-- The app creates both tables on first use (CREATE TABLE IF NOT EXISTS) using
-- the CREATE TABLE grant from scripts/spot-arpu.sql, so if the app role already
-- has USAGE + CREATE TABLE on this schema, nothing here is strictly required.
-- Run this only if you prefer to pre-create the tables under a different owner
-- — in that case the DML grants at the bottom ARE required.
--
-- Definitions must match ensureTicketTables() in lib/tickets-server.ts.

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS (
  TICKET_ID         VARCHAR,        -- UUID, primary handle used by the app
  TICKET_REF        VARCHAR,        -- human-friendly reference (TKT-...)
  STATUS            VARCHAR,        -- Received / In Progress / On Hold / Completed / Rejected
  REQUEST_TYPE      VARCHAR,        -- promoted from answers for reporting
  URGENCY           VARCHAR,        -- promoted from answers for reporting/SLA
  SLA_DUE_AT        TIMESTAMP_NTZ,  -- created + SLA hours for the chosen urgency
  ASSIGNED_TO       VARCHAR,
  FIELDS            VARCHAR,        -- JSON of all form answers (form is customizable)
  CREATED_BY_NAME   VARCHAR,
  CREATED_BY_EMAIL  VARCHAR,
  CREATED_AT        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_BY        VARCHAR,
  UPDATED_AT        TIMESTAMP_NTZ
);

-- Append-only form definition; the newest row is the live form.
CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS_FORM_CONFIG (
  CONFIG_JSON  VARCHAR,
  UPDATED_BY   VARCHAR,
  UPDATED_AT   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Requesting business departments (managed on the Tickets > Departments page).
-- Each active row gets a capture link at /tickets/log/<slug>. "Removing" a
-- department sets ACTIVE = FALSE (soft delete) so its tickets keep context.
CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS_DEPARTMENTS (
  NAME        VARCHAR,
  SLUG        VARCHAR,
  ACTIVE      BOOLEAN,
  CREATED_BY  VARCHAR,
  CREATED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Only needed when the tables are owned by the role running this script rather
-- than the app role. Replace SVC_VERCEL_APP_ROLE if the app uses another role.
GRANT SELECT, INSERT, UPDATE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS_FORM_CONFIG
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TICKETS_DEPARTMENTS
  TO ROLE SVC_VERCEL_APP_ROLE;
