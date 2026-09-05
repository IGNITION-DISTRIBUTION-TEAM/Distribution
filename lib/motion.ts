/**
 * The motion system. Small on purpose.
 *
 * This is an internal dashboard people work in all day, so motion here has one
 * job: make the UI feel responsive. Anything that draws attention to itself
 * costs more on the two-hundredth nav click than it earns on the first.
 *
 * THE VOCABULARY — four class strings, and nothing else:
 *
 *   transition-colors duration-150                     hover / press colour
 *   transition-transform duration-150                  a chevron, a caret
 *   animate-in fade-in-0 slide-in-from-bottom-1
 *     duration-200 ease-out                            content entering (nav switch)
 *   animate-in fade-in-0 duration-200 ease-out         a whole region/page entering
 *
 * `slide-in-from-bottom-1` is 4px. That is the most anything moves.
 *
 * BANNED, and why — each of these was considered and rejected, so please read
 * the reason before adding one back:
 *
 *   No scale (hover:scale-*, active:scale-*). On a dense dashboard it resamples
 *   text and makes tables shimmer. Radix's own zoom-in-95 is upstream's and
 *   stays in components/ui/.
 *
 *   No delay-*, no stagger. Product reason: staggering a 30-tile grid lands the
 *   last tile ~1s after the click. Mechanical reason: tailwindcss-animate's
 *   `animate-in` sets no fill-mode, so a delayed element sits fully visible,
 *   snaps to opacity 0, then fades — a flash.
 *
 *   No duration above 200ms in product code. CHART_ANIMATION_MS below is the
 *   single exception and it lives here, in one file, so it cannot spread by
 *   copy-paste.
 *
 *   No exit animations — they need the outgoing tree kept mounted, which means
 *   a presence layer and two trees in the DOM for a 200ms fade.
 *
 *   One moving region per interaction. If the content fades, the header does not.
 *
 * Gotcha: `duration-*` sets BOTH transition-duration and animation-duration, so
 * a single element cannot carry a 150ms hover and a 200ms enter. Use two elements.
 *
 * scripts/check-ui-consistency.mjs enforces most of the above and fails
 * `npm test` on a breach.
 */

/**
 * Chart entry animation, in milliseconds.
 *
 * Recharts' own default is 1500ms, which is nowhere near restrained. 350 rather
 * than the 200 used for CSS because a chart interpolates values across the plot
 * area rather than fading a 4px offset: at 200ms a bar growing reads as a
 * flicker, at 350 it reads as drawing in.
 */
export const CHART_ANIMATION_MS = 350

export const CHART_ANIMATION_EASING = "ease-out" as const

/**
 * Opt one chart out of animation.
 *
 * For a chart whose data changes on a timer rather than on a user action —
 * Recharts replays its entry animation on every data change, and a chart that
 * redraws itself once a minute while you are reading it is a distraction, not
 * feedback.
 */
export const CHART_MOTION_OFF = { isAnimationActive: false } as const
