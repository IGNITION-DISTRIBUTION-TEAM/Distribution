import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

type CampaignRow = {
  CAMPAIGNID: string | number
  TITLE: string | null
}

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<CampaignRow>(
      `SELECT CAMPAIGNID, TITLE
       FROM DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN
       WHERE ACTIVE = 1
         AND TITLE IS NOT NULL
         AND TITLE <> ''
       ORDER BY TITLE`,
      { database: "DATAWAREHOUSE", schema: "SILVERSURFER_CAMP_HEVO" }
    )

    const campaigns = rows.map((r) => ({
      id: String(r.CAMPAIGNID),
      title: r.TITLE ?? "",
    }))

    return NextResponse.json({ campaigns })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/campaigns] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
