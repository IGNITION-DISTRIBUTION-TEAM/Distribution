/**
 * Excel Parser for Finance Forecast
 * Transforms wide format Excel (months as columns) into normalized format
 * Output columns: METRIC, DIVISION, CAMPAIGN_NAME, BRAND, CHANNEL, FORECAST_DATE, FORECAST_YEAR, FORECAST_MONTH, FORECAST_VALUE
 */

import * as XLSX from "xlsx"

export interface NormalizedForecastRow {
  METRIC: string
  DIVISION: string
  CAMPAIGN_NAME: string
  BRAND: string
  CHANNEL: string
  FORECAST_DATE: string
  FORECAST_YEAR: number
  FORECAST_MONTH: string
  FORECAST_VALUE: number | string
}

export interface ParsedExcelData {
  sheetName: string
  rows: NormalizedForecastRow[]
  columnHeaders: string[]
  metadata: {
    totalRows: number
    totalColumns: number
    processedDate: string
  }
}

/**
 * Parse all sheets and normalize to standard format
 */
export function parseAllExcelSheets(fileBuffer: Buffer): ParsedExcelData[] {
  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer" })
    const results: ParsedExcelData[] = []

    console.log(`[Excel Parser] Processing ${workbook.SheetNames.length} sheets`)

    for (const sheetName of workbook.SheetNames) {
      try {
        const worksheet = workbook.Sheets[sheetName]
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]

        if (!jsonData || jsonData.length === 0) {
          console.warn(`[Excel Parser] Sheet "${sheetName}" is empty`)
          continue
        }

        // Find header row
        const headerRowIndex = findHeaderRow(jsonData)
        if (headerRowIndex === -1) {
          console.log(`[Excel Parser] Sheet "${sheetName}" skipped (not a forecast data sheet)`)
          continue
        }

        // Extract headers
        const headers = jsonData[headerRowIndex].map((h) => String(h || "").trim())

        // Parse data rows
        const rows: NormalizedForecastRow[] = []
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i]

          // Skip empty rows
          if (!row || row.every((cell) => !cell)) {
            continue
          }

          // Normalize wide format to long format, passing sheet name as metric
          const normalizedRows = normalizeRow(row, headers, sheetName)
          rows.push(...normalizedRows)
        }

        if (rows.length === 0) {
          console.log(`[Excel Parser] Sheet "${sheetName}" skipped (no forecast data found - may be a reference table)`)
          continue
        }

        results.push({
          sheetName,
          rows,
          columnHeaders: ["METRIC", "DIVISION", "CAMPAIGN_NAME", "BRAND", "CHANNEL", "FORECAST_DATE", "FORECAST_YEAR", "FORECAST_MONTH", "FORECAST_VALUE"],
          metadata: {
            totalRows: rows.length,
            totalColumns: 9,
            processedDate: new Date().toISOString(),
          },
        })

        console.log(`[Excel Parser] Sheet "${sheetName}": ${rows.length} rows`)
      } catch (sheetError) {
        console.error(`[Excel Parser] Error processing sheet "${sheetName}":`, sheetError)
        continue
      }
    }

    return results
  } catch (error) {
    console.error("[Excel Parser] Error parsing workbook:", error)
    throw new Error(`Failed to parse Excel workbook: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

/**
 * Find header row containing Division, Brand, Channel, Campaign
 * (METRIC comes from sheet name, not from columns)
 * Returns -1 if header row is not found (sheet is not a forecast data sheet)
 */
function findHeaderRow(data: any[][]): number {
  for (let i = 0; i < Math.min(50, data.length); i++) {
    const row = data[i]
    if (!row) continue

    const rowLower = row.map((c) => String(c || "").toLowerCase())
    
    // Check for key forecast data columns
    const hasDivision = rowLower.some((c) => c.includes("division"))
    const hasBrand = rowLower.some((c) => c.includes("brand"))
    const hasChannel = rowLower.some((c) => c.includes("channel"))
    
    // All three columns should be present to be a valid forecast sheet
    if (hasDivision && hasBrand && hasChannel) {
      return i
    }
  }
  return -1
}

/**
 * Normalize a wide-format row to multiple long-format rows
 * Metric comes from sheet name, data columns are: Division | Campaign | Brand | Channel | Month1_Data | Month2_Data | ...
 * Long format: One row per month with FORECAST_DATE, FORECAST_YEAR, FORECAST_MONTH, FORECAST_VALUE
 */
function normalizeRow(row: any[], headers: string[], metricFromSheet: string): NormalizedForecastRow[] {
  // Extract metadata from first 4 columns (no METRIC column - it comes from sheet name)
  const division = String(row[0] || "").trim()
  const campaign = String(row[1] || "").trim()
  const brand = String(row[2] || "").trim()
  const channel = String(row[3] || "").trim()

  // Skip if metadata is incomplete
  if (!division && !campaign && !brand && !channel) {
    return []
  }

  const normalizedRows: NormalizedForecastRow[] = []

  // Process data columns (starting from column 4)
  for (let i = 4; i < row.length; i++) {
    const columnHeader = headers[i] || ""
    const value = row[i]

    // Parse the date from column header (Excel serial number)
    const dateInfo = parseColumnDate(columnHeader)
    if (!dateInfo) continue

    // Parse the value
    const numValue = parseNumericValue(value)

    normalizedRows.push({
      METRIC: metricFromSheet,
      DIVISION: division,
      CAMPAIGN_NAME: campaign,
      BRAND: brand,
      CHANNEL: channel,
      FORECAST_DATE: dateInfo.dateString,
      FORECAST_YEAR: dateInfo.year,
      FORECAST_MONTH: dateInfo.monthName,
      FORECAST_VALUE: numValue,
    })
  }

  return normalizedRows
}

/**
 * Parse column header to extract date
 * Handles Excel date serial numbers
 */
function parseColumnDate(header: any): { dateString: string; year: number; monthName: string } | null {
  if (!header) return null

  const headerStr = String(header).trim()

  // If it's a number string, try to parse as Excel date
  if (/^\d+$/.test(headerStr)) {
    const dateNum = parseInt(headerStr, 10)
    if (dateNum > 1000 && dateNum < 100000) {
      // Likely an Excel date serial number
      return excelDateToDateInfo(dateNum)
    }
  }

  return null
}

/**
 * Convert Excel date serial to date info
 * Excel serial: 45717 = 2025-12-25 (approximately)
 */
function excelDateToDateInfo(excelDate: number): { dateString: string; year: number; monthName: string } {
  const excelEpoch = new Date(1900, 0, 0)
  const date = new Date(excelEpoch.getTime() + (excelDate - 1) * 24 * 60 * 60 * 1000)

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const monthName = monthNames[month]

  // Format as YYYY-MM-DD
  const dateString = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`

  return {
    dateString,
    year,
    monthName,
  }
}

/**
 * Parse numeric value, handling R0, -, and currency formats
 */
function parseNumericValue(value: any): number | string {
  if (value === null || value === undefined) return 0

  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "" || trimmed === "R0" || trimmed === "-" || trimmed === "N/A") {
      return 0
    }

    const numValue = parseFloat(trimmed.replace(/[^0-9.-]/g, ""))
    return isNaN(numValue) ? trimmed : numValue
  }

  return value
}

/**
 * Combine multiple parsed sheets
 */
export function combineSheetData(sheetsData: ParsedExcelData[]): NormalizedForecastRow[] {
  const combined: NormalizedForecastRow[] = []

  for (const sheetData of sheetsData) {
    combined.push(...sheetData.rows)
  }

  console.log(`[Excel Parser] Combined ${combined.length} total rows from ${sheetsData.length} sheets`)

  return combined
}
