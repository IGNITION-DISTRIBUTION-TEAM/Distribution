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

-- Voice / Data Usage by Tenant (per-account CDR usage: MINUTES_USED, MEGS_USED):
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_UC_USAGE                      TO ROLE SVC_VERCEL_APP_ROLE;

-- Retain Users via Free Airtime (monthly reward qty & value from the
-- retentions sub-wallet / free-airtime bundle benefits):
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_SC_TRANSACTION_REPORT         TO ROLE SVC_VERCEL_APP_ROLE;

-- Subscriptions Cohort Analysis (cohort retention / billed-by-channel). Needed
-- to wire this page live; after granting, share the view's columns and the
-- cohort heatmap + channel chart can read from it instead of the snapshot.
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES TO ROLE SVC_VERCEL_APP_ROLE;

-- Commercial section: sources to make the remaining pages live.
-- Recharge revenue / comparisons / projection (pre-aggregated monthly revenue):
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_TELCO_MONTHLY_REVENUE_L13MONTHS        TO ROLE SVC_VERCEL_APP_ROLE;
-- Wastage (never-used SIMs / churn) + active-subs usage detail:
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_ACTIVE_SUBSCRIPTIONS_USAGE_DETAILS      TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_SNU_FOR_ACCOUNTS_35_60_DAYS_OLD_PER_DAY   TO ROLE SVC_VERCEL_APP_ROLE;
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_SNU_FOR_ACCOUNTS_35_60_DAYS_OLD_PER_MONTH TO ROLE SVC_VERCEL_APP_ROLE;
-- Pargo Collections (there IS a Snowflake view for this):
GRANT SELECT ON VIEW UCONNECT_DW.ANALYTICS.VW_PARGO_COLLECTIONS                       TO ROLE SVC_VERCEL_APP_ROLE;

-- Convenience for porting more pages (broad — grant per-object instead if you
-- prefer least privilege):
-- GRANT SELECT ON ALL TABLES  IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON ALL VIEWS   IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON FUTURE TABLES IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
-- GRANT SELECT ON FUTURE VIEWS  IN SCHEMA UCONNECT_DW.ANALYTICS TO ROLE SVC_VERCEL_APP_ROLE;
