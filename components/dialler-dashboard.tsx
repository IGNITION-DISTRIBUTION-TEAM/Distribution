"use client"

import { useState } from "react"
import { Link2, PhoneCall } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { PageHeading } from "@/components/kit/heading"
import { CampaignMapper } from "@/components/dialler/campaign-mapper"

/**
 * Dialler.
 *
 * Campaign mapping is the first thing in here. It answers a question nothing
 * else in the portal could: which dialler campaign a given SilverSurfer
 * campaign actually runs on. The two systems have separate campaign lists with
 * no shared key, so the answer has to be recorded by a person rather than
 * derived — which is what the screen is for.
 */
export function DiallerDashboard({ onBack }: { onBack?: () => void }) {
  const [active, setActive] = useState("campaign-mapping")

  return (
    <DepartmentShell
      brand={{ icon: <PhoneCall />, label: "Dialler" }}
      nav={[
        {
          id: "dialler",
          label: "Dialler",
          items: [
            {
              id: "campaign-mapping",
              label: "Campaign mapping",
              icon: <Link2 className="h-4 w-4" />,
            },
          ],
        },
      ]}
      activeId={active}
      onNavigate={setActive}
      onBack={onBack}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div>
          <PageHeading>Campaign mapping</PageHeading>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
            Which Yaxxa dialler campaigns each active SilverSurfer campaign runs on. The two
            systems keep separate campaign lists with no shared key, so the link is recorded here
            by hand.
          </p>
        </div>
        <CampaignMapper />
      </div>
    </DepartmentShell>
  )
}
