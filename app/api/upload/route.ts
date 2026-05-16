import { NextResponse } from "next/server"
import { getSnowflakeConfig, generateSnowflakeJWT } from "@/lib/snowflake"
import { parseAllExcelSheets, combineSheetData } from "@/lib/excel-parser"

// In-memory storage for processed data (session-based)
const processedDataCache = new Map<string, any[]>()

/**
 * POST /api/upload
 *
 * Accepts multipart form data with:
 *   - file: The .xlsx file to upload
 *   - category: The upload category ("finance_forecast" or "standard")
 *
 * When category is "finance_forecast":
 * - Parses all sheets in the Excel file
 * - Extracts Campaign, Division, Brand, Channel, and monthly data
 * - Combines all sheets into a single dataset
 *
 * When Snowflake credentials are not configured, returns mock response for testing.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const category = formData.get("category") as string | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    // Validate file type
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
      return NextResponse.json(
        { error: "Only .xlsx and .xls files are accepted" },
        { status: 400 }
      )
    }

    // Validate file size (50MB max)
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size must be under 50MB" },
        { status: 400 }
      )
    }

    // Read the file buffer
    const buffer = Buffer.from(await file.arrayBuffer())

    // Handle Finance Forecast processing
    if (category === "finance_forecast") {
      return await handleFinanceForecastUpload(
        file,
        buffer,
        category
      )
    }

    // Standard upload flow
    return await handleStandardUpload(file, buffer, category)
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

/**
 * Handle Finance Forecast file uploads
 * Parses all Excel sheets, combines data, and loads into Snowflake
 */
async function handleFinanceForecastUpload(
  file: File,
  buffer: Buffer,
  category: string
) {
  try {
    console.log(
      `[Finance Forecast Upload] File: ${file.name}, Size: ${buffer.length} bytes`
    )

    // Parse all sheets in the workbook
    const sheetsData = parseAllExcelSheets(buffer)

    if (sheetsData.length === 0) {
      return NextResponse.json(
        { error: "No valid data found in Excel file" },
        { status: 400 }
      )
    }

    // Combine all sheets
    const combinedData = combineSheetData(sheetsData)

    console.log(
      `[Finance Forecast] Parsed ${sheetsData.length} sheets with ${combinedData.length} total rows`
    )

    // Store all data in cache for download endpoint
    const cacheKey = `${file.name}-${Date.now()}`
    processedDataCache.set(cacheKey, combinedData)
    console.log(`[Finance Forecast] Stored cache key: ${cacheKey}`)

    // Load data to Snowflake if credentials are configured
    const hasSnowflakeConfig =
      process.env.SNOWFLAKE_ACCOUNT &&
      process.env.SNOWFLAKE_USER &&
      process.env.SNOWFLAKE_PRIVATE_KEY &&
      process.env.SNOWFLAKE_KEY_FINGERPRINT

    let snowflakeStatus = "not_configured"
    let snowflakeError: string | null = null

    if (hasSnowflakeConfig) {
      try {
        console.log(`[Finance Forecast] Loading ${combinedData.length} rows to Snowflake...`)
        await loadDataToSnowflake(combinedData)
        snowflakeStatus = "loaded"
        console.log(`[Finance Forecast] Successfully loaded data to Snowflake`)
      } catch (error) {
        snowflakeStatus = "failed"
        snowflakeError = error instanceof Error ? error.message : String(error)
        console.error(`[Finance Forecast] Snowflake load failed:`, error)
      }
    }

    return NextResponse.json({
      success: true,
      message: "Finance Forecast file processed successfully.",
      details: {
        fileName: file.name,
        fileSize: buffer.length,
        category,
        sheetsProcessed: sheetsData.length,
        sheetNames: sheetsData.map((s) => s.sheetName),
        totalRows: combinedData.length,
        columns: sheetsData[0]?.columnHeaders || [],
        timestamp: new Date().toISOString(),
        cacheKey,
        snowflakeStatus,
        snowflakeError,
        data: {
          preview: combinedData.slice(0, 15),
          totalProcessed: combinedData.length,
        },
      },
    })
  } catch (error) {
    console.error("[Finance Forecast Error]", error)
    return NextResponse.json(
      {
        error: "Finance Forecast processing failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

/**
 * Load data to Snowflake using the REST API
 * Mirrors the Python implementation from the working example
 */
async function loadDataToSnowflake(data: any[]): Promise<void> {
  try {
    console.log(`[Snowflake] ========== loadDataToSnowflake START ==========`)
    console.log(`[Snowflake] Data rows to load: ${data.length}`)
    
    // Get config
    const config = getSnowflakeConfig()
    console.log(`[Snowflake] Config loaded:`)
    console.log(`  account: ${config.account}`)
    console.log(`  user: ${config.user}`)
    console.log(`  warehouse: ${config.warehouse}`)
    console.log(`  database: ${config.database}`)
    console.log(`  schema: ${config.schema}`)
    console.log(`  role: ${config.role}`)
    console.log(`  keyFingerprint: ${config.keyFingerprint}`)
    console.log(`  privateKey length: ${config.privateKey.length} chars`)

    // Generate JWT token
    console.log(`[Snowflake] Calling generateSnowflakeJWT...`)
    const jwtToken = generateSnowflakeJWT(config)
    console.log(`[Snowflake] JWT token generated, length: ${jwtToken.length}`)
    
    // Decode and log JWT payload for debugging
    const tokenParts = jwtToken.split(".")
    if (tokenParts.length === 3) {
      try {
        // Decode header
        const headerStr = Buffer.from(tokenParts[0], "base64url").toString("utf-8")
        const header = JSON.parse(headerStr)
        console.log(`[Snowflake] JWT Header:`, JSON.stringify(header, null, 2))
        
        // Decode payload
        const payloadStr = Buffer.from(tokenParts[1], "base64url").toString("utf-8")
        const payload = JSON.parse(payloadStr)
        console.log(`[Snowflake] JWT Payload:`, JSON.stringify(payload, null, 2))
        console.log(`[Snowflake] JWT iss (issuer): ${payload.iss}`)
        console.log(`[Snowflake] JWT sub (subject): ${payload.sub}`)
        console.log(`[Snowflake] JWT iat: ${payload.iat}`)
        console.log(`[Snowflake] JWT exp: ${payload.exp}`)
        
        // Show full token
        console.log(`[Snowflake] FULL JWT TOKEN: ${jwtToken}`)
        console.log(`[Snowflake] Token preview: ${jwtToken.substring(0, 50)}...${jwtToken.substring(jwtToken.length - 50)}`)
      } catch (e) {
        console.log(`[Snowflake] Could not decode JWT payload for debugging:`, e)
      }
    }

    // Build URL using full account identifier (may include region/cloud for Azure, etc.)
    console.log(`[Snowflake] Raw account from config: ${config.account}`)
    
    // Snowflake account format can be:
    // - AWS: account-id or account-id.region.cloud.snowflakecomputing.com
    // - Azure: account-id or account-id.region.azure.snowflakecomputing.com
    // Use full account identifier as-is
    const snowflakeUrl = `https://${config.account}.snowflakecomputing.com/api/v2/statements`

    console.log(`[Snowflake] Using full account identifier: ${config.account}`)
    console.log(`[Snowflake] Constructed URL: ${snowflakeUrl}`)

    // Build headers exactly like Python code
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/json",
      "User-Agent": "DataPlatform/1.0",
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    }

    console.log(`[Snowflake] Headers prepared:`, {
      "Content-Type": headers["Content-Type"],
      "Authorization": "Bearer [JWT]",
      "Accept": headers["Accept"],
      "X-Snowflake-Authorization-Token-Type": headers["X-Snowflake-Authorization-Token-Type"],
    })

    // Build INSERT statement with all rows
    const valuesClauses = data.map((row) => {
      const metric = escapeSnowflakeSql(row.METRIC)
      const division = escapeSnowflakeSql(row.DIVISION)
      const campaign = escapeSnowflakeSql(row.CAMPAIGN_NAME)
      const brand = escapeSnowflakeSql(row.BRAND)
      const channel = escapeSnowflakeSql(row.CHANNEL)
      const forecastDate = row.FORECAST_DATE
      const forecastYear = row.FORECAST_YEAR || 0
      const forecastMonth = escapeSnowflakeSql(row.FORECAST_MONTH)
      const forecastValue = escapeSnowflakeSql(String(row.FORECAST_VALUE))

      return `('${metric}', '${division}', '${campaign}', '${brand}', '${channel}', '${forecastDate}'::DATE, ${forecastYear}, '${forecastMonth}', '${forecastValue}')`
    })

    const statement = `INSERT INTO DATAWAREHOUSE.VERCEL.TM_FORECAST_METRICS_STAGE (METRIC, DIVISION, CAMPAIGN_NAME, BRAND, CHANNEL, FORECAST_DATE, FORECAST_YEAR, FORECAST_MONTH, FORECAST_VALUE) VALUES ${valuesClauses.join(",")}`

    console.log(`[Snowflake] SQL Statement:`)
    console.log(`  Total length: ${statement.length} characters`)
    console.log(`  Rows to insert: ${valuesClauses.length}`)
    if (valuesClauses.length > 0) {
      console.log(`  First row: ${valuesClauses[0]}`)
      console.log(`  Full SQL (first 500 chars): ${statement.substring(0, 500)}...`)
    }
    console.log(`[Snowflake] Sample data row:`, JSON.stringify(data[0], null, 2))
    console.log(`[Snowflake] FULL SQL STATEMENT FOR DEBUGGING:`)
    console.log(statement)

    // Build request body
    const bodyData = {
      statement: statement,
      database: "DATAWAREHOUSE",
      schema: "VERCEL",
      warehouse: config.warehouse,
      role: config.role || "ACCOUNTADMIN",
    }

    console.log(`[Snowflake] Request body keys:`, Object.keys(bodyData))
    console.log(`[Snowflake] Warehouse: ${bodyData.warehouse}, Role: ${bodyData.role}`)

    console.log(`[Snowflake] Making POST request to: ${snowflakeUrl}`)
    console.log(`[Snowflake] Authorization header: Bearer ${jwtToken.substring(0, 50)}...${jwtToken.substring(jwtToken.length - 50)}`)

    // Make the request
    let response = await fetch(snowflakeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyData),
    })

    console.log(`[Snowflake] Response received - Status: ${response.status} ${response.statusText}`)

    const responseText = await response.text()
    console.log(`[Snowflake] Response length: ${responseText.length} bytes`)
    console.log(`[Snowflake] Raw response body: ${responseText}`)
    
    // Parse response to check for errors or warnings
    let parsedResponse: any = null
    if (responseText) {
      try {
        parsedResponse = JSON.parse(responseText)
        console.log(`[Snowflake] Parsed response:`, JSON.stringify(parsedResponse, null, 2))
        
        // Check for statementHandle (async execution)
        if (parsedResponse.statementHandle) {
          console.log(`[Snowflake] Async statement handle: ${parsedResponse.statementHandle}`)
        }
        
        // Check for errors in response
        if (parsedResponse.errors && parsedResponse.errors.length > 0) {
          console.error(`[Snowflake] Response contains errors:`, parsedResponse.errors)
          throw new Error(`Snowflake SQL errors: ${JSON.stringify(parsedResponse.errors)}`)
        }
        
        // Check for message field
        if (parsedResponse.message) {
          console.log(`[Snowflake] Message: ${parsedResponse.message}`)
        }
        
        // Check for resultSetMetaData (indicates query completed)
        if (parsedResponse.resultSetMetaData) {
          console.log(`[Snowflake] Result set metadata:`, parsedResponse.resultSetMetaData)
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("Snowflake SQL errors")) {
          throw e
        }
        console.log(`[Snowflake] Response is not JSON, raw: ${responseText.substring(0, 1000)}`)
      }
    }

    // Accept 200, 202 (async), and other 2xx responses as success
    if (response.status < 200 || response.status >= 300) {
      console.error(`[Snowflake] ERROR: Received ${response.status} response`)
      console.error(`[Snowflake] Error response:`, responseText)
      throw new Error(`Snowflake API error: ${response.status} ${response.statusText} - ${responseText.substring(0, 500)}`)
    }

    console.log(`[Snowflake] SUCCESS: ${data.length} rows submitted to Snowflake (status: ${response.status})`)
  } catch (error) {
    console.error("[Snowflake Load Error]", error)
    throw error
  }
}

/**
 * Escape single quotes in Snowflake SQL strings
 */
function escapeSnowflakeSql(value: string | null | undefined): string {
  if (!value) return ""
  return String(value).replace(/'/g, "''")
}

/**
 * Handle standard file uploads
 * Uploads directly to Snowflake
 */
async function handleStandardUpload(
  file: File,
  buffer: Buffer,
  category: string | null
) {
  try {
    // Check if Snowflake credentials are configured
    const hasSnowflakeConfig =
      process.env.SNOWFLAKE_ACCOUNT &&
      process.env.SNOWFLAKE_USER &&
      process.env.SNOWFLAKE_PRIVATE_KEY

    if (hasSnowflakeConfig) {
      // Production: Upload to Snowflake using Key Pair JWT
      try {
        const config = getSnowflakeConfig()

        // Generate JWT token
        const jwtToken = generateSnowflakeJWT(config)

        // Construct Snowflake REST API URL
        const region = process.env.SNOWFLAKE_REGION || "us-east-1"
        const cloud = process.env.SNOWFLAKE_CLOUD || "aws"
        const snowflakeUrl = `https://${config.account}.${region}.${cloud}.snowflakecomputing.com/api/v2/statements`

        // Prepare the SQL statement to upload file
        const fileName = file.name.replace(/\s+/g, "_")
        const targetDatabase = process.env.SNOWFLAKE_DATABASE || "COMMERCIAL_DB"
        const targetSchema = process.env.SNOWFLAKE_SCHEMA || "FINANCE_FORECAST"
        const warehouse = config.warehouse

        // First, stage the file
        const stageStatement = `PUT file:///tmp/${fileName} @~/${category || "finance_forecast"}/`

        // Make request to Snowflake
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwtToken}`,
          Accept: "application/json",
          "User-Agent": "DataPlatform/1.0",
          "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        }

        const body = {
          statement: stageStatement,
          database: targetDatabase,
          schema: targetSchema,
          warehouse: warehouse,
          role: config.role || "ACCOUNTADMIN",
        }

        console.log(`[Snowflake Upload] File: ${file.name}, Size: ${buffer.length} bytes, Category: ${category}`)

        // Send to Snowflake
        const response = await fetch(snowflakeUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Snowflake API error: ${response.status} - ${errorText}`)
        }

        const result = await response.json()

        return NextResponse.json({
          success: true,
          message: "File staged in Snowflake successfully",
          details: {
            fileName: file.name,
            fileSize: buffer.length,
            category: category || "finance_forecast",
            destination: `${targetDatabase}.${targetSchema}`,
            timestamp: new Date().toISOString(),
            snowflakeResponse: result,
          },
        })
      } catch (error) {
        console.error("[Snowflake Integration Error]", error)
        throw error
      }
    }

    // Development: Mock response when Snowflake is not configured
    console.log(
      `[Mock Upload] File: ${file.name}, Size: ${buffer.length} bytes, Category: ${category}`
    )

    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 1500))

    return NextResponse.json({
      success: true,
      message: "File uploaded successfully (mock - Snowflake not configured)",
      details: {
        fileName: file.name,
        fileSize: buffer.length,
        category: category || "standard",
        destination: "COMMERCIAL_DB.FINANCE_FORECAST.RAW_DATA",
        timestamp: new Date().toISOString(),
        mock: true,
      },
    })
  } catch (error) {
    console.error("[Standard Upload Error]", error)
    return NextResponse.json(
      {
        error: "Upload failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

export { processedDataCache }
