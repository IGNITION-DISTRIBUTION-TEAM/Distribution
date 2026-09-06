"use client"

/**
 * Calendar — the department shell.
 *
 * A "task" here is a dated thing somebody put on the shared team calendar. It
 * is NOT a scheduled Snowflake procedure (Distribution → Tasks), the daily
 * checklist, or an SFTP job (Task Automation). The nav says "Upcoming" rather
 * than "Tasks" so the word does not have to carry a fourth meaning.
 *
 * One shared calendar: everyone with the department sees and edits every task,
 * and each row shows who created it. Same structure as
 * task-automation-dashboard.tsx — a navItems array, a local activeNav, one
 * file per section — except that nothing here needs to stay mounted, so the
 * sections unmount and refetch on each visit.
 */
import { useCallback, useState } from "react"
import { CalendarDays, Mail, Users } from "lucide-react"
import { DepartmentShell } from "@/components/department-shell"
import { Banner } from "@/components/kit/banner"
import { UpcomingSection } from "@/components/calendar/upcoming-section"
import { RecipientsSection } from "@/components/calendar/recipients-section"
import { NotificationsSection } from "@/components/calendar/notifications-section"

const navItems = [
  { id: "upcoming", label: "Upcoming", icon: <CalendarDays className="h-4 w-4" /> },
  { id: "recipients", label: "Recipients", icon: <Users className="h-4 w-4" /> },
  { id: "log", label: "Notifications", icon: <Mail className="h-4 w-4" /> },
]

export function CalendarDashboard({ onBack }: { onBack?: () => void }) {
  const [activeNav, setActiveNav] = useState("upcoming")

  /**
   * Is Graph mail switched off? Reported up by Upcoming rather than fetched
   * here — the tasks endpoint already answers it, and asking twice would mean
   * two full list queries every time this department is opened.
   *
   * It lives on the shell so the warning survives navigating to Recipients or
   * Notifications: the first thing a person does here is add a task and expect
   * their team to hear about it, and learning that mail is off only once
   * nothing arrived is exactly what this prevents.
   */
  const [mailOff, setMailOff] = useState(false)

  // Stable identity: Upcoming keeps this in its loader's dependency list, so an
  // inline arrow here would make that loader a new function on every render of
  // this shell and refetch the list each time.
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
        {activeNav === "upcoming" && (
          <UpcomingSection onMailEnabled={handleMailEnabled} />
        )}
        {activeNav === "recipients" && <RecipientsSection />}
        {activeNav === "log" && <NotificationsSection />}
      </div>
    </DepartmentShell>
  )
}
