import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

// Subscription sales by channel — the OKR page's "7 DAY SUBSCRIPTIONS" source,
// lifted verbatim from the PBI map (docs/telco-pbi-page-table-map.md) and
// aggregated to channel level (yesterday count + per-working-day 7-day avg).
const SQL = `
WITH
AppData AS (
    SELECT CAST(ACTIVATIONDATE AS DATE) AS sales_date, 'App' AS sales_channel,
           'App' AS CAMPAIGNNAME, MANDATEREFERENCE AS sale_id
    FROM UCONNECT_DW.ANALYTICS.VW_UCONNECT_SUBSCRIPTIONS
    WHERE MANDATETYPE = 'App'
      AND COALESCE(POSITION('RETAIL_PROMOTIONS' IN EXTERNALREFERENCE), 0) = 0
),
OtherSales AS (
    SELECT CAST(SALESDATE AS DATE) AS sales_date,
        CASE
            WHEN CAMPAIGNNAME IN ('Uconnect Upsell', 'UConnect Triplesave')
                 OR CAMPAIGNNAME ILIKE '%Breakfree%' THEN 'Telesales'
            WHEN CAMPAIGNNAME IN ('DigiM Resells') OR CAMPAIGNNAME ILIKE '%Mobile Store%' THEN 'Inbound'
            WHEN CAMPAIGNNAME = 'Digital UConnect Upsell' THEN 'Whatsapp'
            ELSE 'Other'
        END AS sales_channel,
        CAMPAIGNNAME, ORDERREFERENCE AS sale_id
    FROM UCONNECT_DW.ANALYTICS.VW_SILVER_SURFER_SALES_SIM_INFO
    WHERE SALESDATE >= DATEADD(day, -7, CURRENT_DATE())
),
RetailSales AS (
    SELECT CAST(ACTIVATIONDATE AS DATE) AS sales_date, 'Retail' AS sales_channel,
           'Uconnect VAS Instore' AS CAMPAIGNNAME, MANDATEREFERENCE AS sale_id
    FROM UCONNECT_DW.ANALYTICS.VW_UCONNECT_SUBSCRIPTIONS
    WHERE EXTERNALREFERENCE ILIKE '%RETAIL_PROMOTIONS%'
),
AllSales AS (
    SELECT * FROM AppData UNION ALL SELECT * FROM OtherSales UNION ALL SELECT * FROM RetailSales
),
YesterdayAgg AS (
    SELECT sales_channel, CAMPAIGNNAME,
        CASE WHEN sales_channel IN ('App','Retail') THEN COUNT(DISTINCT sale_id) ELSE COUNT(*) END AS sales_yesterday
    FROM AllSales WHERE sales_date = CURRENT_DATE - 1 GROUP BY sales_channel, CAMPAIGNNAME
),
Last7Agg AS (
    SELECT sales_channel, CAMPAIGNNAME,
        CASE WHEN sales_channel IN ('App','Retail') THEN COUNT(DISTINCT sale_id) ELSE COUNT(*) END AS row_count_last7
    FROM AllSales WHERE sales_date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE - 1 GROUP BY sales_channel, CAMPAIGNNAME
),
PerCampaign AS (
    SELECT
        COALESCE(y.sales_channel, l.sales_channel) AS sales_channel,
        COALESCE(y.sales_yesterday, 0) AS sales_yesterday,
        CASE WHEN COALESCE(y.sales_channel, l.sales_channel) IN ('App','Retail')
             THEN ROUND(l.row_count_last7 / 7.0, 2) ELSE ROUND(l.row_count_last7 / 5.0, 2) END AS last7_avg
    FROM Last7Agg l
    LEFT JOIN YesterdayAgg y ON y.sales_channel = l.sales_channel AND y.CAMPAIGNNAME = l.CAMPAIGNNAME
)
SELECT sales_channel AS CHANNEL,
       SUM(sales_yesterday) AS YESTERDAY,
       ROUND(SUM(last7_avg), 1) AS LAST7_AVG
FROM PerCampaign GROUP BY sales_channel ORDER BY YESTERDAY DESC`

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{ CHANNEL: string; YESTERDAY: number | string; LAST7_AVG: number | string }>(
      SQL,
      SF_OPTS
    )
    const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)
    const channels = rows.map((r) => ({
      channel: String(r.CHANNEL ?? ""),
      yesterday: num(r.YESTERDAY),
      last7avg: num(r.LAST7_AVG),
    }))

    // Target from the uploaded income statement's Goal sheet (may be null when
    // the target cells are blank). Cross-DB read of the financials table.
    let targetPerDay: number | null = null
    try {
      const t = await executeSnowflakeQuery<{ V: number | string }>(
        `SELECT VALUE AS V FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_TELCO_FINANCIALS
         WHERE SHEET = 'Goal sheet' AND LOWER(DETAIL) LIKE '%subscription sales per day%'
         ORDER BY PERIOD DESC LIMIT 1`,
        { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }
      )
      if (t.length) targetPerDay = num(t[0].V)
    } catch {
      // Financials table may not exist yet / no upload — leave target null.
    }

    return NextResponse.json({ channels, hasData: channels.length > 0, targetPerDay })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/okr] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
