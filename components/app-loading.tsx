import { Skeleton } from "@/components/ui/skeleton"

/**
 * Shown while the session is still being checked.
 *
 * Until this existed, every hard load of a department URL flashed the LOGIN
 * SCREEN before the dashboard: the auth context threw away its "session known
 * yet?" flag, so "still checking" and "logged out" were indistinguishable and
 * both rendered the login card. Same ground colour as the login screen and the
 * dashboards, one wordmark, one pulsing bar — nothing that could be mistaken
 * for a page you can act on.
 */
export function AppLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background"
    >
      <span className="sr-only">Loading</span>
      <span className="text-sm font-semibold tracking-wide text-muted-foreground">Ignition Group</span>
      <Skeleton className="h-1.5 w-48 rounded-full" />
    </div>
  )
}
