// Canonical list of department ids — the single source of truth shared by the
// server (auth/session, admin API) and client (department picker, settings).
export const DEPARTMENT_IDS = ["distribution", "dialler", "spot"] as const

export type DepartmentId = (typeof DEPARTMENT_IDS)[number]

export const DEPARTMENT_LABELS: Record<DepartmentId, string> = {
  distribution: "Distribution",
  dialler: "Dialler",
  spot: "Spot",
}

export function isDepartmentId(value: string): value is DepartmentId {
  return (DEPARTMENT_IDS as readonly string[]).includes(value)
}
