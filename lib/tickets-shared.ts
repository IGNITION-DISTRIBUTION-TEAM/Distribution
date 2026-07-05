// Ticket system types and constants shared by client and server.
// Keep this file free of server-only imports (no lib/snowflake) — the tickets
// dashboard imports it into the client bundle.

export const TICKETS_DB = "DATAWAREHOUSE"
export const TICKETS_SCHEMA = "LEADS_DISTRIBUTION"
export const TICKETS_TABLE = `${TICKETS_DB}.${TICKETS_SCHEMA}.TICKETS`
export const TICKETS_CONFIG_TABLE = `${TICKETS_DB}.${TICKETS_SCHEMA}.TICKETS_FORM_CONFIG`
export const TICKETS_DEPARTMENTS_TABLE = `${TICKETS_DB}.${TICKETS_SCHEMA}.TICKETS_DEPARTMENTS`

// A requesting business department (managed in the Tickets dashboard). Each
// gets its own capture link at /tickets/log/<slug>.
export type TicketDepartment = { name: string; slug: string }

export const DEPT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function slugifyDepartment(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export const TICKET_STATUSES = [
  "Received",
  "In Progress",
  "On Hold",
  "Completed",
  "Rejected",
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

// Statuses that count as "open" for SLA/overdue purposes.
export const OPEN_STATUSES: readonly string[] = ["Received", "In Progress", "On Hold"]

export type TicketFieldType = "text" | "textarea" | "select" | "date" | "yesno"

export type TicketField = {
  key: string
  label: string
  type: TicketFieldType
  required: boolean
  active: boolean
  options?: string[]
}

export type TicketFormConfig = {
  fields: TicketField[]
  // Hours until SLA breach, keyed by the selected value of the "urgency" field.
  slaHoursByUrgency: Record<string, number>
}

export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/

// Seeded from the Group Data ticket form. Admins can change everything here
// from the "Customize form" page; this is only the starting point (and the
// fallback if the config table is empty/unreachable).
export const DEFAULT_FORM_CONFIG: TicketFormConfig = {
  fields: [
    {
      key: "requestType",
      label: "Request Type",
      type: "select",
      required: true,
      active: true,
      options: [
        "Snowflake Lead Distribution Request",
        "Data Extract Request",
        "Report Request",
        "Access Request",
        "Other",
      ],
    },
    {
      key: "urgency",
      label: "Urgency",
      type: "select",
      required: true,
      active: true,
      options: [
        "Low - within 5 days",
        "Medium - within 3 days",
        "High - within 24 hours",
        "Critical - within 4 hours",
      ],
    },
    { key: "dateNeeded", label: "Date needed", type: "date", required: true, active: true },
    { key: "department", label: "Department", type: "text", required: true, active: true },
    { key: "companyName", label: "Specify Company name", type: "text", required: false, active: true },
    {
      key: "personalInformation",
      label: "Personal Information",
      type: "yesno",
      required: true,
      active: true,
    },
    {
      key: "details",
      label:
        "Please clearly state the source of your leads (table and/or view) and the rules you would like applied to your data for the campaign",
      type: "textarea",
      required: true,
      active: true,
    },
    { key: "comments", label: "Comments", type: "textarea", required: false, active: true },
  ],
  slaHoursByUrgency: {
    "Low - within 5 days": 120,
    "Medium - within 3 days": 72,
    "High - within 24 hours": 24,
    "Critical - within 4 hours": 4,
  },
}

// Attachments live in Vercel Blob (private). Only the blob pathname is stored
// with the ticket; downloads go through the authenticated attachments route.
export type TicketAttachment = { name: string; size: number; pathname: string }

// Per-file limits for the PUBLIC capture endpoint. 4MB keeps the whole
// multipart request under the platform's request-body ceiling.
export const MAX_ATTACHMENTS = 3
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
export const ATTACHMENT_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "pdf", "csv", "xls", "xlsx", "doc", "docx", "txt",
]

export type TicketRow = {
  ticketId: string
  ticketRef: string
  status: string
  requestType: string | null
  urgency: string | null
  slaDueAt: string | null
  overdue: boolean
  assignedTo: string | null
  fields: Record<string, string>
  attachments: TicketAttachment[]
  createdByName: string | null
  createdByEmail: string | null
  createdAt: string | null
  updatedBy: string | null
  updatedAt: string | null
}

// Validate a form-config payload (used by the PUT route; also handy for the
// admin UI to pre-check before saving). Returns an error string or null.
export function validateFormConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return "Config must be an object"
  const c = config as Partial<TicketFormConfig>
  if (!Array.isArray(c.fields) || c.fields.length === 0) {
    return "Config must have at least one field"
  }
  const seen = new Set<string>()
  for (const f of c.fields) {
    if (!f || typeof f !== "object") return "Each field must be an object"
    if (typeof f.key !== "string" || !FIELD_KEY_RE.test(f.key)) {
      return `Invalid field key: ${String((f as { key?: unknown }).key)}`
    }
    if (seen.has(f.key)) return `Duplicate field key: ${f.key}`
    seen.add(f.key)
    if (typeof f.label !== "string" || !f.label.trim()) return `Field ${f.key} needs a label`
    if (!["text", "textarea", "select", "date", "yesno"].includes(f.type as string)) {
      return `Field ${f.key} has invalid type`
    }
    if (f.type === "select") {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return `Select field ${f.key} needs at least one option`
      }
      if (f.options.some((o) => typeof o !== "string" || !o.trim())) {
        return `Select field ${f.key} has an empty option`
      }
    }
    if (typeof f.required !== "boolean" || typeof f.active !== "boolean") {
      return `Field ${f.key} needs boolean required/active flags`
    }
  }
  if (c.slaHoursByUrgency !== undefined) {
    if (typeof c.slaHoursByUrgency !== "object" || c.slaHoursByUrgency === null) {
      return "slaHoursByUrgency must be an object"
    }
    for (const [k, v] of Object.entries(c.slaHoursByUrgency)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return `SLA hours for "${k}" must be a positive number`
      }
    }
  }
  return null
}
