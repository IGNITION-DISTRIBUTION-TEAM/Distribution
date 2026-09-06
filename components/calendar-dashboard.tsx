"use client"

/**
 * Calendar — the department shell.
 *
 * A "task" here is a dated thing somebody put on the shared team calendar. It
 * is NOT a scheduled Snowflake procedure (Distribution → Tasks), the daily
 * checklist, or an SFTP job (Task Automation).
 *
 * TWO VIEWS OF THE SAME ROWS, and both earn their place. Month is where you
 * land: it answers "what does this month look like" and it is the only view
 * that can show a recurring series on every date it lands on. Upcoming answers
 * "what is overdue" and "what is due today", which a grid turns into a scan.
 *
 * One shared calendar: everyone with the department sees and edits every task,
 * and each row shows who created it. Sections unmount on navigation and
 * refetch their own tasks, as in task-automation-dashboard.tsx — but the
 * recipient list and the mail-enabled flag are fetched ONCE, here, because
 * neither changes between months and the month grid pages.
 */
import { useCallback, useEffect, useState } from "react"
import { CalendarDays, CalendarRange, Mail, Users } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { Banner } from "@/components/kit/banner"
import { MonthSection } from "@/components/calendar/month-section"
import { UpcomingSection } from "@/components/calendar/upcoming-section"
import { RecipientsSection } from "@/components/calendar/recipients-section"
import { NotificationsSection } from "@/components/calendar/notifications-section"
import type { TeamRecipient } from "@/components/calendar/types"

const navItems = [
  { id: "month", label: "Month", icon: <CalendarDays className="h-4 w-4" /> },
  { id: "upcoming", label: "Upcoming", icon: <CalendarRange className="h-4 w-4" /> },
  { id: "recipients", label: "Recipients", icon: <Users className="h-4 w-4" /> },
  { id: "log", label: "Notifications", icon: <Mail className="h-4 w-4" /> },
]

export function CalendarDashboard({ onBack }: { onBack?: () => void }) {
  const [activeNav, setActiveNav] = useState("month")

  /**
   * Is Graph mail switched off? Held here, not in a section.
   *
   * The first thing a person does in this department is add a task and expect
   * their team to hear about it. Learning that mail is off only once nothing
   * arrived is exactly what this banner prevents — so it has to survive
   * navigating between views, which means it cannot live in one of them.
   */
  const [mailOff, setMailOff] = useState(false)

  /**
   * The recipient list, fetched once — together with the mail flag.
   *
   * The month grid asks for a 42-day window and pages, and `mailEnabled` on
   * that response would mean re-reading the Graph config out of Snowflake on
   * every prev/next click. So the ranged endpoint returns tasks only, and the
   * two things that do not change between months are read here instead.
   */
  const [team, setTeam] = useState<TeamRecipient[]>([])

  const loadShared = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/recipients", { cache: "no-store" })
      if (!res.ok) return
      const d = await res.json()
      if (Array.isArray(d.recipients)) setTeam(d.recipients)
      if (typeof d.mailEnabled === "boolean") setMailOff(!d.mailEnabled)
    } catch {
      // The sections surface their own load errors; a missing recipient list
      // only costs the counts in the confirm dialogs, so it fails quietly.
    }
  }, [])

  useEffect(() => {
    void loadShared()
  }, [loadShared])

  // Stable identity: the sections keep this in their loader's dependency list,
  // so an inline arrow here would make that loader a new function on every
  // render of this shell and refetch the list each time.
  const handleMailEnabled = useCallback((enabled: boolean) => setMailOff(!enabled), [])

  return (
    <DepartmentShell
      brand={{ icon: <CalendarDays />, label: "Calendar", sublabel: "Shared team calendar" }}
      nav={[{ id: "cal", label: "Calendar", items: navItems }]}
      activeId={activeNav}
      onNavigate={setActiveNav}
      onBack={onBack}
    >
      <div className="flex flex-col gap-5">
        {mailOff && (
          <Banner tone="warning">
            Email is switched off for this portal, so tasks will save but nobody will be notified.
            A super admin can turn it on under Settings → Email.
          </Banner>
        )}
        {activeNav === "month" && (
          <MonthSection team={team} onMailEnabled={handleMailEnabled} />
        )}
        {activeNav === "upcoming" && <UpcomingSection onMailEnabled={handleMailEnabled} />}
        {activeNav === "recipients" && <RecipientsSection />}
        {activeNav === "log" && <NotificationsSection />}
      </div>
    </DepartmentShell>
  )
}
