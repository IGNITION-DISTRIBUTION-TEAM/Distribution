// EngAIge Integration Manager — shared types & template metadata.
// Client-safe: no server-only imports (the dashboard bundles this).
//
// Ported from the EngAIge Streamlit app. Tables live in
// DATAWAREHOUSE.SS_INTEGRATION.

export const ENGAIGE_DB = "DATAWAREHOUSE"
export const ENGAIGE_SCHEMA = "SS_INTEGRATION"
const T = `${ENGAIGE_DB}.${ENGAIGE_SCHEMA}`
export const CONFIGS_TABLE = `${T}.CAMPAIGN_CONFIGS`
export const MAPPINGS_TABLE = `${T}.COLUMN_MAPPINGS`
export const ASSIGNMENTS_TABLE = `${T}.TASK_ASSIGNMENTS`
export const HISTORY_TABLE = `${T}.PROCESSING_HISTORY`
export const API_LOGS_TABLE = `${T}.API_CALL_LOGS`
export const RETRY_QUEUE_TABLE = `${T}.RETRY_QUEUE`

export const API_BASE = "https://marketicevent.webuildgreat.software"
export const ENDPOINT_OPTIONS = ["/externalevent", "/triggerexternalevent"] as const

export const TEMPLATE_TYPES = ["Generic", "Debicheck", "Sale Writeback"] as const
export type TemplateType = (typeof TEMPLATE_TYPES)[number]

// Template label <-> stored template_id.
export const TEMPLATE_ID_BY_TYPE: Record<TemplateType, string | null> = {
  Generic: null,
  Debicheck: "DEBICHECK_001",
  "Sale Writeback": "SALE_WRITEBACK_001",
}
export function templateNameFromId(id: string | null | undefined): string {
  if (id === "DEBICHECK_001") return "Debicheck"
  if (id === "SALE_WRITEBACK_001") return "Sale Writeback"
  return "Generic"
}

// Field sections per template, used by both the required-mapping step and the
// standalone mappings page.
export const TEMPLATE_SECTIONS: Record<string, Record<string, string[]>> = {
  DEBICHECK_001: {
    "Client Information": ["ClientRequestReference", "ClientContractReference"],
    Authentication: ["Authentication.AuthenticationInstrument"],
    "Collection Details": [
      "Collection.CollectionDay",
      "Collection.CollectionFrequency",
      "Collection.DateAdjustmentAllowed",
      "Collection.DebitValueType",
      "Collection.EntryClassCode",
      "Collection.InstalmentOccurrence",
      "Collection.TrackingIndicator",
    ],
    "Creditor Details": [
      "Creditor.AccountNumber",
      "Creditor.ContactNumber",
      "Creditor.Email",
      "Creditor.ShortName",
    ],
    "Debtor Details": [
      "Debtor.AccountNumber",
      "Debtor.AccountType",
      "Debtor.BankBranchCode",
      "Debtor.ContactNumber",
      "Debtor.Email",
      "Debtor.IdentificationNumber",
      "Debtor.IdentificationType",
      "Debtor.Name",
    ],
    Economics: [
      "Economics.AdjustmentAmount",
      "Economics.AdjustmentCategory",
      "Economics.AdjustmentRate",
      "Economics.InitialAmount",
      "Economics.InstalmentAmount",
      "Economics.MaxCollectionAmount",
    ],
  },
  SALE_WRITEBACK_001: {
    "Banking Details": [
      "BankingDetails.AccountNumber",
      "BankingDetails.AccountType",
      "BankingDetails.BankID",
      "BankingDetails.BranchCode",
      "BankingDetails.DebitDay",
      "BankingDetails.PayMethodType",
    ],
    "Personal Details": [
      "PersonalDetails.Title",
      "PersonalDetails.FirstName",
      "PersonalDetails.LastName",
      "PersonalDetails.MSISDN",
      "PersonalDetails.HomeNumber",
      "PersonalDetails.WorkNumber",
      "PersonalDetails.EmailAddress",
      "PersonalDetails.IdNumber",
      "PersonalDetails.IdentificationType",
    ],
    "Residential Address": [
      "PersonalDetails.ResidentialAddress.Building",
      "PersonalDetails.ResidentialAddress.StreetNum",
      "PersonalDetails.ResidentialAddress.StreetName",
      "PersonalDetails.ResidentialAddress.City",
      "PersonalDetails.ResidentialAddress.Suburb",
      "PersonalDetails.ResidentialAddress.PostCode",
    ],
    "Delivery Address": [
      "PersonalDetails.DeliveryAddress.Building",
      "PersonalDetails.DeliveryAddress.StreetNum",
      "PersonalDetails.DeliveryAddress.StreetName",
      "PersonalDetails.DeliveryAddress.City",
      "PersonalDetails.DeliveryAddress.Suburb",
      "PersonalDetails.DeliveryAddress.PostCode",
    ],
    Other: ["CampaignId", "ProductDetails.DealId"],
  },
}

// Type hints shown next to fields when mapping.
export const FIELD_TYPE_HINTS: Record<string, Record<string, string>> = {
  DEBICHECK_001: {
    "Collection.MandateReleaseDate": "Date (YYYY-MM-DD)",
    "Collection.FirstCollectionDate": "Date (YYYY-MM-DD)",
    "Collection.CollectionDay": "Integer (1-31)",
    "Economics.InitialAmount": "Decimal (e.g. 20.17)",
    "Economics.InstalmentAmount": "Decimal (e.g. 52.5)",
    "Economics.MaxCollectionAmount": "Decimal (e.g. 76)",
    "Economics.AdjustmentRate": "Decimal (e.g. 11.91)",
  },
  SALE_WRITEBACK_001: {
    "BankingDetails.PayMethodType": "Integer (e.g. 1)",
    "BankingDetails.DebitDay": "String (e.g. '15')",
    "BankingDetails.BankID": "String (e.g. '7')",
    "PersonalDetails.Title": "Integer (e.g. 1)",
    "PersonalDetails.MSISDN": "String w/ country code (e.g. '27714729075')",
    "PersonalDetails.IdentificationType": "Integer (e.g. 1)",
    "PersonalDetails.IdNumber": "String (13 digits)",
  },
}

// Group existing mappings into display sections (mirrors the Streamlit prefixes).
export function sectionForField(templateId: string | null, fieldPath: string): string {
  if (templateId === "DEBICHECK_001") {
    if (/^(ClientRequest|ClientContract|Authentication)/.test(fieldPath)) return "Client Information"
    if (fieldPath.startsWith("Collection")) return "Collection Details"
    if (fieldPath.startsWith("Creditor")) return "Creditor Details"
    if (fieldPath.startsWith("Debtor")) return "Debtor Details"
    if (fieldPath.startsWith("Economics")) return "Economics"
  } else if (templateId === "SALE_WRITEBACK_001") {
    if (fieldPath.startsWith("PersonalDetails.ResidentialAddress")) return "Residential Address"
    if (fieldPath.startsWith("PersonalDetails.DeliveryAddress")) return "Delivery Address"
    if (fieldPath.startsWith("BankingDetails")) return "Banking Details"
    if (fieldPath.startsWith("PersonalDetails")) return "Personal Details"
    if (fieldPath === "CampaignId" || fieldPath.startsWith("ProductDetails")) return "Other"
  }
  return "Mappings"
}

export const TIME_WINDOWS = [
  "08:00:00", "08:15:00", "08:30:00", "08:45:00",
  "09:00:00", "09:15:00", "09:30:00", "09:45:00",
  "10:00:00", "10:15:00", "10:30:00", "10:45:00",
  "11:00:00", "11:15:00", "11:30:00", "11:45:00",
  "12:00:00", "14:00:00", "15:00:00", "16:00:00", "17:00:00", "19:00:00",
]

export const SCHEDULE_TYPES = ["Daily", "Specific Days", "Weekdays", "Weekends"] as const
export type ScheduleType = (typeof SCHEDULE_TYPES)[number]

export const DAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const
export type DayKey = (typeof DAY_KEYS)[number]

// Days set for a non-"Specific Days" schedule type.
export function daysForScheduleType(type: ScheduleType): Record<DayKey, boolean> {
  const all = (v: boolean) => Object.fromEntries(DAY_KEYS.map((d) => [d, v])) as Record<DayKey, boolean>
  if (type === "Daily") return all(true)
  if (type === "Weekdays") return { ...all(true), saturday: false, sunday: false }
  if (type === "Weekends") return { ...all(false), saturday: true, sunday: true }
  return all(false)
}

export type EngaigeConfig = {
  configId: string
  configName: string
  templateId: string | null
  sourceTable: string
  batchSize: number
  apiEndpoint: string
  externalSourceId: string
  eventId: string
  isActive: boolean
  createdAt: string | null
  updatedAt: string | null
  mappingCount: number
  runningCount: number
}

export type EngaigeMapping = {
  mappingId: string
  sourceColumn: string
  targetFieldPath: string
}

export type EngaigeAssignment = {
  assignmentId: string
  configId: string
  taskWindow: string // HH:MM:SS
  scheduleType: string
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
  isActive: boolean
}

export type EngaigeExecution = {
  batchId: string
  configId: string
  configName?: string
  startTime: string | null
  endTime: string | null
  totalRecords: number
  processedRecords: number
  failedRecords: number
  status: string
  durationSeconds: number | null
}

// Identifier guard for table/column names interpolated into information_schema
// queries (identifiers can't be bound as parameters).
export const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/

export function timeLabel(hms: string): string {
  const [h, m] = hms.split(":")
  const hour = Number(h)
  const ampm = hour >= 12 ? "PM" : "AM"
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${String(h12).padStart(2, "0")}:${m} ${ampm}`
}
