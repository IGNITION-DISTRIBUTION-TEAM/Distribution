import { NextResponse } from "next/server"
import { getSnowflakeConfig, generateSnowflakeJWT } from "@/lib/snowflake"

/**
 * Debug endpoint to test Snowflake connection
 * POST /api/debug/snowflake-test
 */
export async function POST() {
  try {
    console.log("[Snowflake Debug] Starting connection test...")

    // Step 1: Load config
    console.log("[Snowflake Debug] Step 1: Loading configuration")
    let config
    try {
      config = getSnowflakeConfig()
      console.log("[Snowflake Debug] ✓ Config loaded")
      console.log("[Snowflake Debug]   Account:", config.account)
      console.log("[Snowflake Debug]   User:", config.user)
      console.log("[Snowflake Debug]   Database:", config.database)
      console.log("[Snowflake Debug]   Schema:", config.schema)
      console.log("[Snowflake Debug]   Warehouse:", config.warehouse)
    } catch (error) {
      console.error("[Snowflake Debug] ✗ Config failed:", error)
      return NextResponse.json({
        success: false,
        error: "Config load failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }, { status: 400 })
    }

    // Step 2: Generate JWT
    console.log("[Snowflake Debug] Step 2: Generating JWT token")
    let jwtToken
    try {
      jwtToken = generateSnowflakeJWT(config)
      console.log("[Snowflake Debug] ✓ JWT generated (length:", jwtToken.length, ")")
    } catch (error) {
      console.error("[Snowflake Debug] ✗ JWT generation failed:", error)
      return NextResponse.json({
        success: false,
        error: "JWT generation failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }, { status: 400 })
    }

    // Step 3: Build API URL
    console.log("[Snowflake Debug] Step 3: Building API URL")
    const region = process.env.SNOWFLAKE_REGION || "us-east-1"
    const cloud = process.env.SNOWFLAKE_CLOUD || "aws"
    const snowflakeUrl = `https://${config.account}.${region}.${cloud}.snowflakecomputing.com/api/v2/statements`
    console.log("[Snowflake Debug] URL:", snowflakeUrl)

    // Step 4: Test simple SELECT 1 statement
    console.log("[Snowflake Debug] Step 4: Testing connection with SELECT 1")
    const testBody = {
      statement: "SELECT 1",
      database: config.database,
      schema: config.schema,
      warehouse: config.warehouse,
      role: config.role || "ACCOUNTADMIN",
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/json",
      "User-Agent": "DataPlatform/1.0",
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    }

    const response = await fetch(snowflakeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(testBody),
    })

    console.log("[Snowflake Debug] Response status:", response.status, response.statusText)

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[Snowflake Debug] ✗ Connection failed:", errorText)
      return NextResponse.json({
        success: false,
        error: "Connection test failed",
        status: response.status,
        message: errorText,
      }, { status: response.status })
    }

    const result = await response.json()
    console.log("[Snowflake Debug] ✓ Connection successful!")
    console.log("[Snowflake Debug] Response:", result)

    return NextResponse.json({
      success: true,
      message: "Snowflake connection test successful",
      details: {
        account: config.account,
        user: config.user,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        url: snowflakeUrl,
        response: result,
      },
    })
  } catch (error) {
    console.error("[Snowflake Debug] Unexpected error:", error)
    return NextResponse.json({
      success: false,
      error: "Debug test failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }, { status: 500 })
  }
}
