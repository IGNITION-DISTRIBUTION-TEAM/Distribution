-- Per-user department access grants.
--
-- Each row grants one AD (login) email access to one department. A user sees
-- only the departments they have rows for. Super admins bypass this and see
-- all departments. DEPARTMENT must be a known id (currently 'distribution' or
-- 'dialler').

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS (
  AD_EMAIL    VARCHAR         NOT NULL,
  DEPARTMENT  VARCHAR         NOT NULL,
  CREATED_AT  TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY  VARCHAR,

  CONSTRAINT PK_APP_USER_DEPARTMENTS PRIMARY KEY (AD_EMAIL, DEPARTMENT)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
  TO ROLE SVC_VERCEL_APP_ROLE;
