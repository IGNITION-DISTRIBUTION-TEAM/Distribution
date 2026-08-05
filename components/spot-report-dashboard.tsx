"use client"

import { useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ArrowLeft, LogOut, RefreshCw } from "lucide-react"
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

// The Spot Report reports are the static Telco Retail pages served from
// public/spot-report/pages/ (gated by middleware). Navigation lives in the app
// sidebar (portal design); the selected report renders in the content area.
// `page` is the file under public/spot-report/pages/, or null for a pending
// (not-yet-built) report.
// `native` is a key selecting an in-app React page; when unset the page is
// shown via the static iframe.
type Report = { label: string; page: string | null; indent?: boolean; header?: boolean; native?: string; adminOnly?: boolean }

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
      { label: "App", page: "44-subscriptions-app.html" },
      { label: "WhatsApp", page: "45-subscriptions-whatsapp.html" },
      { label: "Below the Line", page: "46-subscriptions-below-the-line.html" },
      { label: "Mobile Store", page: "47-subscriptions-mobile-store.html" },
      { label: "Mobile Store DigiM VAS", page: "48-subscriptions-digim-vas.html" },
      { label: "Cohort Analysis", page: "15-subscriptions-cohort.html" },
    ],
  },
  {
    title: "Commercial",
    items: [
      { label: "Commercial Cohort Analysis", page: "16-commercial-cohort.html" },
      { label: "Wastage", page: "17-wastage.html" },
      { label: "Pargo Collections", page: "18-pargo-collections.html" },
    ],
  },
  {
    title: "Recharges",
    items: [
      { label: "Recharge Qty Dash", page: "19-recharge-qty-dash.html" },
      { label: "Recharge Trend by Recharge Type", page: "20-recharge-trend-type.html" },
      { label: "Recharge Revenue Monthly", page: "21-recharge-revenue-monthly.html" },
      { label: "Revenue Comparisons", page: "22-revenue-comparisons.html" },
      { label: "Prepaid Recharge Projection", page: "23-prepaid-recharge-projection.html" },
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
  const { user, logout } = useAuth()
  const [active, setActive] = useState<Report>(FIRST)
  const [reloadKey, setReloadKey] = useState(0)

  // Native React pages render in-app; only non-native pages use the iframe.
  const src = active.page && !active.native ? `/spot-report/pages/${active.page}` : null

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            <span className="text-lg font-bold text-foreground">
              Spot<sup className="text-[10px]">TM</sup>
            </span>
            <span className="text-xs text-muted-foreground">Telco Retail</span>
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent>
          {SECTIONS.map((section) => (
            <SidebarGroup key={section.title}>
              <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items
                    .filter((item) => !item.adminOnly || user?.isSuperAdmin)
                    .map((item) =>
                    item.header ? (
                      <div
                        key={item.label}
                        className="px-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        {item.label}
                      </div>
                    ) : (
                      (() => {
                        // Selectable if it has a static page OR a native React view.
                        const selectable = !!(item.page || item.native)
                        return (
                      <SidebarMenuItem key={item.label}>
                        <SidebarMenuButton
                          onClick={() => selectable && setActive(item)}
                          isActive={active.label === item.label && active.native === item.native && active.page === item.page}
                          disabled={!selectable}
                          tooltip={selectable ? item.label : `${item.label} (coming soon)`}
                          className={[
                            item.indent ? "pl-6" : "",
                            selectable ? "" : "opacity-50",
                          ].join(" ")}
                        >
                          <span className="truncate">{item.label}</span>
                          {!selectable && (
                            <span className="ml-auto text-[10px] text-muted-foreground">soon</span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                        )
                      })()
                    )
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3">
            <div className="px-2 text-sm">
              <p className="font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="w-full justify-start text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <span className="truncate text-sm font-medium text-foreground">{active.label}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {src && (
              <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Reload
              </Button>
            )}
          </div>
        </header>

        {active.native ? (
          <div key={active.native} className="min-h-0 flex-1 overflow-auto">
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
      </SidebarInset>
    </SidebarProvider>
  )
}
