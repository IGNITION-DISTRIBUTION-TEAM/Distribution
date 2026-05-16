import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_ONAIR_SALES_STATS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

const FIELDS = [
  { key: "providerTypes", column: "PROVIDERTYPE" },
  { key: "isInsurable", column: "ISINSURABLE" },
] as const

export async function GET() {
  const out: Record<string, string[]> = {}
  const errors: Record<string, string> = {}

  await Promise.all(
    FIELDS.map(async ({ key, column }) => {
      try {
        const rows = await executeSnowflakeQuery<{ V: string | number | null }>(
          `SELECT DISTINCT ${column} AS V
           FROM ${VIEW}
           WHERE ${column} IS NOT NULL
           ORDER BY V`,
          SF_OPTS
        )
        out[key] = rows
          .map((r) => (r.V === null || r.V === undefined ? "" : String(r.V)))
          .filter((v) => v.length > 0)
      } catch (error) {
        errors[key] = error instanceof Error ? error.message : String(error)
        out[key] = []
      }
    })
  )

  return NextResponse.json({ values: out, errors })
}
