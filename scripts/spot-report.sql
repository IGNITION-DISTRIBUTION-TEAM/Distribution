-- Grants so the app's service role can run the Spot Report live queries, which
-- read from UCONNECT_DW.ANALYTICS (a different database than the app's usual
-- DATAWAREHOUSE). Currently only the "Sales Trends" page is live; it reads
-- UCONNECT_MAY_MERGE. Add more object grants here as further pages are ported
-- (see docs/telco-pbi-page-table-map.md for each page's sources).
--
-- Run as a role that can grant on UCONNECT_DW. Replace SVC_VERCEL_APP_ROLE if
-- the app connects as a different role (SNOWFLAKE_ROLE env var).

GRANT USAGE ON DATABASE UCONNECT_DW                 TO ROLE SVC_VERCEL_APP_ROLE;
GRANT USAGE ON SCHEMA   UCONNECT_DW.ANALYTICS        TO ROLE SVC_VERCEL_APP_ROLE;

-- Sales Trends + SIM activations source:
GRANT SELECT ON TABLE UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE TO ROLE SVC_VERCEL_APP_ROLE;

-- OKR Scorecard (subscription sales by channel) sources:
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_UCONNECT_SUBSCRIPTIONS        TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_SILVER_SURFER_SALES_SIM_INFO  TO ROLE SVC_VERCEL_APP_ROLE;

-- Convenience for porting more pages (broad — grant per-object instead if you
-- prefer least privilege):
-- GRANT SELECT ON ALL TABLES  IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON ALL VIEWS   IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON FUTURE TABLES IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON FUTURE VIEWS  IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
