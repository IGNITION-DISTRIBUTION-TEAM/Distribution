import { executeSnowflakeQuery } from "@/lib/snowflake"

// Strict email shape so we don't have to worry about SQL injection in the
// raw-string queries below. Anything that doesn't match is rejected before
// touching Snowflake.
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export type AccessResult =
  | { allowed: true; role: string | null; isSuperAdmin: boolean; employeeEmail: string | null }
  | {
      allowed: false
      reason: "invalid_email" | "unmapped" | "no_employee" | "inactive" | "role_not_allowed"
      role?: string
    }

/**
 * Decide whether an Azure-AD-authenticated user is allowed in.
 *
 * Flow:
 *   1. APP_SUPER_ADMINS -> bypass everything.
 *   2. APP_USER_EMAIL_MAP -> translate AD email to employee email.
 *   3. EMPLOYEE_DETAIL.JOB_TITLE for that employee email.
 *   4. APP_ALLOWED_ROLES contains that title -> allow.
 */
export async function checkAccess(adEmailRaw: string): Promise<AccessResult> {
  const adEmail = adEmailRaw.trim().toLowerCase()
  if (!isValidEmail(adEmail)) return { allowed: false, reason: "invalid_email" }

  const e = sqlString(adEmail)

  // 1. Super admin?
  const superAdmins = await executeSnowflakeQuery<{ AD_EMAIL: string }>(
    `SELECT AD_EMAIL FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS WHERE LOWER(AD_EMAIL) = ${e}`
  )
  if (superAdmins.length > 0) {
    return { allowed: true, role: null, isSuperAdmin: true, employeeEmail: null }
  }

  // 2. Mapped employee email?
  const mapping = await executeSnowflakeQuery<{ EMPLOYEE_EMAIL: string }>(
    `SELECT EMPLOYEE_EMAIL FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_EMAIL_MAP WHERE LOWER(AD_EMAIL) = ${e}`
  )
  if (mapping.length === 0) return { allowed: false, reason: "unmapped" }

  const employeeEmail = String(mapping[0].EMPLOYEE_EMAIL).trim().toLowerCase()
  if (!isValidEmail(employeeEmail)) return { allowed: false, reason: "unmapped" }
  const ee = sqlString(employeeEmail)

  // 3. Active job title from HR? An employee may have multiple rows
  // (e.g. a Terminated record alongside an Active one), so we filter
  // explicitly rather than relying on whichever row LIMIT 1 returns.
  const activeEmployees = await executeSnowflakeQuery<{ JOB_TITLE: string | null }>(
    `SELECT JOB_TITLE
     FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
     WHERE LOWER(EMAIL_ADDRESS) = ${ee}
       AND UPPER(TRIM(EMPLOYEE_STATUS_DISPLAY)) LIKE 'A%'
     LIMIT 1`
  )
  if (activeEmployees.length === 0) {
    // Distinguish "no row at all" from "row exists but inactive".
    const anyRow = await executeSnowflakeQuery<{ X: number }>(
      `SELECT 1 AS X
       FROM DATAWAREHOUSE.HR_SAGE_DATA.EMPLOYEE_DETAIL
       WHERE LOWER(EMAIL_ADDRESS) = ${ee}
       LIMIT 1`
    )
    return { allowed: false, reason: anyRow.length === 0 ? "no_employee" : "inactive" }
  }

  const role = (activeEmployees[0].JOB_TITLE ?? "").trim()
  if (!role) return { allowed: false, reason: "role_not_allowed", role: "" }

  // 4. Role allowed?
  const r = sqlString(role)
  const allowed = await executeSnowflakeQuery<{ ROLE: string }>(
    `SELECT ROLE FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_ALLOWED_ROLES WHERE LOWER(ROLE) = LOWER(${r})`
  )
  if (allowed.length === 0) return { allowed: false, reason: "role_not_allowed", role }

  return { allowed: true, role, isSuperAdmin: false, employeeEmail }
}

/**
 * Read the departments an AD-authenticated user has been granted. Returns
 * lowercase department ids. Super admins are handled by the caller (they see
 * all). Throws if the grants table is unavailable — the caller decides how to
 * handle that (we fail open to avoid locking everyone out before provisioning).
 */
export async function getUserDepartments(adEmailRaw: string): Promise<string[]> {
  const adEmail = adEmailRaw.trim().toLowerCase()
  if (!isValidEmail(adEmail)) return []
  const e = sqlString(adEmail)
  const rows = await executeSnowflakeQuery<{ DEPARTMENT: string }>(
    `SELECT DEPARTMENT FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_USER_DEPARTMENTS WHERE LOWER(AD_EMAIL) = ${e}`
  )
  return rows.map((r) => String(r.DEPARTMENT).trim().toLowerCase()).filter(Boolean)
}

export async function isSuperAdmin(adEmailRaw: string): Promise<boolean> {
  const adEmail = adEmailRaw.trim().toLowerCase()
  if (!isValidEmail(adEmail)) return false
  const e = sqlString(adEmail)
  const rows = await executeSnowflakeQuery<{ AD_EMAIL: string }>(
    `SELECT AD_EMAIL FROM DATAWAREHOUSE.LEADS_DISTRIBUTION.APP_SUPER_ADMINS WHERE LOWER(AD_EMAIL) = ${e}`
  )
  return rows.length > 0
}
