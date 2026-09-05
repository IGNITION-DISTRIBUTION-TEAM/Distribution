# Portal click-through checklist

The redesign put every department on one shell and one component kit, and
guarded every API route. `tsc`, `next build`, `npm test` and `eslint` are green,
but there are no component tests and no Snowflake access from the build
machine, so **what a page actually shows against live data is checked by a
person**. This is that check. Run it once after deploy; tick each row.

Build marker: every department's sidebar footer now shows `build <sha>`. If it
does not match `git rev-parse --short HEAD` of the deploy, hard-reload
(Ctrl/Cmd+Shift+R) — an open tab keeps its old JavaScript across a deploy.

## Global — run once

| # | Step | Expected | OK? |
|---|---|---|---|
| G1 | Open the portal signed out | Login card with the Ignition logo; "Sign in with Azure AD" | |
| G2 | Append `?auth_error=access_denied&reason=unmapped` to the login URL | A rose error banner with an icon, under the title | |
| G3 | DevTools → Elements → `<body>` → Computed → `font-family` | Starts with `Inter` (it was Arial until this release) | |
| G4 | Sign in | Department picker; only your granted departments; EDC tile dimmed "Coming soon" | |
| G5 | Hover a ghost button (e.g. Logout in the picker header) | Neutral grey hover, **not** solid green | |
| G6 | Open any `Select` dropdown (Distribution → Manual has several) and hover an item | Neutral highlight, not green | |
| G7 | DevTools → Elements, search `<main` on any department page | Exactly **one** `<main>` (it was nested twice before) | |
| G8 | Signed-out `curl -i https://<host>/api/campaigns` | `401` — every Distribution route now requires a session | |
| G9 | Signed-out `curl -i https://<host>/api/debug/snowflake-test` | `404` — deleted | |

## Every department — repeat per department

| # | Step | Expected | OK? |
|---|---|---|---|
| D1 | Open from the picker | Sidebar: brand icon + name at top, nav below, your name/email + `build <sha>` + **Departments** + **Logout** at the bottom | |
| D2 | Header | Sidebar trigger on the left, then the **active section's name**. No second "Departments" button in the header | |
| D3 | Click every nav item | Content renders; browser console shows no red errors | |
| D4 | Ctrl/Cmd+B (or the trigger) | Sidebar collapses; trigger + title remain | |
| D5 | Narrow the window under 768px | Sidebar becomes a slide-over sheet | |
| D6 | Any table on the page | Muted header row, small uppercase-free labels, `px-3 py-2` cells — identical density on every page | |
| D7 | Trigger an error (e.g. a bad input) | Rose banner with an icon; success actions show an emerald banner; warnings amber | |
| D8 | **Departments** in the footer | Returns to the picker | |

## Department-specific

| Department | Step | Expected | OK? |
|---|---|---|---|
| Dialler | Open | Now has the sidebar; "Overview" active; placeholder card | |
| Spot | ARPU File → history table | Renders with the shared table style; upload still merges | |
| Spot | Rates / Airtime Rates | Pages open; confirmation dialog shows current row count | |
| Task Automation | Start Create job, pick a file, click Current jobs, click back | Wizard state **survived**; nav item reads "Editing <NAME>" when a job is open | |
| Task Automation | Current jobs / Tasks / SFTP endpoints tables | Shared table style; the wizard's three preview grids keep sticky headers when scrolled | |
| Tickets | As a **non**-super-admin | "Departments" and "Customize form" nav items are **absent** | |
| Tickets | Log a ticket → save | Emerald "Ticket <ref> logged" banner | |
| Tickets | Customize form → save | Emerald "Form saved." banner | |
| Reporting | Open | Both sections expanded; active dot beside the section holding the current report | |
| Reporting | Each of the 5 reports | Charts render; stat tiles are the compact style (denser than before — intended) | |
| Spot Report | Open | All six sections collapsed; **Sales Trends** active and its section opened by the shell | |
| Spot Report | As a non-admin | **Financials** section absent | |
| Spot Report | A native report (Sales Trends) | Renders with its own padding | |
| Spot Report | An unbuilt item (e.g. Income Statement) | Dimmed with "soon", not clickable | |
| Spot Report | Any iframe report (none remain in the menu today; if one is added) | Loads on white, topbar hidden, **Reload** appears in the header only then | |
| EngAIge | Tour button in the header | Tour opens and drives the nav | |
| EngAIge | Monitoring charts | Tooltips show the same decimals as before (not rounded) | |
| EngAIge | Run a config | Run message appears as emerald/rose banner under the row | |
| Distribution | Every one of the 9 nav items | Renders | |
| Distribution | Settings → save | A toast appears (toasts are intentionally kept here) | |
| Distribution | Automation → edit a task | Schedule frequency / day / time populate (the fields whose type was stale) | |
| Distribution | Manual → step result | Emerald or rose banner depending on outcome | |
| Distribution | Extend Expired, Temp Upload, Daily Files tables | Shared table style; the five scrollable preview grids keep sticky headers | |
| Distribution | Daily Files summary tiles | Compact tile style; "Lead rows by batch" value in green | |

## Loading states (added with the skeleton release)

Run with DevTools → Network → **Slow 3G** so the loading frame is visible.

| # | Step | Expected | OK? |
|---|---|---|---|
| L1 | Hard-reload any department URL, signed in | A centred "Ignition Group" mark and one pulsing bar, then the dashboard. **No login screen flash.** | |
| L2 | Same, signed out | The mark and bar, then the login card | |
| L3 | Login URL with `?auth_error=access_denied&reason=unmapped` | The mark and bar, then the login card **with its error banner** | |
| L4 | Open each department | First paint is a shaped skeleton — grey pulsing rows under a real table header, tiles, chart boxes — never a spinner in a table cell, a blank area, or "No data" | |
| L5 | Spot Report → five different pages | Skeleton has a heading bar, a controls row, tiles and chart cards at roughly the loaded heights; the page does not jump when data lands | |
| L6 | Spot Report → any page → **Reload** | The data **stays on screen**; only the button spins. (Before: the whole page collapsed to one line.) | |
| L7 | EngAIge → Monitoring → Batch history | Skeleton rows while loading, not "No processing history for these filters" | |
| L8 | EngAIge → Monitoring → Analytics | Chart cards keep their titles with a skeleton plot, not "No data for this range" | |
| L9 | Reporting → Quality mix (auto-runs on open) | A report skeleton under the controls, not an empty area | |
| L10 | Distribution → Manual / Extend Expired / Daily Files tables | Skeleton rows under each table header while loading | |
| L11 | Distribution → Dashboard panels (Reporting → Distributed / Sales / Dialler) | Card with its real title, tile row and chart box while loading | |
| L12 | Task Automation → Create job → pick an endpoint and browse | Six skeleton rows in the file browser until the listing arrives | |
| L13 | Task Automation → Current jobs → `</>` on a job | Skeleton lines in the SQL panel while it fetches | |
| L14 | Settings (super admin) → each table | Skeleton rows, not plain "Loading…" text | |
| L15 | OS **Reduce motion** on (macOS Accessibility / Windows Animation effects) | Skeleton bars are static grey — no pulse | |
| L16 | Screen reader on any loading page | "Loading" announced once per region, not once per bar | |

Kept as spinners on purpose: buttons ("Saving…", "Uploading…") and the disabled
campaign / job-title dropdown triggers that read "Loading campaigns…".

## Motion (added with the animation release)

The system is four class strings and one chart constant, all documented in
`lib/motion.ts`. Restrained on purpose: 150ms for hover, 200ms for content,
4px maximum travel, no stagger. `scripts/check-ui-consistency.mjs` fails
`npm test` if something slower or larger creeps in.

| # | Step | Expected | OK? |
|---|---|---|---|
| M1 | OS **Reduce motion** on, then use the app | Dialogs and dropdowns open instantly, skeletons are solid grey, content does not fade. **Spinners still turn**, slower — deliberate, they are the only in-flight signal and several replace a button's label | |
| M2 | Hover a sidebar nav item | The background eases in over 200ms. It used to snap — only size properties were transitioned | |
| M3 | Collapse the sidebar (Cmd/Ctrl+B) | The group label ("Processes", "Options") **fades** as the panel narrows rather than vanishing — a one-word typo fix upstream had as `opa` | |
| M4 | Hover a department tile on the picker | Border, background and the icon chip all change together. The chip used to snap while the tile faded | |
| M5 | Switch nav on Distribution, Tickets, Reporting, EngAIge, Spot, Spot Report | Content fades in over 200ms with a ~4px rise. The **header title does not move** — one moving region per interaction | |
| M6 | **Task Automation: Create → Current jobs → Create** | **No fade** — expected and deliberate. Then: start a job in the wizard, switch away, switch back — **the config is still there.** The fade is keyed on the nav id and a key would remount the wizard | |
| M7 | Scroll to the bottom of a long page, then switch nav | You land at the top of the new section with no jump-then-settle | |
| M8 | Open a Spot Report cold | Skeleton, then the page fades in. Series draw once, ~350ms — not Recharts' 1.5s default | |
| M9 | Change a filter or press Reload on a report | Data stays on screen; one redraw at 350ms | |
| M10 | **Leave Task Automation → Tasks open for 90 seconds** | The chart **must not re-animate.** That page ticks every 60s to recompute next-run times; the chart's data is set only by the fetch, so it should be untouched | |
| M11 | Login → picker → a department | Each fades in. **The loading bar does not** — its whole job is to be on screen immediately | |
| M12 | Hover a table row while data lands | The hover must not stutter. Skeleton rows deliberately have no fade for this reason | |
| M13 | Drag a file over an upload dropzone | The border colour eases rather than snapping, and keeps up with dragenter/dragleave | |

Deliberately not animated: cards, stat tiles and chart cards (not interactive —
a hover state there promises a click that never comes), button press states,
and the Spot Report iframe (it renders blank white until load, so a fade would
only draw the eye to the blank).

## Known and deliberate

- EngAIge still uses emoji status glyphs (✅ ⏳ ❌ ⏹️ ❔ 🟢 🔴). Left by decision.
- The Ignition logo is still a hosted Vercel-blob URL in three places. Left by decision.
- `app/api/sftp/list` and `sftp/preview` now require a Distribution session but
  still relay caller-supplied SFTP credentials outbound. Replacement pattern:
  `app/api/task-automation/sftp/inspect`.
- `lib/snowflake.ts` falls back to `ACCOUNTADMIN` when `SNOWFLAKE_ROLE` is
  unset. Confirm the production value via `/api/distribution/snowflake-identity`.
- The mobile sidebar opens in 500ms and closes in 300ms (it goes through
  `ui/sheet.tsx`) while the desktop one collapses in 200ms. Left alone —
  changing the sheet timings moves every dialog-adjacent surface in the app.
- `ui/input-otp.tsx` references an `animate-caret-blink` class that is defined
  nowhere. Pre-existing dead class; left dead on purpose, so nobody turns it
  into a blinking caret while adding animation.
- The Azure callback fails **open** to all departments if the grants lookup
  throws; the session cookie is unsigned JSON. Both predate this work.
