"use client"

import { useCallback, useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import { ArrowLeft, Check, ChevronsUpDown, LogOut, Trash2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEPARTMENT_IDS, DEPARTMENT_LABELS } from "@/lib/departments"
import { cn } from "@/lib/utils"

type EmailMapping = {
  adEmail: string
  employeeEmail: string
  createdAt: string | null
  createdBy: string | null
  jobTitle: string | null
  status: string | null
}

type EmployeeSearchResult = {
  email: string
  name?: string | null
  jobTitle: string | null
  status: string | null
}

type EmployeeDetail = Record<string, unknown>

export function AppSettings({ onBack }: { onBack: () => void }) {
  const { user, logout } = useAuth()
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Departments
          </Button>
          <span className="text-sm font-medium text-muted-foreground">App settings</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs">
            <p className="font-medium text-foreground">{user?.name}</p>
            <p className="text-muted-foreground">{user?.email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-foreground">App settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Authentication and access. Super-admin only.
          </p>
        </div>

        <Tabs defaultValue="map-user" className="w-full">
          <TabsList>
            <TabsTrigger value="map-user">Map user</TabsTrigger>
            <TabsTrigger value="email-map">Email mappings</TabsTrigger>
            <TabsTrigger value="allowed-roles">Allowed roles</TabsTrigger>
            <TabsTrigger value="department-access">Department access</TabsTrigger>
            <TabsTrigger value="super-admins">Super admins</TabsTrigger>
            <TabsTrigger value="email">Email</TabsTrigger>
          </TabsList>

          <TabsContent value="map-user" className="mt-4">
            <MapUserCard />
          </TabsContent>

          <TabsContent value="email-map" className="mt-4">
            <EmailMapPanel />
          </TabsContent>

          <TabsContent value="allowed-roles" className="mt-4">
            <AllowedRolesPanel />
          </TabsContent>

          <TabsContent value="department-access" className="mt-4">
            <UserDepartmentsPanel />
          </TabsContent>

          <TabsContent value="super-admins" className="mt-4">
            <SuperAdminsPanel />
          </TabsContent>

          <TabsContent value="email" className="mt-4">
            <GraphMailPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

type DeptGrant = { adEmail: string; department: string }
type MappedUser = { adEmail: string; jobTitle: string | null; status: string | null }

function UserDepartmentsPanel() {
  const [grants, setGrants] = useState<DeptGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [department, setDepartment] = useState<string>(DEPARTMENT_IDS[0])
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [users, setUsers] = useState<MappedUser[]>([])

  // Mapped (allowed) users to choose from, instead of typing an AD email.
  useEffect(() => {
    let cancelled = false
    fetch("/api/admin/email-map", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { mappings: [] }))
      .then((data) => {
        if (cancelled) return
        const mapped = (data.mappings ?? []) as {
          adEmail: string
          jobTitle: string | null
          status: string | null
        }[]
        setUsers(
          mapped.map((m) => ({
            adEmail: m.adEmail,
            jobTitle: m.jobTitle ?? null,
            status: m.status ?? null,
          }))
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/user-departments", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed to load grants (${res.status})`)
      setGrants(data.grants as DeptGrant[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleAdd = async () => {
    const adEmail = email.trim().toLowerCase()
    if (!adEmail) return
    setSaving(true)
    try {
      const res = await fetch("/api/admin/user-departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adEmail, department }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Add failed (${res.status})`)
      toast.success("Department access granted")
      setEmail("")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (g: DeptGrant) => {
    const key = `${g.adEmail}|${g.department}`
    setRemoving(key)
    try {
      const res = await fetch(
        `/api/admin/user-departments?adEmail=${encodeURIComponent(g.adEmail)}&department=${encodeURIComponent(g.department)}`,
        { method: "DELETE" }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`)
      toast.success("Access removed")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(null)
    }
  }

  // Hide users who already have the selected department, so the dropdown only
  // offers users who'd actually gain access. Switching department re-filters.
  const grantedForDept = new Set(
    grants
      .filter((g) => g.department.toLowerCase() === department.toLowerCase())
      .map((g) => g.adEmail.toLowerCase())
  )
  const availableUsers = users.filter((u) => !grantedForDept.has(u.adEmail.toLowerCase()))

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="font-medium text-foreground">Department access</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Grant a user access to a department by their login (AD) email. A user sees only the
        departments granted here. Super admins always see all departments. Changes take effect at
        the user&apos;s next login.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[240px]">
          <Label className="mb-1.5 block text-xs text-muted-foreground">AD email</Label>
          <Select
            value={availableUsers.some((u) => u.adEmail === email) ? email : ""}
            onValueChange={setEmail}
            disabled={availableUsers.length === 0}
          >
            <SelectTrigger className="font-mono text-sm">
              <SelectValue placeholder="Select a user..." />
            </SelectTrigger>
            <SelectContent>
              {availableUsers.map((u) => (
                <SelectItem key={u.adEmail} value={u.adEmail}>
                  <span className="font-mono">{u.adEmail}</span>
                  {u.jobTitle ? (
                    <span className="ml-2 text-xs text-muted-foreground">{u.jobTitle}</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {users.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No mapped users found — add them under &quot;Email mappings&quot;.
            </p>
          ) : availableUsers.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              All mapped users already have this department.
            </p>
          ) : null}
        </div>
        <div className="min-w-[180px]">
          <Label className="mb-1.5 block text-xs text-muted-foreground">Department</Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEPARTMENT_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {DEPARTMENT_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleAdd} disabled={saving || !email.trim()}>
          Grant access
        </Button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>AD email</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : grants.length > 0 ? (
              grants.map((g) => {
                const key = `${g.adEmail}|${g.department}`
                return (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-sm">{g.adEmail}</TableCell>
                    <TableCell className="text-sm">
                      {DEPARTMENT_LABELS[g.department as keyof typeof DEPARTMENT_LABELS] ??
                        g.department}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(g)}
                        disabled={removing === key}
                        className="text-muted-foreground hover:text-rose-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                  No grants yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function MapUserCard() {
  const [adEmail, setAdEmail] = useState("")
  const [employeeEmail, setEmployeeEmail] = useState("")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<EmployeeSearchResult[]>([])
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFor, setSavedFor] = useState<string | null>(null)

  // Debounced employee search — by email OR name.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      setSearching(false)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/employees?q=${encodeURIComponent(query)}`)
        const data = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setResults([])
          setSearchError(data.error ?? `Search failed (${r.status})`)
        } else {
          setResults(data.employees ?? [])
        }
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  // When the chosen employee email looks valid, fetch full HR record.
  useEffect(() => {
    const email = employeeEmail.trim().toLowerCase()
    if (!email || !email.includes("@")) {
      setEmployee(null)
      setLookupError(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/employee-lookup?email=${encodeURIComponent(email)}`)
        const data = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setEmployee(null)
          setLookupError(data.error ?? `HTTP ${r.status}`)
          return
        }
        setEmployee(data.employee ?? null)
        setLookupError(data.employee ? null : "No matching employee in HR.")
      } catch (e) {
        if (cancelled) return
        setEmployee(null)
        setLookupError(e instanceof Error ? e.message : String(e))
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [employeeEmail])

  const save = async () => {
    setSaving(true)
    setSavedFor(null)
    try {
      const r = await fetch("/api/admin/email-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adEmail: adEmail.trim().toLowerCase(),
          employeeEmail: employeeEmail.trim().toLowerCase(),
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setSavedFor(adEmail.trim().toLowerCase())
      toast.success("Mapping saved — user can now log in")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="text-lg font-medium text-foreground">Map an Azure AD user to an employee</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the user&apos;s Azure AD email and pick the matching employee from HR. The
        details below come straight from{" "}
        <span className="font-mono text-xs">EMPLOYEE_DETAIL</span> so you can confirm before
        saving.
      </p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div>
          <Label className="mb-1 block text-sm">Azure AD email</Label>
          <Input
            value={adEmail}
            onChange={(e) => setAdEmail(e.target.value)}
            placeholder="firstname.lastname@ignitiongroup.co.za"
          />
        </div>
        <div>
          <Label className="mb-1 block text-sm">Employee email (from HR)</Label>
          <Input
            value={employeeEmail}
            onChange={(e) => {
              setEmployeeEmail(e.target.value)
              setQuery(e.target.value)
            }}
            placeholder="search by name or email…"
          />
          {searching && (
            <p className="mt-1 text-xs text-muted-foreground">Searching HR…</p>
          )}
          {searchError && (
            <p className="mt-1 text-xs text-rose-400">Search failed: {searchError}</p>
          )}
          {!searching && !searchError && query.trim().length >= 2 && results.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No active employees match &quot;{query.trim()}&quot;.
            </p>
          )}
          {results.length > 0 && (
            <div className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-background">
              {results.map((emp) => (
                <button
                  type="button"
                  key={emp.email}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-accent/40"
                  onClick={() => {
                    setEmployeeEmail(emp.email)
                    setQuery("")
                    setResults([])
                  }}
                >
                  <div className="text-foreground">{emp.name || emp.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {emp.name ? `${emp.email} · ` : ""}
                    {emp.jobTitle ?? "no title"} · {emp.status ?? "no status"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-dashed border-border bg-background/40 p-4">
        <h4 className="text-sm font-medium text-foreground">HR details</h4>
        {lookupError && (
          <p className="mt-2 text-sm text-rose-400">{lookupError}</p>
        )}
        {!employee && !lookupError && (
          <p className="mt-2 text-sm text-muted-foreground">
            Enter or select an employee email to load HR details.
          </p>
        )}
        {employee && <EmployeeDetailGrid employee={employee} />}
      </div>

      {savedFor && (
        <p className="mt-4 text-sm text-emerald-300">
          Mapping saved for <span className="font-mono">{savedFor}</span>. Once this user has an
          allowed role, they can sign in.
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          onClick={save}
          disabled={saving || !adEmail.trim() || !employeeEmail.trim() || !employee}
        >
          {saving ? "Saving..." : "Save mapping"}
        </Button>
      </div>
    </div>
  )
}

function EmployeeDetailGrid({ employee }: { employee: EmployeeDetail }) {
  // Display friendly subset; fall back across common column-name variations
  // because Sage extracts can differ between sources.
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = employee[k]
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v)
    }
    return ""
  }

  const firstName = pick("FIRST_NAME", "FIRSTNAME", "GIVEN_NAME")
  const lastName = pick("LAST_NAME", "LASTNAME", "SURNAME", "FAMILY_NAME")
  const fullName =
    pick("EMPLOYEE_NAME", "FULL_NAME") ||
    [firstName, lastName].filter(Boolean).join(" ")
  const jobTitle = pick("JOB_TITLE", "POSITION", "JOB", "TITLE")
  const department = pick("DEPARTMENT", "DEPT", "DEPARTMENT_NAME", "DIVISION")
  const manager = pick(
    "LINE_MANAGER",
    "LINE_MANAGER_NAME",
    "MANAGER",
    "MANAGER_NAME",
    "SUPERVISOR",
    "REPORTS_TO"
  )
  const status = pick("EMPLOYEE_STATUS_DISPLAY", "EMPLOYEE_STATUS", "STATUS")
  const email = pick("EMAIL_ADDRESS", "EMAIL")
  const employeeNumber = pick("EMPLOYEE_NUMBER", "EMPLOYEE_ID", "EMP_NO", "EMP_ID")

  const items: { label: string; value: string }[] = [
    { label: "Name", value: fullName },
    { label: "Job title", value: jobTitle },
    { label: "Department", value: department },
    { label: "Manager", value: manager },
    { label: "Status", value: status },
    { label: "Email", value: email },
    { label: "Employee no.", value: employeeNumber },
  ].filter((i) => i.value)

  if (items.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Record found, but none of the expected name/title/department columns are populated.
      </p>
    )
  }

  const active = status.toUpperCase().startsWith("A")

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label}>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{i.label}</div>
          <div className="text-sm text-foreground">{i.value}</div>
        </div>
      ))}
      {status && (
        <div className="sm:col-span-2">
          <span
            className={
              "inline-flex items-center rounded-full border px-2 py-0.5 text-xs " +
              (active
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/30 bg-rose-500/10 text-rose-300")
            }
          >
            {active ? "Active employee — allowed to log in" : `${status} — will be blocked`}
          </span>
        </div>
      )}
    </div>
  )
}

function EmailMapPanel() {
  const [mappings, setMappings] = useState<EmailMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/admin/email-map")
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setMappings(data.mappings ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const remove = async (adEmail: string) => {
    if (!confirm(`Remove mapping for ${adEmail}?`)) return
    try {
      const r = await fetch(`/api/admin/email-map?adEmail=${encodeURIComponent(adEmail)}`, {
        method: "DELETE",
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await load()
      toast.success("Mapping removed")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-6 py-4">
        <h3 className="font-medium text-foreground">Existing mappings</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Add new mappings on the &ldquo;Map user&rdquo; tab.
        </p>
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Azure AD email</TableHead>
              <TableHead>Employee email</TableHead>
              <TableHead>Role (JOB_TITLE)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            )}
            {!loading && mappings.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No mappings yet.
                </TableCell>
              </TableRow>
            )}
            {mappings.map((m) => {
              const active = (m.status ?? "").toUpperCase().startsWith("A")
              return (
                <TableRow key={m.adEmail}>
                  <TableCell className="font-mono text-xs">{m.adEmail}</TableCell>
                  <TableCell className="font-mono text-xs">{m.employeeEmail}</TableCell>
                  <TableCell className="text-sm">
                    {m.jobTitle ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {m.status ? (
                      <span
                        className={
                          "inline-flex items-center rounded-full border px-2 py-0.5 " +
                          (active
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-300")
                        }
                      >
                        {m.status}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">no HR record</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.createdBy ?? ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(m.adEmail)}
                      className="text-muted-foreground hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function AllowedRolesPanel() {
  const [roles, setRoles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [newRole, setNewRole] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobTitles, setJobTitles] = useState<string[]>([])
  const [titlesLoading, setTitlesLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/admin/allowed-roles")
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setRoles(data.roles ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Load distinct job titles from HR for the selector
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const r = await fetch("/api/admin/job-titles")
        const data = await r.json()
        if (!cancelled && r.ok) setJobTitles(data.jobTitles ?? [])
      } catch {
        // ignore — selector falls back to empty list
      } finally {
        if (!cancelled) setTitlesLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [])

  const add = async () => {
    const trimmed = newRole.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const r = await fetch("/api/admin/allowed-roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: trimmed }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setNewRole("")
      await load()
      toast.success("Role added")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (role: string) => {
    if (!confirm(`Remove "${role}" from allowed roles?`)) return
    try {
      const r = await fetch(`/api/admin/allowed-roles?role=${encodeURIComponent(role)}`, {
        method: "DELETE",
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await load()
      toast.success("Role removed")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Add an allowed role</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a job title from HR. Matching is case-insensitive against{" "}
          <span className="font-mono text-xs">JOB_TITLE</span>.
        </p>
        <div className="mt-4 flex gap-2">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                disabled={titlesLoading}
                className="flex-1 justify-between font-normal"
              >
                <span className={cn("truncate", !newRole && "text-muted-foreground")}>
                  {titlesLoading
                    ? "Loading job titles..."
                    : newRole || "Select a job title..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search job title..." />
                <CommandList>
                  <CommandEmpty>No job title found.</CommandEmpty>
                  <CommandGroup>
                    {jobTitles.map((title) => {
                      const alreadyAllowed = roles.some(
                        (r) => r.toLowerCase() === title.toLowerCase()
                      )
                      return (
                        <CommandItem
                          key={title}
                          value={title}
                          disabled={alreadyAllowed}
                          onSelect={() => {
                            if (alreadyAllowed) return
                            setNewRole(title)
                            setPickerOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              newRole.toLowerCase() === title.toLowerCase()
                                ? "opacity-100"
                                : "opacity-0"
                            )}
                          />
                          <span className={cn(alreadyAllowed && "text-muted-foreground")}>
                            {title}
                          </span>
                          {alreadyAllowed && (
                            <span className="ml-auto text-xs text-muted-foreground">added</span>
                          )}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button onClick={add} disabled={saving || !newRole.trim()}>
            {saving ? "..." : "Add"}
          </Button>
        </div>
        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-6 py-4">
          <h3 className="font-medium text-foreground">Allowed roles</h3>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead className="w-16 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {!loading && roles.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                    No allowed roles yet — nobody (except super admins) can log in.
                  </TableCell>
                </TableRow>
              )}
              {roles.map((role) => (
                <TableRow key={role}>
                  <TableCell>{role}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(role)}
                      className="text-muted-foreground hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

function SuperAdminsPanel() {
  const { user } = useAuth()
  const [admins, setAdmins] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adEmail, setAdEmail] = useState("")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<EmployeeSearchResult[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/admin/super-admins")
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setAdmins(data.admins ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Debounced employee search — helps the admin find the right AD email.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/employees?q=${encodeURIComponent(query)}`)
        const data = await r.json()
        if (r.ok) setResults(data.employees ?? [])
      } catch {
        // ignore
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const add = async () => {
    const email = adEmail.trim().toLowerCase()
    if (!email) return
    if (!confirm(`Grant super admin access to ${email}?`)) return
    setSaving(true)
    try {
      const r = await fetch("/api/admin/super-admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adEmail: email }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setAdEmail("")
      setQuery("")
      setResults([])
      await load()
      toast.success("Super admin added")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (email: string) => {
    const isSelf = email === (user?.email ?? "").toLowerCase()
    const msg = isSelf
      ? "Remove yourself as super admin? You'll lose access to App settings."
      : `Remove ${email} as super admin?`
    if (!confirm(msg)) return
    try {
      const r = await fetch(`/api/admin/super-admins?adEmail=${encodeURIComponent(email)}`, {
        method: "DELETE",
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await load()
      toast.success("Super admin removed")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Grant super admin access</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Super admins bypass the role/active gate and can manage these settings. Add sparingly.
        </p>
        <div className="mt-4">
          <Label className="mb-1 block text-sm">Azure AD email</Label>
          <Input
            value={adEmail}
            onChange={(e) => {
              setAdEmail(e.target.value)
              setQuery(e.target.value)
            }}
            placeholder="firstname.lastname@ignitiongroup.co.za"
          />
          {results.length > 0 && (
            <div className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-background">
              {results.map((emp) => (
                <button
                  type="button"
                  key={emp.email}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-accent/40"
                  onClick={() => {
                    setAdEmail(emp.email)
                    setQuery("")
                    setResults([])
                  }}
                >
                  <div className="text-foreground">{emp.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {emp.jobTitle ?? "no title"} · {emp.status ?? "no status"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={add} disabled={saving || !adEmail.trim()}>
            {saving ? "Adding..." : "Grant super admin"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-6 py-4">
          <h3 className="font-medium text-foreground">Current super admins</h3>
          {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Azure AD email</TableHead>
                <TableHead className="w-16 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {!loading && admins.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                    No super admins.
                  </TableCell>
                </TableRow>
              )}
              {admins.map((email) => {
                const isSelf = email === (user?.email ?? "").toLowerCase()
                return (
                  <TableRow key={email}>
                    <TableCell className="font-mono text-xs">
                      {email}
                      {isSelf && (
                        <span className="ml-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          you
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(email)}
                        className="text-muted-foreground hover:text-rose-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

// --- Email (Microsoft Graph, app-only certificate auth) -------------------
//
// Sends as a dedicated mailbox via Graph using the client-credentials flow with
// certificate authentication. Only the non-secret identifiers are editable
// here; the certificate private key lives in a server environment variable and
// is never sent to the browser.
type GraphMailConfig = {
  mailbox: string
  tenantId: string
  clientId: string
  thumbprint: string
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

function GraphMailPanel() {
  const [mailbox, setMailbox] = useState("")
  const [tenantId, setTenantId] = useState("")
  const [clientId, setClientId] = useState("")
  const [thumbprint, setThumbprint] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [meta, setMeta] = useState<{ updatedAt: string | null; updatedBy: string | null }>({
    updatedAt: null,
    updatedBy: null,
  })
  const [privateKeyPresent, setPrivateKeyPresent] = useState(false)
  const [keyStatus, setKeyStatus] = useState<{
    present: boolean
    usable: boolean
    detail: string
    passphraseSet?: boolean
  } | null>(null)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<"token" | "send" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testTo, setTestTo] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/admin/graph-mail", { cache: "no-store" })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      const c = data.config as GraphMailConfig
      setMailbox(c.mailbox)
      setTenantId(c.tenantId)
      setClientId(c.clientId)
      setThumbprint(c.thumbprint)
      setEnabled(c.enabled)
      setMeta({ updatedAt: c.updatedAt, updatedBy: c.updatedBy })
      setPrivateKeyPresent(!!data.privateKeyPresent)
      setKeyStatus(data.keyStatus ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch("/api/admin/graph-mail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox, tenantId, clientId, thumbprint, enabled }),
      })
      const data = await r.json()
      // A 400 from the enable guardrail still returns the saved config and the
      // key diagnosis — reflect both before surfacing the message.
      if (data.keyStatus) setKeyStatus(data.keyStatus)
      if (typeof data.privateKeyPresent === "boolean") setPrivateKeyPresent(data.privateKeyPresent)
      if (data.config) {
        const saved = data.config as GraphMailConfig
        setMeta({ updatedAt: saved.updatedAt, updatedBy: saved.updatedBy })
        setEnabled(saved.enabled)
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      toast.success("Email settings saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (mode: "token" | "send") => {
    setTesting(mode)
    try {
      const r = await fetch("/api/admin/graph-mail/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "send" ? { mode, to: testTo } : { mode }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      toast.success(data.message || "Test succeeded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Outbound email (Microsoft Graph)</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The app authenticates as itself (client-credentials flow with certificate authentication) to get
          an app-only token, then posts to{" "}
          <span className="font-mono text-xs">/users/&lt;mailbox&gt;/sendMail</span>. The registration is
          scoped to this one mailbox only.
        </p>

        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label className="mb-1 block text-sm">Sending mailbox</Label>
            <Input
              value={mailbox}
              onChange={(e) => setMailbox(e.target.value)}
              placeholder="DWH_automation@ignitiongroup.co.za"
              className="font-mono text-sm"
              disabled={loading}
            />
          </div>
          <div>
            <Label className="mb-1 block text-sm">Directory (tenant) ID</Label>
            <Input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="font-mono text-sm"
              disabled={loading}
            />
          </div>
          <div>
            <Label className="mb-1 block text-sm">Application (client) ID</Label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="font-mono text-sm"
              disabled={loading}
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1 block text-sm">Certificate thumbprint (SHA-1, hex)</Label>
            <Input
              value={thumbprint}
              onChange={(e) => setThumbprint(e.target.value)}
              placeholder="A1B2C3D4E5F60718293A4B5C6D7E8F9012345678"
              className="font-mono text-sm"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Spaces and colons are stripped automatically.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between rounded-lg border border-border bg-background/40 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Enable sending</p>
            <p className="text-xs text-muted-foreground">
              When off, the app keeps the config but refuses to send.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={loading} />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {meta.updatedAt
              ? `Last saved ${new Date(meta.updatedAt).toLocaleString()}${
                  meta.updatedBy ? ` by ${meta.updatedBy}` : ""
                }`
              : "Not saved yet."}
          </p>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? "Saving..." : "Save settings"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Certificate private key</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The private key is a credential that can send mail as this mailbox, so it is{" "}
          <span className="text-foreground">not</span> stored in the database or editable here. It is read
          from the <span className="font-mono text-xs">GRAPH_MAIL_PRIVATE_KEY</span> environment variable
          on the server.
        </p>

        <div className="mt-4 flex items-start gap-2 text-sm">
          <span
            className={cn(
              "mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full",
              loading
                ? "bg-muted-foreground"
                : keyStatus?.usable
                ? "bg-emerald-400"
                : keyStatus?.present
                ? "bg-amber-400"
                : "bg-rose-400"
            )}
          />
          {loading ? (
            <span className="text-muted-foreground">Checking...</span>
          ) : keyStatus ? (
            <span
              className={cn(
                keyStatus.usable
                  ? "text-emerald-300"
                  : keyStatus.present
                  ? "text-amber-200"
                  : "text-rose-300"
              )}
            >
              {keyStatus.detail}
            </span>
          ) : privateKeyPresent ? (
            <span className="text-emerald-300">Private key is present on the server.</span>
          ) : (
            <span className="text-rose-300">
              No private key found — sending cannot be enabled until it is set.
            </span>
          )}
        </div>
        {!loading && keyStatus && !keyStatus.usable && (
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load}>
              Re-check
            </Button>
            <span className="text-xs text-muted-foreground">
              After adding the variable, redeploy first — then re-check.
            </span>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-border bg-background/40 p-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Setting it up (once)</p>
          <p className="mt-2">
            Azure issues the certificate as a password-protected{" "}
            <span className="font-mono">.pfx</span>. Node cannot read PKCS#12 directly, so convert it to a
            PEM private key and set that as the environment variable:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
{`# 1. convert the .pfx (enter the certificate password when prompted)
openssl pkcs12 -in DWH_automation-app-private.pfx -nocerts -nodes -out key.pem

# 2. verify the key, print the thumbprint, write an env-ready value
node scripts/graph-cert-check.mjs key.pem DWH_automation-app-public.cer

# 3. paste the value into Vercel > Settings > Environment Variables,
#    redeploy, then delete key.pem and .env-snippet.txt`}
          </pre>
          <p className="mt-2">
            Step 2 confirms the private key really matches the certificate registered in Azure and prints
            the thumbprint for the field above — worth doing, since a mismatch otherwise only shows up as
            an opaque Azure AD error. Run it on your own machine, never a shared one.
          </p>
          <p className="mt-3 font-medium text-foreground">Where the variable goes</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              <span className="text-foreground">Deployed (Vercel):</span> Project → Settings → Environment
              Variables. Tick the environment this deployment actually runs in (Production and Preview are
              separate), then <span className="text-foreground">redeploy</span> — Vercel only applies
              variables to new deployments, so an existing deployment keeps seeing nothing.
            </li>
            <li>
              <span className="text-foreground">Local dev:</span> add it to{" "}
              <span className="font-mono">.env.local</span> and restart{" "}
              <span className="font-mono">npm run dev</span>.
            </li>
          </ul>
          <p className="mt-2">
            Paste <span className="text-foreground">only the key</span> into the value box — from{" "}
            <span className="font-mono">-----BEGIN</span> to <span className="font-mono">-----END</span>,
            with no <span className="font-mono">GRAPH_MAIL_PRIVATE_KEY=</span> prefix and no surrounding
            quotes. (The generated snippet file is in <span className="font-mono">.env</span> format, which
            is right for <span className="font-mono">.env.local</span> but not for Vercel&apos;s value box.)
          </p>
          <p className="mt-2">
            To keep the key encrypted at rest, drop <span className="font-mono">-nodes</span> and also set{" "}
            <span className="font-mono">GRAPH_MAIL_KEY_PASSPHRASE</span>. A base64 blob of the PEM, or a
            PEM with escaped newlines, is accepted too. Redeploy after changing it.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-medium text-foreground">Test</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tests run against the saved settings and ignore the enable toggle, so you can verify before
          switching it on.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Button variant="outline" onClick={() => runTest("token")} disabled={!!testing || loading}>
            {testing === "token" ? "Checking..." : "Verify certificate auth"}
          </Button>
          <div className="min-w-[260px] flex-1">
            <Label className="mb-1 block text-sm">Send a test message to</Label>
            <Input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@ignitiongroup.co.za"
              className="font-mono text-sm"
              disabled={loading}
            />
          </div>
          <Button onClick={() => runTest("send")} disabled={!!testing || loading || !testTo.trim()}>
            {testing === "send" ? "Sending..." : "Send test"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          &ldquo;Verify certificate auth&rdquo; only mints a token — it does not send mail.
        </p>
      </div>
    </div>
  )
}
