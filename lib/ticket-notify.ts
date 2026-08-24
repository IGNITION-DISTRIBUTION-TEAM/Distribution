import { sendGraphMail } from "@/lib/graph-mail"

/**
 * Ticket email notifications, sent from the DWH_automation mailbox.
 *
 * Every function here is BEST EFFORT and never throws. A ticket that was written
 * to Snowflake must not be reported as failed because the mail step did — the
 * requestor would retry and log a duplicate. Failures are logged and swallowed;
 * the caller does not need to guard.
 *
 * Notifications are also skipped silently when Graph mail is not configured or
 * is disabled, so the ticket system keeps working before email is switched on.
 */

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Where a requestor can look the ticket up, when the app URL is known. */
function ticketLink(): string | null {
  return APP_URL ? `${APP_URL}/departments/tickets` : null
}

function footer(): string[] {
  const link = ticketLink()
  return [
    "",
    ...(link ? [`Track it here: ${link}`, ""] : []),
    "This is an automated message from the Ignition Distribution portal.",
    "Replies to this address are not monitored.",
  ]
}

async function trySend(
  to: string,
  subject: string,
  lines: string[],
  what: string
): Promise<boolean> {
  if (!EMAIL_RE.test(to)) return false
  try {
    await sendGraphMail({ to: [to], subject, body: lines.join("\n") })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Disabled/unconfigured mail is an expected state, not an incident — log it
    // quietly so it does not look like a fault while email is being set up.
    const expected = /disabled in App settings|no sending mailbox|GRAPH_MAIL_PRIVATE_KEY/i.test(
      message
    )
    if (expected) {
      console.info(`[ticket-notify] ${what} not sent (mail not configured): ${message}`)
    } else {
      console.error(`[ticket-notify] ${what} failed:`, message)
    }
    return false
  }
}

/** Confirmation to the requestor when a ticket is logged. */
export async function notifyTicketCreated(input: {
  ticketRef: string
  requestorName: string
  requestorEmail: string
  requestType?: string | null
  urgency?: string | null
  department?: string | null
  slaDueAt?: string | null
  attachments?: number
}): Promise<boolean> {
  const detail: string[] = []
  if (input.requestType) detail.push(`Request type: ${input.requestType}`)
  if (input.department) detail.push(`Department: ${input.department}`)
  if (input.urgency) detail.push(`Urgency: ${input.urgency}`)
  if (input.slaDueAt) detail.push(`Target response: ${input.slaDueAt}`)
  if (input.attachments && input.attachments > 0) {
    detail.push(`Attachments: ${input.attachments}`)
  }

  return trySend(
    input.requestorEmail,
    `[${input.ticketRef}] Ticket logged`,
    [
      `Hi ${input.requestorName || "there"},`,
      "",
      `Your request has been logged as ${input.ticketRef}.`,
      ...(detail.length > 0 ? ["", ...detail] : []),
      "",
      "Quote that reference in any follow-up.",
      ...footer(),
    ],
    `created ${input.ticketRef}`
  )
}

/** Update to the requestor when status or assignee changes. */
export async function notifyTicketUpdated(input: {
  ticketRef: string
  requestorName: string
  requestorEmail: string
  status?: string | null
  previousStatus?: string | null
  assignedTo?: string | null
  updatedBy: string
}): Promise<boolean> {
  const changed: string[] = []
  if (input.status) {
    changed.push(
      input.previousStatus && input.previousStatus !== input.status
        ? `Status: ${input.previousStatus} → ${input.status}`
        : `Status: ${input.status}`
    )
  }
  if (input.assignedTo) changed.push(`Assigned to: ${input.assignedTo}`)
  if (changed.length === 0) return false

  // Say what happened in the subject — a requestor scanning a mailbox should not
  // have to open it to learn whether the ticket moved forward or closed.
  const suffix = input.status ? ` — ${input.status}` : " updated"

  return trySend(
    input.requestorEmail,
    `[${input.ticketRef}] Ticket${suffix}`,
    [
      `Hi ${input.requestorName || "there"},`,
      "",
      `Ticket ${input.ticketRef} has been updated.`,
      "",
      ...changed,
      "",
      `Updated by ${input.updatedBy}.`,
      ...footer(),
    ],
    `updated ${input.ticketRef}`
  )
}
