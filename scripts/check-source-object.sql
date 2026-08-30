-- What the app will actually CALL for this campaign.
--
-- The run reads the LAST SAVED config, so if the Procedure field was edited but
-- not saved, this still returns the old value and the CALL still goes out with
-- no arguments. This query is the ground truth; the form is not.

-- 1. The multi-config table (Settings -> per-config "Run individual steps").
SELECT CONFIG_ID,
       CAMPAIGNID,
       CONFIG_NAME,
       SOURCE_KIND,
       SOURCE_OBJECT,
       -- What buildCall() will emit from that value:
       CASE WHEN SOURCE_OBJECT LIKE '%(%'
            THEN 'CALL ' || SOURCE_OBJECT
            ELSE 'CALL ' || SOURCE_OBJECT || '()'
       END AS STATEMENT_THE_APP_WILL_RUN,
       UPLOAD_TARGET_TABLE,
       IS_ACTIVE
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIGS
WHERE SOURCE_OBJECT ILIKE '%ONAIR_NEW_POOL%'
ORDER BY CAMPAIGNID, CONFIG_ID;

-- 2. The legacy single-config table (the Manual page's run).
SELECT CAMPAIGNID,
       SOURCE_KIND,
       SOURCE_OBJECT,
       CASE WHEN SOURCE_OBJECT LIKE '%(%'
            THEN 'CALL ' || SOURCE_OBJECT
            ELSE 'CALL ' || SOURCE_OBJECT || '()'
       END AS STATEMENT_THE_APP_WILL_RUN,
       UPLOAD_TARGET_TABLE,
       IS_ACTIVE
FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIG
WHERE SOURCE_OBJECT ILIKE '%ONAIR_NEW_POOL%';

-- STATEMENT_THE_APP_WILL_RUN ending in "()" is the bug: the value was never
-- saved with its argument. Fix it in the UI (Settings -> Procedure field, then
-- Save), or directly — set the id this campaign actually needs, not 1 blindly:
--
--   UPDATE DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_CAMPAIGN_AUTOMATION_CONFIGS
--   SET SOURCE_OBJECT = 'DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.SP_ONAIR_NEW_POOL_BR(1)'
--   WHERE CONFIG_ID = <the CONFIG_ID from query 1>;
