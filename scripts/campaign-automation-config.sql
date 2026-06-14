-- Per-campaign automation configuration
--
-- Drives the automated distribution flow for each campaign:
--   * SFTP connection used to pull the campaign's daily upload file
--   * the destination/staging table the uploaded file is loaded into
--   * the Snowflake procedure that syncs the loaded data downstream
--
-- One row per campaign, keyed by CAMPAIGNID (matches CAMPAIGN.CAMPAIGNID in
-- DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN).
--
-- SECURITY NOTE: SFTP_PASSWORD and SFTP_PRIVATE_KEY are stored in plaintext.
-- Anyone with SELECT on this table can read them, and the values appear in
-- Snowflake query history. This was an explicit, accepted trade-off to get the
-- automation working. Restrict GRANTs on this table to the automation role only,
-- and migrate the secrets to a Snowflake SECRET object (or an external vault)
-- when feasible.

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG (
  CAMPAIGNID          NUMBER          NOT NULL,
  CAMPAIGN_TITLE      VARCHAR,                       -- denormalized for display

  -- SFTP source for the campaign's upload file
  SFTP_HOST           VARCHAR,
  SFTP_PORT           NUMBER          DEFAULT 22,
  SFTP_USERNAME       VARCHAR,
  SFTP_PASSWORD       VARCHAR,                        -- plaintext (see note above)
  SFTP_PRIVATE_KEY    VARCHAR,                        -- plaintext (see note above)
  SFTP_REMOTE_PATH    VARCHAR,                        -- directory/file to pull from
  SFTP_AUTH_TYPE      VARCHAR         DEFAULT 'password',  -- 'password' | 'privateKey'

  -- Destination for the uploaded file data
  UPLOAD_TARGET_TABLE VARCHAR,                        -- fully-qualified DATABASE.SCHEMA.NAME

  -- Procedures
  LOAD_HISTORY_PROCEDURE VARCHAR,                     -- proc that loads the stage table into the HLL/history table
  SYNC_PROCEDURE      VARCHAR,                        -- fully-qualified DATABASE.SCHEMA.PROC for the downstream sync

  IS_ACTIVE           BOOLEAN         DEFAULT TRUE,    -- automation runs for this campaign?

  CREATED_AT          TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY          VARCHAR,
  UPDATED_AT          TIMESTAMP_NTZ,
  UPDATED_BY          VARCHAR,

  CONSTRAINT PK_TSK_CAMPAIGN_AUTOMATION_CONFIG PRIMARY KEY (CAMPAIGNID)
);

-- For tables created before LOAD_HISTORY_PROCEDURE existed, add it idempotently.
ALTER TABLE DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG
  ADD COLUMN IF NOT EXISTS LOAD_HISTORY_PROCEDURE VARCHAR;
