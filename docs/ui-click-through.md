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

## Known and deliberate

- EngAIge still uses emoji status glyphs (✅ ⏳ ❌ ⏹️ ❔ 🟢 🔴). Left by decision.
- The Ignition logo is still a hosted Vercel-blob URL in three places. Left by decision.
- `app/api/sftp/list` and `sftp/preview` now require a Distribution session but
  still relay caller-supplied SFTP credentials outbound. Replacement pattern:
  `app/api/task-automation/sftp/inspect`.
- `lib/snowflake.ts` falls back to `ACCOUNTADMIN` when `SNOWFLAKE_ROLE` is
  unset. Confirm the production value via `/api/distribution/snowflake-identity`.
- The Azure callback fails **open** to all departments if the grants lookup
  throws; the session cookie is unsigned JSON. Both predate this work.
