"use client"

import { PhoneCall } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { Card } from "@/components/ui/card"

/**
 * Dialler has nothing in it yet. It still renders the same shell as every
 * other department, so that when something is built here it lands in a page
 * that already looks like the rest of the portal — and so the one department
 * without a sidebar stops being the one department that looks different.
 */
export function DiallerDashboard({ onBack }: { onBack?: () => void }) {
  return (
    <DepartmentShell
      brand={{ icon: <PhoneCall />, label: "Dialler" }}
      nav={[{ id: "dialler", label: "Dialler", items: [{ id: "overview", label: "Overview", icon: <PhoneCall className="h-4 w-4" /> }] }]}
      activeId="overview"
      onNavigate={() => {}}
      onBack={onBack}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center py-12">
        <Card padding="none" className="border-dashed p-10 text-center">
          <PhoneCall className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-4 text-xl font-semibold text-foreground">Dialler department</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            This area is empty. Tell me which screens, tables, or actions you want in here and
            I&apos;ll build it out — same pattern as Distribution.
          </p>
        </Card>
      </div>
    </DepartmentShell>
  )
}
