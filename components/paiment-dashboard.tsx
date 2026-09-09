"use client"

import { useState } from "react"
import { Package, ReceiptText } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { PageHeading } from "@/components/kit/heading"
import { ProductMappingTable } from "@/components/paiment/product-mapping-table"

/**
 * Paiment — the billing team's own department.
 *
 * One section for now. It is named for the team rather than for the data
 * because the product mapping is the first of several mappings they will want
 * here: the campaign classification and the bank-response groupings are the
 * same shape and the same argument, and "Product mapping" would have aged badly
 * as a department name the moment the second one arrived.
 */
export function PaimentDashboard({ onBack }: { onBack?: () => void }) {
  const [active, setActive] = useState("product-mapping")

  return (
    <DepartmentShell
      brand={{ icon: <ReceiptText />, label: "Paiment", sublabel: "Billing mappings" }}
      nav={[
        {
          id: "mappings",
          label: "Mappings",
          items: [
            {
              id: "product-mapping",
              label: "Product mapping",
              icon: <Package className="h-4 w-4" />,
            },
            {
              id: "campaign-mapping",
              label: "Campaign mapping",
              disabled: true,
              disabledHint: "next, once the product mapping has settled",
            },
            {
              id: "bank-response",
              label: "Bank responses",
              disabled: true,
              disabledHint: "next, once the product mapping has settled",
            },
          ],
        },
      ]}
      activeId={active}
      onNavigate={setActive}
      onBack={onBack}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div>
          <PageHeading>Product mapping</PageHeading>
          <p className="mt-1 text-sm text-muted-foreground">
            Product group and VAS classification, plus the channel and brand overrides that decide
            how a deal is attributed in executive reporting.
          </p>
        </div>
        <ProductMappingTable />
      </div>
    </DepartmentShell>
  )
}
