import * as React from "react"

import { CHART_ANIMATION_EASING, CHART_ANIMATION_MS } from "@/lib/motion"

type ChartMotion = {
  isAnimationActive: boolean
  animationDuration?: number
  animationEasing?: typeof CHART_ANIMATION_EASING
}

/**
 * Recharts props honouring the OS reduced-motion preference.
 *
 *   const chartMotion = useChartMotion()
 *   <Bar dataKey="rows" fill={BLUE} {...chartMotion} />
 *
 * A hook rather than a constant for two reasons. Recharts is JavaScript and
 * cannot see the CSS media query in app/globals.css, so the preference has to
 * be read with matchMedia. And a module constant would be evaluated at import
 * time — on the server, where `window` does not exist — so it could differ
 * between the server render and the client, and Recharts renders an animated
 * series at its START state. That is a hydration mismatch.
 *
 * Shaped exactly like hooks/use-mobile.tsx: undefined until an effect runs, so
 * the server and the first client paint agree. The cost is that a chart already
 * mounted at hydration does not animate its first appearance — in practice
 * almost every chart here mounts after its data lands, well past that point.
 */
export function useChartMotion(): ChartMotion {
  const [reduced, setReduced] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => setReduced(mql.matches)
    mql.addEventListener("change", onChange)
    setReduced(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  if (reduced !== false) return { isAnimationActive: false }
  return {
    isAnimationActive: true,
    animationDuration: CHART_ANIMATION_MS,
    animationEasing: CHART_ANIMATION_EASING,
  }
}
