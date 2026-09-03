/* =============================================================================
   TASK AUTOMATION — grants for SVC_VERCEL_APP_ROLE
   -----------------------------------------------------------------------------
   Everything the Task Automation department does runs as SVC_VERCEL_APP_ROLE.
   The app creates the stage, the tables, the sync procedure and the task
   itself — there is no copy-into-a-worksheet step and no second role.

   Run this ONCE, as ACCOUNTADMIN, before using the department.

   -----------------------------------------------------------------------------
   WHAT THIS ACTUALLY HANDS OVER, SAID PLAINLY

   Section 2 gives a web application's role the ability to CREATE PROCEDURE and
   CREATE TASK. That is a code-execution path: anything that can write a config
   row can, in principle, cause code to be created and scheduled. It is a
   reasonable trade for a self-service ETL builder, but it is only safe because
   of three things, and all three have to stay true:

     1. CREATE is granted on exactly ONE schema (section 2). Not on the
        database, not on DATAWAREHOUSE, not with FUTURE SCHEMAS. If you widen
        this, you widen what a bug in the generator can produce.
     2. The app validates every identifier it emits against ^[A-Za-z0-9_]+$ and
        REJECTS anything else. It never quotes or escapes a bad name — a name
        that needs escaping is refused.
     3. The app checks the target schema against an allow-list before emitting
        any DDL.

   Objects the role creates are OWNED by it, so the generated procedures run
   EXECUTE AS OWNER with this role's rights — which is narrower than the
   ACCOUNTADMIN-owned procedures the current standard produces. That part is an
   improvement, not a compromise.

   -----------------------------------------------------------------------------
   BEFORE YOU RUN IT — three names have to be confirmed

   The working SP_SPOT_SFTP_INGEST procedure and Justin's standards document
   name DIFFERENT objects for the same SFTP host:

       working script      SPOT_SFTP_ACCESS, SPOT_SFTP_PRIVATE_KEY,
                           SPOT_SFTP_KEY_PASSPHRASE, user ignition_snowflake_sync
       standards doc       EAI_SFTP_SPOT, SECRET_SFTP_SPOT_PRIVATE_KEY,
                           user Hevo

   We are using the working script's objects. They are referenced unqualified in
   that procedure, so their database and schema are not knowable from the source
   — section 0 finds them. Do not guess: a GRANT against a name that does not
   exist fails with "does not exist or not authorized", which reads exactly like
   a privilege problem and will send you round in circles.
============================================================================= */


/* -----------------------------------------------------------------------------
   SECTION 0 — discover the real names. Run this first and read the output.
-------------------------------------------------------------------------------- */

-- The external access integration. Expect SPOT_SFTP_ACCESS; note whether
-- EAI_SFTP_SPOT also exists, because then there are two and they may point at
-- different network rules.
SHOW INTEGRATIONS LIKE '%SFTP%';

-- The secrets, fully qualified. The "name", "database_name" and "schema_name"
-- columns are what sections 4 needs.
SHOW SECRETS IN ACCOUNT;

-- The warehouse the task will run on. The standards doc suggests SPOT_WH for
-- Spot workloads.
SHOW WAREHOUSES;

-- Confirm the control table exists and you can see it.
SHOW TABLES LIKE 'SFTP_SYNC_CONTROL' IN DATABASE DATAWAREHOUSE;

-- What the role holds today, so you can diff afterwards.
SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 1 — warehouse

   OPERATE as well as USAGE: a task owned by this role cannot run on a warehouse
   the role may only use. Missing OPERATE shows up as a task that stays in
   "scheduled" and never executes, with nothing in the error column.
-------------------------------------------------------------------------------- */

GRANT USAGE, OPERATE ON WAREHOUSE <<WH>> TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 2 — the ONE schema the app may create objects in

   This is the security boundary. Grant it on this schema and no other.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE SPOT_DW           TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

GRANT CREATE TABLE,
      CREATE STAGE,
      CREATE FILE FORMAT,
      CREATE PROCEDURE,
      CREATE TASK,
      CREATE VIEW
  ON SCHEMA SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

/* CREATE TABLE covers TRANSIENT tables — there is no separate privilege, so the
   STG_ staging tables need nothing extra. */


/* -----------------------------------------------------------------------------
   SECTION 3 — tasks

   EXECUTE TASK is an ACCOUNT-level privilege, not a schema one. Without it the
   task is created but can never be resumed, and ALTER TASK ... RESUME fails
   with a privilege error that does not name the missing grant.

   EXECUTE MANAGED TASK is only needed for SERVERLESS tasks (a task with no
   WAREHOUSE clause). The generator names a warehouse, so this is here for the
   case where you later switch to serverless. Drop the line if you would rather
   not grant it.
-------------------------------------------------------------------------------- */

GRANT EXECUTE TASK         ON ACCOUNT TO ROLE SVC_VERCEL_APP_ROLE;
GRANT EXECUTE MANAGED TASK ON ACCOUNT TO ROLE SVC_VERCEL_APP_ROLE;


/* -----------------------------------------------------------------------------
   SECTION 4 — external access and the SFTP secrets

   Needed BOTH to create the Python procedure and for it to run. A missing READ
   on a secret fails at CREATE PROCEDURE time with a message about the secret;
   a missing USAGE on the integration fails with a message about the
   integration. Neither mentions this file, so grant both.

   Substitute the database and schema that SHOW SECRETS reported in section 0.
-------------------------------------------------------------------------------- */

GRANT USAGE ON INTEGRATION SPOT_SFTP_ACCESS TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON SCHEMA <<SECRET_DB>>.<<SECRET_SCHEMA>> TO ROLE SVC_VERCEL_APP_ROLE;

GRANT READ ON SECRET <<SECRET_DB>>.<<SECRET_SCHEMA>>.SPOT_SFTP_PRIVATE_KEY
  TO ROLE SVC_VERCEL_APP_ROLE;

GRANT READ ON SECRET <<SECRET_DB>>.<<SECRET_SCHEMA>>.SPOT_SFTP_KEY_PASSPHRASE
  TO ROLE SVC_VERCEL_APP_ROLE;

/* READ on a secret does NOT let the app read the key. The role can name the
   secret in a procedure definition; only the procedure body, running inside
   Snowflake, can call _snowflake.get_generic_secret_string(). The key never
   reaches the application. That is the whole reason SFTP browsing goes through
   a Snowflake procedure instead of the app connecting directly. */


/* -----------------------------------------------------------------------------
   SECTION 5 — the shared control table

   Every sync in the account reports into this one table, which is also what the
   monitor screen reads. UPDATE as well as INSERT: the procedure writes
   BASELINE_SET on registration and then updates LAST_MODIFIED / STATUS on every
   run.
-------------------------------------------------------------------------------- */

GRANT USAGE ON DATABASE DATAWAREHOUSE    TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   DATAWAREHOUSE.DW TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE ON TABLE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
  TO ROLE SVC_VERCEL_APP_ROLE;

/* Deliberately no DELETE. Removing a sync's control row loses its change-
   detection baseline and would silently cause a full re-load on the next run. */


/* -----------------------------------------------------------------------------
   SECTION 6 — objects in that schema created by SOMEONE ELSE

   The role owns what it creates and needs no grant for those. This section is
   for the 21 legacy Hevo tables already in SPOT_SFTP and anything Justin adds
   later — without it, a sync targeting an existing table cannot write to it.
-------------------------------------------------------------------------------- */

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES
  IN SCHEMA SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES
  IN SCHEMA SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

GRANT USAGE ON FUTURE PROCEDURES
  IN SCHEMA SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

GRANT READ, WRITE ON FUTURE STAGES
  IN SCHEMA SPOT_DW.SPOT_SFTP TO ROLE SVC_VERCEL_APP_ROLE;

/* FUTURE grants do not apply retroactively, hence the ALL TABLES line above.
   There is no ON ALL STAGES / ON ALL PROCEDURES equivalent worth running here,
   because every stage and procedure this feature uses will be created by this
   role and therefore owned by it. */


/* -----------------------------------------------------------------------------
   SECTION 7 — loading into a target OUTSIDE SPOT_DW.SPOT_SFTP

   The app refuses to CREATE objects anywhere but the allow-listed schema, but a
   sync may legitimately load into an existing table elsewhere. Grant per
   target, not per database, and add the schema to the app's allow-list at the
   same time:

     GRANT USAGE ON DATABASE <<DB>>                        TO ROLE SVC_VERCEL_APP_ROLE;
     GRANT USAGE ON SCHEMA   <<DB>>.<<SCHEMA>>             TO ROLE SVC_VERCEL_APP_ROLE;
     GRANT SELECT, INSERT, UPDATE, DELETE
       ON TABLE <<DB>>.<<SCHEMA>>.<<TABLE>>                TO ROLE SVC_VERCEL_APP_ROLE;
-------------------------------------------------------------------------------- */


/* -----------------------------------------------------------------------------
   SECTION 8 — verify, from the APP's session and not this worksheet

   A worksheet tells you about YOUR access. Everything above is about the app's.

     /api/distribution/snowflake-identity
       → session.role must be SVC_VERCEL_APP_ROLE. If it is anything else, every
         grant above went to a role the app does not use and none of this took
         effect.

   Then re-run the diff:
-------------------------------------------------------------------------------- */

SHOW GRANTS TO ROLE SVC_VERCEL_APP_ROLE;

SELECT "privilege", "granted_on", "name"
  FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
 WHERE "granted_on" IN ('SCHEMA', 'WAREHOUSE', 'INTEGRATION', 'SECRET', 'ACCOUNT')
 ORDER BY "granted_on", "name";
