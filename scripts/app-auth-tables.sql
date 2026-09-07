/* =============================================================================
   The four tables the sign-in gate depends on
   -----------------------------------------------------------------------------
   Three of them have never had DDL in this repo. APP_USER_EMAIL_MAP,
   APP_SUPER_ADMINS and APP_ALLOWED_ROLES were created out of band in Snowflake;
   only APP_USER_DEPARTMENTS has a script (scripts/user-departments.sql, which
   this follows). That means the app's entire authentication gate could not be
   rebuilt in a fresh environment from this repository — which is the sort of
   thing you discover at the worst possible moment.

   CREATE TABLE IF NOT EXISTS throughout, so this is a NO-OP against the live
   tables and safe to run now. It is documentation that also happens to execute.

   -----------------------------------------------------------------------------
   WHAT EACH ONE DOES, in the order lib/auth-gate.ts checks them

     APP_SUPER_ADMINS       bypasses every check below. The ONLY table where a
                            row alone admits someone with no employee record and
                            no role.
     APP_USER_EMAIL_MAP     AD_EMAIL → EMPLOYEE_EMAIL. MANDATORY for everyone
                            else: it is not an override on top of a direct
                            lookup, it is the only route to the employee table.
                            No row here means no login, and EMPLOYEE_DETAIL is
                            never even queried.
     APP_ALLOWED_ROLES      job titles that may use the app. Keyed on the TITLE,
                            so a row admits everyone holding it.
     APP_USER_DEPARTMENTS   not a gate — what a signed-in person can SEE. No
                            rows means they sign in and the app is empty.

   DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL is an upstream Sage extract and is
   deliberately not created here. The gate reads EMAIL_ADDRESS, JOB_TITLE and
   EMPLOYEE_STATUS_DISPLAY from it, and matches active on
   `UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'`.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 1 — the tables

   The column sets are inferred from the queries the app actually runs
   (app/api/admin/email-map/route.ts, super-admins/route.ts,
   allowed-roles/route.ts and lib/auth-gate.ts) rather than from a dump of the
   live tables. If a live table carries a column the app never reads, it will
   not be here — which is the right way round for a rebuild, but worth knowing
   before treating this as a faithful copy. Section 3 compares the two.
-------------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS (
  AD_EMAIL    VARCHAR         NOT NULL,
  CREATED_AT  TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY  VARCHAR,

  CONSTRAINT PK_APP_SUPER_ADMINS PRIMARY KEY (AD_EMAIL)
);

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP (
  AD_EMAIL        VARCHAR         NOT NULL,
  EMPLOYEE_EMAIL  VARCHAR         NOT NULL,
  CREATED_AT      TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY      VARCHAR,

  -- AD_EMAIL alone, deliberately. One person may sign in from several AD
  -- addresses, all pointing at one employee record — that is the intended shape
  -- and it is how someone whose AD domain differs from their HR domain gets in.
  -- The reverse is not meaningful: one AD identity is one person.
  CONSTRAINT PK_APP_USER_EMAIL_MAP PRIMARY KEY (AD_EMAIL)
);

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES (
  ROLE        VARCHAR         NOT NULL,
  CREATED_AT  TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY  VARCHAR,

  CONSTRAINT PK_APP_ALLOWED_ROLES PRIMARY KEY (ROLE)
);

-- Already in scripts/user-departments.sql; repeated so this file is the whole
-- gate in one place. Identical definition.
CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS (
  AD_EMAIL    VARCHAR         NOT NULL,
  DEPARTMENT  VARCHAR         NOT NULL,
  CREATED_AT  TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY  VARCHAR,

  CONSTRAINT PK_APP_USER_DEPARTMENTS PRIMARY KEY (AD_EMAIL, DEPARTMENT)
);


/* -----------------------------------------------------------------------------
   SECTION 2 — grants

   SVC_VERCEL_APP_ROLE. The app reads all four on the sign-in path and writes
   three of them from the admin screens (Settings → Map user, Super admins,
   Allowed roles, User departments), all of which are super-admin only.

   NOTE ON SNOWFLAKE PRIMARY KEYS: they are metadata, NOT enforced. Declaring
   PK above documents the intent and does nothing at runtime — Snowflake will
   happily accept a duplicate AD_EMAIL. Section 3 is therefore not optional
   paranoia; it is the only thing that actually checks.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE                  TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA DATAWAREHOUSE.LEADS_DISTRIBUTION TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS
  TO ROLE SVC_VERCEL_APP_ROLE;

-- Read-only on the HR extract. The gate only ever SELECTs from it.
GRANT USAGE ON SCHEMA DATAWAREHOUSE.HR_SAGE_DATA       TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON TABLE
  DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
  TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 3 — is AD_EMAIL actually unique in the live table?

   WORTH RUNNING EVEN THOUGH IT SOUNDS PEDANTIC. The email-map API upserts with

     MERGE ... ON LOWER(t.AD_EMAIL) = LOWER(s.AD_EMAIL)

   which assumes one row per AD_EMAIL, and the sign-in gate reads it with a bare
   SELECT and takes `mapping[0]`. Nothing enforces that assumption: the tables
   pre-date this file, Snowflake does not enforce primary keys, and the case
   folding means 'A@x.com' and 'a@x.com' are two rows that collide as one.

   A duplicate is not a crash — it is worse. The gate silently picks whichever
   row comes back first, so a person's access depends on row order, and a stale
   mapping to a leaver's record can shadow a correct one.

   An empty result from each of these is the answer you want.
-------------------------------------------------------------------------------- */

SELECT LOWER(AD_EMAIL) AS AD_EMAIL, COUNT(*) AS ROWS_FOUND,
       LISTAGG(EMPLOYEE_EMAIL, ' | ') AS MAPS_TO
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP
 GROUP BY 1
HAVING COUNT(*) > 1
 ORDER BY ROWS_FOUND DESC;

SELECT LOWER(AD_EMAIL) AS AD_EMAIL, COUNT(*) AS ROWS_FOUND
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS
 GROUP BY 1 HAVING COUNT(*) > 1;

SELECT UPPER(TRIM(ROLE)) AS ROLE, COUNT(*) AS ROWS_FOUND
  FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES
 GROUP BY 1 HAVING COUNT(*) > 1;

/* IF THE FIRST QUERY RETURNS ANYTHING, decide which EMPLOYEE_EMAIL is correct
   and delete the rest — then re-run. I have deliberately NOT written that
   DELETE: which mapping is right is a judgement about a real person's access,
   and a scripted "keep the newest" would be a guess.

   Adding a genuine constraint to a populated table is a separate decision and
   is not attempted here. In Snowflake it would not enforce anything anyway;
   the real fix, if duplicates turn out to be common, is a uniqueness check
   inside the email-map route before the MERGE. */


/* -----------------------------------------------------------------------------
   SECTION 4 — does the live shape match this file?

   Anything listed here is a column the live table has that section 1 does not
   declare, so a fresh environment built from this script would differ from
   production. Expect nothing; investigate anything.
-------------------------------------------------------------------------------- */

SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'LEADS_DISTRIBUTION'
   AND TABLE_NAME IN ('APP_SUPER_ADMINS', 'APP_USER_EMAIL_MAP',
                      'APP_ALLOWED_ROLES', 'APP_USER_DEPARTMENTS')
   AND COLUMN_NAME NOT IN ('AD_EMAIL', 'EMPLOYEE_EMAIL', 'ROLE', 'DEPARTMENT',
                           'CREATED_AT', 'CREATED_BY')
 ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- And the three columns of EMPLOYEE_DETAIL the gate depends on. If any is
-- missing or renamed upstream, sign-in fails for everyone at once — this is
-- the query to run first when that happens.
SELECT COLUMN_NAME, DATA_TYPE
  FROM DATAWAREHOUSE.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = 'HR_SAGE_DATA'
   AND TABLE_NAME   = 'EMPLOYEE_DETAIL'
   AND COLUMN_NAME IN ('EMAIL_ADDRESS', 'JOB_TITLE', 'EMPLOYEE_STATUS_DISPLAY')
 ORDER BY COLUMN_NAME;

/* THAT LAST QUERY SHOULD RETURN EXACTLY THREE ROWS. Fewer means the extract has
   changed shape and the gate is reading a column that no longer exists —
   checkAccess would then throw, and the login screen would show "the access
   check against the database failed" for every single user.

   To unblock a person while that is being fixed: a row in APP_SUPER_ADMINS is
   the only path that does not touch EMPLOYEE_DETAIL at all. Use it for the
   emergency, not as the fix. */
