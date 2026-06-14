-- Master list of "update HLL" stored procedures.
--
-- Each row is a procedure that takes the campaign id as its single argument and
-- updates the HLL/history table: CALL <PROC_NAME>(<campaignid>). Step 4 of the
-- manual distribution flow runs one of these — either the one assigned to the
-- campaign (TSK_CAMPAIGN_AUTOMATION_CONFIG.UPDATE_HLL_PROCEDURE) or an override
-- picked from this list. Keeping the list in a table means the app only ever
-- CALLs a vetted procedure.

CREATE TABLE IF NOT EXISTS DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_HLL_UPDATE_PROCEDURES (
  PROC_INDEX   NUMBER          NOT NULL,
  PROC_NAME    VARCHAR         NOT NULL,             -- fully-qualified DATABASE.SCHEMA.PROC
  CREATED_AT   TIMESTAMP_NTZ   DEFAULT CURRENT_TIMESTAMP(),

  CONSTRAINT PK_TSK_HLL_UPDATE_PROCEDURES PRIMARY KEY (PROC_INDEX)
);
