"use client"

import { useCallback, useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { isPasswordSignInEnabled, setPasswordSignInEnabled } from "@/lib/settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
            <TabsTrigger value="sign-in">Sign-in options</TabsTrigger>
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

          <TabsContent value="sign-in" className="mt-4">
            <SignInOptionsPanel />
          </TabsContent>
        </Tabs>
      </main>
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
  const [saving, setSaving] = useState(false)
  const [savedFor, setSavedFor] = useState<string | null>(null)

  // Debounced employee search
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
            placeholder="search by email..."
          />
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
                  <div className="text-foreground">{emp.email}</div>
                  <div className="text-xs text-muted-foreground">
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

function SignInOptionsPanel() {
  const [passwordEnabled, setPasswordEnabledState] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setPasswordEnabledState(isPasswordSignInEnabled())
    setHydrated(true)
  }, [])

  const handleToggle = (next: boolean) => {
    setPasswordEnabledState(next)
    setPasswordSignInEnabled(next)
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1">
          <h3 className="font-medium text-foreground">Email &amp; password sign-in</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            When off, only the &ldquo;Sign in with Azure AD&rdquo; button is shown on the login
            screen. The email/password form is a mock login that accepts any credentials, so
            leaving it off is recommended.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            This preference is stored in your browser, so it only affects this device.
          </p>
        </div>
        <Switch
          checked={passwordEnabled}
          onCheckedChange={handleToggle}
          disabled={!hydrated}
          aria-label="Toggle email/password sign-in"
        />
      </div>
    </div>
  )
}
