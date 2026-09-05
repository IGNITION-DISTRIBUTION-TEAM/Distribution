"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { SpotReportSalesTrends } from "@/components/spot-report-sales-trends"
import { SpotReportSimActivations } from "@/components/spot-report-sim-activations"
import { SpotReportExco } from "@/components/spot-report-exco"
import { SpotReportFinancialsUpload } from "@/components/spot-report-financials-upload"
import { SpotReportConnectBook } from "@/components/spot-report-connect-book"
import { SpotReportOkr } from "@/components/spot-report-okr"
import { SpotReportOkrTrends } from "@/components/spot-report-okr-trends"
import { SpotReportRevenueTrends } from "@/components/spot-report-revenue-trends"
import { SpotReportVoiceUsage } from "@/components/spot-report-voice-usage"
import { SpotReportDataUsage } from "@/components/spot-report-data-usage"
import { SpotReportRetainUsers } from "@/components/spot-report-retain-users"
import { SpotReportQualityOfSales } from "@/components/spot-report-quality-of-sales"
import { SpotReportTradingStoreTrend } from "@/components/spot-report-trading-store-trend"
import { SpotReportScorecards } from "@/components/spot-report-scorecards"
import { SpotReportPipelineCommissions } from "@/components/spot-report-pipeline-commissions"
import { SpotReportPipelineUpload } from "@/components/spot-report-pipeline-upload"
import { SpotReportSubscriptions } from "@/components/spot-report-subscriptions"
import { SpotReportCohort } from "@/components/spot-report-cohort"
import { SpotReportCommercialCohort } from "@/components/spot-report-commercial-cohort"
import { SpotReportWastage } from "@/components/spot-report-wastage"
import { SpotReportRechargeQty } from "@/components/spot-report-recharge-qty"
import { SpotReportRechargeTrend } from "@/components/spot-report-recharge-trend"
import { SpotReportRechargeRevenue } from "@/components/spot-report-recharge-revenue"
import { SpotReportRevenueComparisons } from "@/components/spot-report-revenue-comparisons"
import { SpotReportPrepaidProjection } from "@/components/spot-report-prepaid-projection"
import { SpotReportPlaceholder } from "@/components/spot-report-placeholder"

// The Spot Report reports are the static Telco Retail pages served from
// public/spot-report/pages/ (gated by middleware). Navigation lives in the app
// sidebar (portal design); the selected report renders in the content area.
// `page` is the file under public/spot-report/pages/, or null for a pending
// (not-yet-built) report.
// `native` is a key selecting an in-app React page; when unset the page is
// shown via the static iframe.
type Report = { label: string; page: string | null; indent?: boolean; header?: boolean; native?: string; adminOnly?: boolean }

/**
 * A report's identity for the nav. Before this, "which report is active" was
 * the (label, native, page) triple compared field by field. The native key is
 * unique where present, the page file where not; an unbuilt report is
 * identified by its label since it has nothing else.
 */
function reportId(r: Report): string {
  return r.native ?? r.page ?? `soon-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
}

function renderNative(key: string): React.ReactNode {
  switch (key) {
    case "sales-trends":
      return <SpotReportSalesTrends />
    case "sim":
      return <SpotReportSimActivations />
    case "exco":
      return <SpotReportExco />
    case "connect-book":
      return <SpotReportConnectBook />
    case "okr-scorecard":
      return <SpotReportOkr />
    case "okr-trends":
      return <SpotReportOkrTrends />
    case "revenue-trends":
      return <SpotReportRevenueTrends />
    case "voice-usage":
      return <SpotReportVoiceUsage />
    case "data-usage":
      return <SpotReportDataUsage />
    case "retain-users":
      return <SpotReportRetainUsers />
    case "quality-of-sales":
      return <SpotReportQualityOfSales />
    case "trading-store-trend":
      return <SpotReportTradingStoreTrend />
    case "scorecards":
      return <SpotReportScorecards />
    case "pipeline-commissions":
      return <SpotReportPipelineCommissions />
    case "pipeline-upload":
      return <SpotReportPipelineUpload />
    case "subs-telesales":
      return <SpotReportSubscriptions file="14_subscriptions_telesales.json" title="Subscriptions — Telesales" channel="Telesales" liveChannel="Telesales" />
    case "subs-app":
      return <SpotReportSubscriptions file="44_subscriptions_app.json" title="Subscriptions — App" channel="App" liveChannel="App" variant="app" />
    case "subs-whatsapp":
      return <SpotReportSubscriptions file="45_subscriptions_whatsapp.json" title="Subscriptions — WhatsApp" channel="WhatsApp" liveChannel="Whatsapp" />
    case "subs-btl":
      return <SpotReportSubscriptions file="46_subscriptions_below_the_line.json" title="Subscriptions — Below the Line" channel="Below-the-line" />
    case "subs-mobile":
      return <SpotReportSubscriptions file="47_subscriptions_mobile_store.json" title="Subscriptions — Mobile Store" channel="Mobile Store" liveChannel="Mobile Store" />
    case "subs-digim":
      return <SpotReportSubscriptions file="48_subscriptions_digim_vas.json" title="Subscriptions — Mobile Store DigiM VAS" channel="DigiM VAS" liveChannel="DigiM VAS" />
    case "subs-cohort":
      return <SpotReportCohort />
    case "commercial-cohort":
      return <SpotReportCommercialCohort />
    case "wastage":
      return <SpotReportWastage />
    case "pargo":
      return (
        <SpotReportPlaceholder
          title="Pargo Collections"
          subtitle="Parcel collections via Pargo pickup points."
          note="Not wired live yet. The source view UCONNECT_DW.ANALYTICS.VW_PARGO_COLLECTIONS exists but isn't granted to the app role — grant it (scripts/spot-report.sql) and this page can read parcel collections live."
          kpis={["Parcels sent MTD", "Parcels collected MTD", "Collection rate %", "Avg days to collect"]}
          charts={["Monthly collections trend", "Sent vs collected by month", "Collections by tenant", "Aged uncollected parcels"]}
        />
      )
    case "recharge-qty":
      return <SpotReportRechargeQty />
    case "recharge-trend":
      return <SpotReportRechargeTrend />
    case "recharge-revenue":
      return <SpotReportRechargeRevenue />
    case "revenue-comparisons":
      return <SpotReportRevenueComparisons />
    case "prepaid-projection":
      return <SpotReportPrepaidProjection />
    case "financials-upload":
      return <SpotReportFinancialsUpload />
    default:
      return null
  }
}
type Section = { title: string; items: Report[] }

const SECTIONS: Section[] = [
  {
    title: "Strategy & Book",
    items: [
      { label: "Exco Scorecard", page: "33-exco-scorecard.html", native: "exco" },
      { label: "Spot Connect Book", page: "34-spot-connect-book.html", native: "connect-book" },
      { label: "OKR Scorecard", page: "35-okr-scorecard.html", native: "okr-scorecard" },
      { label: "OKR Trends", page: "36-okr-trends.html", native: "okr-trends" },
      { label: "Revenue Trends", page: "37-revenue-trends.html", native: "revenue-trends" },
      { label: "Voice Usage by Tenant", page: "38-voice-usage-tenant.html", native: "voice-usage" },
      { label: "Data Usage by Tenant", page: "39-data-usage-tenant.html", native: "data-usage" },
      { label: "Retain Users via Free Airtime", page: "40-retain-users-airtime.html", native: "retain-users" },
    ],
  },
  {
    title: "Sales",
    items: [
      { label: "Sales Trends", page: "01-sales-trends.html", native: "sales-trends" },
      { label: "Quality of Sales by Tenant & Store", page: "02-quality-of-sales.html", native: "quality-of-sales" },
      { label: "New SIM Activations & Utilisation", page: "11-sim-activations-1.html", native: "sim" },
      { label: "Trading Store Trend", page: "12-trading-store-trend.html", native: "trading-store-trend" },
      { label: "Store Scorecards", page: null, native: "scorecards" },
      { label: "Pipeline & Provisional Commissions", page: "13-pipeline-commissions.html", native: "pipeline-commissions" },
    ],
  },
  {
    title: "Subscriptions",
    items: [
      { label: "Telesales", page: "14-subscriptions-telesales.html", native: "subs-telesales" },
      { label: "App", page: "44-subscriptions-app.html", native: "subs-app" },
      { label: "WhatsApp", page: "45-subscriptions-whatsapp.html", native: "subs-whatsapp" },
      { label: "Below the Line", page: "46-subscriptions-below-the-line.html", native: "subs-btl" },
      { label: "Mobile Store", page: "47-subscriptions-mobile-store.html", native: "subs-mobile" },
      { label: "Mobile Store DigiM VAS", page: "48-subscriptions-digim-vas.html", native: "subs-digim" },
      { label: "Cohort Analysis", page: "15-subscriptions-cohort.html", native: "subs-cohort" },
    ],
  },
  {
    title: "Commercial",
    items: [
      { label: "Commercial Cohort Analysis", page: "16-commercial-cohort.html", native: "commercial-cohort" },
      { label: "Wastage", page: "17-wastage.html", native: "wastage" },
      { label: "Pargo Collections", page: "18-pargo-collections.html", native: "pargo" },
    ],
  },
  {
    title: "Recharges",
    items: [
      { label: "Recharge Qty Dash", page: "19-recharge-qty-dash.html", native: "recharge-qty" },
      { label: "Recharge Trend by Recharge Type", page: "20-recharge-trend-type.html", native: "recharge-trend" },
      { label: "Recharge Revenue Monthly", page: "21-recharge-revenue-monthly.html", native: "recharge-revenue" },
      { label: "Revenue Comparisons", page: "22-revenue-comparisons.html", native: "revenue-comparisons" },
      { label: "Prepaid Recharge Projection", page: "23-prepaid-recharge-projection.html", native: "prepaid-projection" },
    ],
  },
  {
    title: "Financials",
    items: [
      { label: "Upload income statement", page: null, native: "financials-upload", adminOnly: true },
      { label: "Upload pipeline", page: null, native: "pipeline-upload", adminOnly: true },
      { label: "Income Statement", page: null },
      { label: "Income Statement Summary", page: null },
      { label: "Revenue Metrics", page: null },
      { label: "Margin Efficiency Metrics", page: null },
      { label: "Cost of Sale Metrics", page: null },
      { label: "Opex Metrics", page: null },
      { label: "Acquisition Cost Metrics", page: null },
      { label: "Forward 12 & Trailing 12", page: null },
      { label: "Value of New Business", page: null },
    ],
  },
]

const FIRST = SECTIONS[1].items[0] // Sales Trends

export function SpotReportDashboard({ onBack }: { onBack?: () => void }) {
  const [active, setActive] = useState<Report>(FIRST)
  const [reloadKey, setReloadKey] = useState(0)
  // Native React pages render in-app; only non-native pages use the iframe.
  const src = active.page && !active.native ? `/spot-report/pages/${active.page}` : null

  // Six sections, all folded by default; the shell opens whichever holds the
  // active report and hides admin-only items (and a section left empty).
  const nav = SECTIONS.map((section) => ({
    id: section.title,
    label: section.title,
    collapsible: true,
    defaultOpen: false,
    items: section.items.map((item) => ({
      id: reportId(item),
      label: item.label,
      adminOnly: item.adminOnly,
      disabled: !(item.page || item.native),
      indent: item.indent,
      heading: item.header,
    })),
  }))
  const onNavigate = (id: string) => {
    const item = SECTIONS.flatMap((sec) => sec.items).find((it) => reportId(it) === id)
    if (item) setActive(item)
  }

  return (
    <DepartmentShell
      brand={{
        icon: <span className="text-sm font-bold">S</span>,
        label: (
          <>
            Spot<sup className="text-[10px]">TM</sup>
          </>
        ),
        sublabel: "Telco Retail",
      }}
      nav={nav}
      activeId={reportId(active)}
      onNavigate={onNavigate}
      onBack={onBack}
      padded={false}
      headerActions={
        src ? (
          <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reload
          </Button>
        ) : undefined
      }
    >
      {active.native ? (
        <div
          key={active.native}
          className="min-h-0 flex-1 overflow-auto animate-in fade-in-0 duration-200 ease-out"
        >
          {renderNative(active.native)}
        </div>
      ) : src ? (
        <iframe
          key={`${active.page}-${reloadKey}`}
          src={src}
          title={active.label}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          onLoad={(e) => {
            // Same-origin: hide each report's own topbar (Spot logo + "Back to
            // Menu" that would jump to the static landing) so only the report
            // content shows under the app header.
            try {
              const doc = e.currentTarget.contentDocument
              if (doc && !doc.getElementById("spot-embed-style")) {
                const style = doc.createElement("style")
                style.id = "spot-embed-style"
                style.textContent = ".topbar{display:none!important;}"
                doc.head.appendChild(style)
              }
            } catch {
              // Cross-origin (shouldn't happen) — leave the page as-is.
            }
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-10 text-center text-sm text-muted-foreground">
          This report hasn&apos;t been built yet.
        </div>
      )}
    </DepartmentShell>
  )
}
