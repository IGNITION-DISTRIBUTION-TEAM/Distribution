"use client"

/**
 * The one department shell.
 *
 * Every department dashboard used to carry its own copy of the sidebar, header
 * and footer, and the copies had drifted: five showed "Departments" twice
 * (footer AND header), two only in the footer, one only in the header; two nav
 * paradigms; two title paradigms; three content-padding schemes; and every one
 * nested a second <main> inside SidebarInset, which already renders one. This
 * file is what they all render now, so a change to the shell is one change.
 *
 * What a caller decides: the brand, the nav (flat groups or collapsible
 * sections), which item is active, an optional header action, and whether the
 * content region is padded. What a caller does NOT get to decide is where
 * "Departments" and "Logout" go, what the header shows, or how the footer reads.
 */
import { useEffect, useState, type ReactNode } from "react"
import { useAuth } from "@/lib/auth-context"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ArrowLeft, ChevronRight, LogOut } from "lucide-react"

/**
 * The commit this bundle was built from, inlined at build time by Next (see
 * next.config.mjs). An open tab keeps its cached JavaScript across a deploy
 * while API routes update immediately, so "am I looking at the new code?" is
 * a question every department page should be able to answer at a glance.
 */
export const BUILD_SHA = (process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev").slice(0, 7)

export type ShellNavItem = {
  /** Unique across all groups. Passed to onNavigate and matched against activeId. */
  id: string
  label: string
  icon?: ReactNode
  /** Hidden unless the signed-in user is a super admin. */
  adminOnly?: boolean
  /** Rendered dimmed with a "soon" tag; not selectable. */
  disabled?: boolean
  /** Appended to the tooltip of a disabled item, e.g. "awaiting billing data". */
  disabledHint?: string
  /** Indented one level (a sub-item). */
  indent?: boolean
  /** A non-selectable sub-heading row inside a group. */
  heading?: boolean
}

export type ShellNavGroup = {
  id: string
  label: string
  items: ShellNavItem[]
  /** A chevron header that folds the group; default is a flat labelled list. */
  collapsible?: boolean
  /** Collapsible only. A group containing the active item always opens. */
  defaultOpen?: boolean
}

export type DepartmentShellProps = {
  brand: { icon?: ReactNode; label: ReactNode; sublabel?: string }
  nav: ShellNavGroup[]
  activeId: string
  onNavigate: (id: string) => void
  /** Renders the single "Departments" button, in the sidebar footer. */
  onBack?: () => void
  /** Header title. Defaults to the active item's label. */
  title?: string
  /** Right-hand header slot for a page-level action (Reload, Tour). */
  headerActions?: ReactNode
  /** Default true: children sit in a p-6 wrapper. False hands them the raw scroll region. */
  padded?: boolean
  /**
   * Fade the content region in on each nav change. Default true.
   *
   * The fade needs a `key` to re-run, and a key remounts children — so pass
   * false for a department that keeps a section mounted across nav changes.
   * Task Automation does; see its call site.
   */
  animateContent?: boolean
  children: ReactNode
}

export function DepartmentShell({
  brand,
  nav,
  activeId,
  onNavigate,
  onBack,
  title,
  headerActions,
  padded = true,
  animateContent = true,
  children,
}: DepartmentShellProps) {
  const { user, logout } = useAuth()
  const isAdmin = !!user?.isSuperAdmin

  // Admin-only items drop out here, once, for every department — and a group
  // left with nothing selectable drops with them (Spot Report's Financials
  // section for a non-admin).
  const groups = nav
    .map((g) => ({ ...g, items: g.items.filter((it) => !it.adminOnly || isAdmin) }))
    .filter((g) => g.items.some((it) => !it.heading))

  const activeItem = groups.flatMap((g) => g.items).find((it) => it.id === activeId)
  const headerTitle =
    title ?? activeItem?.label ?? (typeof brand.label === "string" ? brand.label : "")

  return (
    <SidebarProvider>
      <Sidebar className="border-r border-border">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2">
            {brand.icon && <span className="[&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-primary">{brand.icon}</span>}
            <span className="font-semibold text-foreground">{brand.label}</span>
            {brand.sublabel && <span className="text-xs text-muted-foreground">{brand.sublabel}</span>}
          </div>
        </SidebarHeader>
        <Separator />
        <SidebarContent className="gap-0.5">
          {groups.map((group) =>
            group.collapsible ? (
              <CollapsibleGroup
                key={group.id}
                group={group}
                activeId={activeId}
                onNavigate={onNavigate}
              />
            ) : (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <NavList items={group.items} activeId={activeId} onNavigate={onNavigate} />
                </SidebarGroupContent>
              </SidebarGroup>
            )
          )}
        </SidebarContent>
        <SidebarFooter>
          <div className="space-y-3">
            <div className="px-2 text-sm">
              <p className="font-medium text-foreground">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground" title="Deployed build">
                build {BUILD_SHA}
              </p>
            </div>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="w-full justify-start text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Departments
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="w-full justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* SidebarInset is the page's <main>. */}
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger />
            <span className="truncate text-sm font-medium text-foreground">{headerTitle}</span>
          </div>
          {headerActions && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {padded ? (
            <div
              key={animateContent ? activeId : undefined}
              className={cn(
                "min-w-0 p-6",
                animateContent && "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
              )}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function NavList({
  items,
  activeId,
  onNavigate,
}: {
  items: ShellNavItem[]
  activeId: string
  onNavigate: (id: string) => void
}) {
  return (
    <SidebarMenu>
      {items.map((item) =>
        item.heading ? (
          <div
            key={item.id}
            className="px-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {item.label}
          </div>
        ) : (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              onClick={() => !item.disabled && onNavigate(item.id)}
              isActive={item.id === activeId}
              disabled={item.disabled}
              tooltip={
                item.disabled ? `${item.label} (${item.disabledHint ?? "coming soon"})` : item.label
              }
              className={[item.indent ? "pl-6" : "", item.disabled ? "opacity-50" : ""].join(" ").trim()}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
              {item.disabled && <span className="ml-auto text-[10px] text-muted-foreground">soon</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      )}
    </SidebarMenu>
  )
}

function CollapsibleGroup({
  group,
  activeId,
  onNavigate,
}: {
  group: ShellNavGroup
  activeId: string
  onNavigate: (id: string) => void
}) {
  const hasActive = group.items.some((it) => it.id === activeId)
  const [open, setOpen] = useState(!!group.defaultOpen || hasActive)
  // Navigating into a folded group from outside (a deep link, a header action)
  // must not leave the active item hidden.
  useEffect(() => {
    if (hasActive) setOpen(true)
  }, [hasActive])

  return (
    <SidebarGroup className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 truncate text-left">{group.label}</span>
        {hasActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
      </button>
      {open && (
        <SidebarGroupContent className="pl-1.5">
          <NavList items={group.items} activeId={activeId} onNavigate={onNavigate} />
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
