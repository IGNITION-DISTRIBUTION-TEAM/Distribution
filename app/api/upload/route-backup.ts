// Test version - temporarily replace route.ts with this to use working JWT token

import { NextResponse } from "next/server"
import { getSnowflakeConfig, generateSnowflakeJWT } from "@/lib/snowflake"
import { parseAllExcelSheets, combineSheetData } from "@/lib/excel-parser"

async function loadDataToSnowflake(data: any[]): Promise<void> {
  try {
    console.log(`[Snowflake] ========== loadDataToSnowflake START ==========`)
    console.log(`[Snowflake] Data rows to load: ${data.length}`)
    
    const config = getSnowflakeConfig()
    
    // TESTING: Use working token from Python
    const jwtToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJQTTU4NTIxLlNWQ19WRVJDRUxfQVBQLlNIQTI1NjovS0hURndzVFZBOUlUZURUajRlNm9xZmg3TU5JYkcrN0dXSUZmeFVZSmRjPSIsInN1YiI6IlBNNTg1MjEuU1ZDX1ZFUkNFTF9BUFAiLCJpYXQiOjE3NzE0MjA3ODUsImV4cCI6MTc3MTQyNDMyNX0.IwWDfAIRARH7nzvX-uynNKtpS4k200pA4QjE8I21s4_ihYSQTqeT8cF_V6aBfSLJd6bc-TYXvcWaUSImLk4Jtb-bfWbViyVSq4dRWfuisXvYvByhewSogKI51-E3CCOShUaZq_-oVzGXWlWjXjxFNzzHKr83VnhaXBaNSyRf9fDie179LDwpNAW8C5R56Asw3Tl-Vq3CcJYdWQbjE7ax0T-xf-QowxLJ4DCissBmwdOpegq6DjNueVrrkQAkpld_UFBq0y6ZQyxBIG6xJsF279H2x6zZTObv3EzMVNgYdLNYgrqvqbrC0DghSxMPMWDOp-VBe2kv_0OSQqIY6zmlfg"
    console.log(`[Snowflake] USING PYTHON WORKING TOKEN FOR TESTING`)
    
    const snowflakeUrl = `https://${config.account}.snowflakecomputing.com/api/v2/statements`
    
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/json",
      "User-Agent": "DataPlatform/1.0",
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    }
    
    // Build SQL statement
    const valuesClauses = data.map((row) => {
      return `('${row.METRIC}', '${row.DIVISION}', '${row.CAMPAIGN_NAME}', '${row.BRAND}', '${row.CHANNEL}', '${row.FORECAST_DATE}'::DATE, ${row.FORECAST_YEAR || 0}, '${row.FORECAST_MONTH}', '${row.FORECAST_VALUE}')`
    })
    
    const statement = `INSERT INTO DATAWAREHOUSE.VERCEL.TM_FORECAST_METRICS_STAGE (METRIC, DIVISION, CAMPAIGN_NAME, BRAND, CHANNEL, FORECAST_DATE, FORECAST_YEAR, FORECAST_MONTH, FORECAST_VALUE) VALUES ${valuesClauses.join(",")}`
    
    const bodyData = {
      statement: statement,
      database: "DATAWAREHOUSE",
      schema: "VERCEL",
      warehouse: config.warehouse,
      role: config.role || "ACCOUNTADMIN",
    }
    
    console.log(`[Snowflake] Making POST to: ${snowflakeUrl}`)
    const response = await fetch(snowflakeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyData),
    })
    
    const responseText = await response.text()
    console.log(`[Snowflake] Response status: ${response.status}`)
    console.log(`[Snowflake] Response: ${responseText}`)
    
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Snowflake API error: ${response.status} - ${responseText.substring(0, 500)}`)
    }
    
    console.log(`[Snowflake] SUCCESS: Data loaded!`)
  } catch (error) {
    console.error("[Snowflake Error]", error)
    throw error
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const category = formData.get("category") as string | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    if (category === "finance_forecast") {
      const sheetsData = parseAllExcelSheets(buffer)
      const combinedData = combineSheetData(sheetsData)
      
      try {
        await loadDataToSnowflake(combinedData)
      } catch (error) {
        console.error(`Test failed:`, error)
      }
      
      return NextResponse.json({
        success: true,
        message: "Test completed - check console logs",
        totalRows: combinedData.length,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[Upload Error]", error)
    return NextResponse.json(
      {
        error: "Upload failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
