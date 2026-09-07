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
| Calendar | Open | Lands on **Month**, not Upcoming. Six rows always, even for a 28-day February | |
| Calendar | Page back a month, then forward | Data loads for both — before this the payload only covered open-plus-30-days, so a past month was simply empty | |
| Calendar | A weekly series, viewed in the month grid | Appears on **every** matching weekday in view, including ones already past, each with a repeat icon | |
| Calendar | A monthly series anchored on the 31st, paged Jan → Feb → Mar | 31 Jan, **28** Feb, **31** Mar — it clamps and comes back | |
| Calendar | Drag a one-off task onto another day | It moves; the banner names the recipient count. No confirm | |
| Calendar | Drag a **recurring** task onto another day | A confirm first, saying it re-anchors the whole series. Cancel leaves it where it was | |
| Calendar | Click empty space in a day cell | The create dialog opens with that date already filled in | |
| Calendar | A day with more than three tasks | A "+N more" popover lists the whole day; the chips in it are not draggable | |
| Calendar | Ctrl-P on the month | One page, no sidebar, no header, nothing clipped. Today is outlined; the previous/next month's days are faded | |
| Calendar | Export to Outlook → import the .ics | A recurring series arrives as a repeating event starting at its **series start**, not the date it has rolled to. A timed task lands at the right SAST hour | |
| Calendar | Then edit that task in the portal | Outlook does **not** update. That is expected — the file is a snapshot, and the button says so | |
| Calendar | Upcoming, after all of the above | Still groups Overdue / Today / Tomorrow / This week / Later, unchanged by the refactor onto the shared hook | |
| Calendar | Open, before any task exists | Three tables self-create on the first request; "Nothing is on the calendar yet" info banner, no error | |
| Calendar | Recipients → add yourself → Upcoming → New task, dated today | Green banner naming the recipient count; the mail arrives | |
| Calendar | Edit that task's date, then delete it | Two more mails — an "Updated:" with a `Date: A → B` line, then a "Cancelled:" | |
| Calendar | Save an edit that changes nothing | Grey "Nothing changed, so no email was sent" — no mail | |
| Calendar | Notifications tab | One row per attempt above, all "Sent". If email is off they read "Not sent / disabled in App settings" — that is the tell | |
| Calendar | With an empty Recipients list, create a task | Grey banner: saved, nobody notified. **Not** an error | |
| Calendar | New task → Repeats: Weekly → pick Mon and Wed | The preview under the box lists the next three real dates; the summary reads "Every week on Monday and Wednesday" | |
| Calendar | Repeats: Monthly, day 31, dated 31 January | Preview shows 28 Feb then **31** Mar — it clamps for February and comes back, it does not stick on the 28th | |
| Calendar | Tick off a recurring task | It does **not** disappear — the banner says "done for this time — next on ...", and the row moves to that date | |
| Calendar | Delete a recurring task | The confirm says the whole series goes, not just this occurrence | |
| Calendar | An overdue recurring task, then run the cron | `advanced` in the response counts it; the row lands on today or later. Running the cron twice must **not** step it a second time | |
| Calendar | Reminders | `curl -H "x-cron-secret: $CRON_SECRET" <app>/api/cron/calendar` → `{ok:true, considered, sent}`. Run it twice: the second says `considered: 0` (already claimed) | |
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
| Distribution | Every one of the 8 nav items | Renders | |
| Distribution | Batch upload check → **Check batches with the campaign left on "All"** | Every short batch across every campaign, worst first, with a Campaign column. This is the point of the screen — no need to work through campaigns one at a time | |
| Distribution | The two tabs | **Needs reloading** is the actionable one and the default — the only tab with checkboxes and the re-send button. **All batches** is read-only | |
| Distribution | A batch with 0 in SilverSurfer | "Would send" equals its full HLL count — the batch never arrived, so it reloads whole | |
| Distribution | A partially-loaded batch (e.g. 6,750 in HLL, 2,900 in SS) | "Would send" is the gap, 3,850 — not the whole batch and not zero | |
| Distribution | Needs reloading, straight after Check batches | **Everything with something to send is already ticked** — a subset is the exception, not the default | |
| Distribution | Untick a couple of rows | The line by the button says how many missing leads sit in the unticked batches and will not be sent | |
| Distribution | The header checkbox | Selects or clears all; shows a partial state when only some are ticked, so "4 of 12" can never read as "none" | |
| Distribution | "Select all N short" | Ticks every batch with something to send, including across different campaigns | |
| Distribution | Re-send with batches from two campaigns picked | One push, not two. The confirm says how many campaigns are involved | |
| Distribution | Narrow to one campaign | The list filters to it; the Campaign column still shows which | |
| Distribution | Batch upload check → pick a campaign → Check batches | A row per batch: In HLL / In SilverSurfer / Short by / Would send. Compare against the reconciliation query — the numbers should agree | |
| Distribution | The freshness banner | Names the newest row on each side. **If SilverSurfer is well behind HLL, stop** — "missing" then means "not replicated yet" and re-sending would duplicate | |
| Distribution | A batch with nothing missing | Its checkbox is disabled — there is nothing to send | |
| Distribution | Pick a short batch → Re-send missing leads | A confirm naming a count that came from Snowflake just now, not from the table. **Cancel it: nothing must be written** | |
| Distribution | Then confirm | The step list shows truncate / insert / syncToSqlServer, and the table refreshes | |
| Distribution | **Extend Expired Leads, after this change** | Must behave exactly as before — its SQL moved into lib/silversurfer-push.ts and the golden test pins it, but only a real run proves the CALL still lands | |
| Distribution | **Before configuring anything** — download for any campaign | **Byte-identical to what you got before.** The standard layout is meant to be invisible; this is the check that matters most | |
| Distribution | Settings → a campaign → Export layout | 55 rows, "standard" badge, field names populated from the live leads table | |
| Distribution | Rename a column to `X"` or `X--y` | Refused inline with a reason, and Save is blocked. Neither can reach the SQL | |
| Distribution | Delete the BATCHNAME row | Refused — the export names each file after it, and the dialler team keys on that | |
| Distribution | Set a column's field to one that isn't on the table | Refused, rather than producing a query that fails at download time | |
| Distribution | Spot Connect 1: add `Region Code` at 6, `REGION` at 56, `ADDRESS_RANK` → empty, `LEADEXPIRY` → the stored field, `CREATEDONDATE` → as is | 57 columns; download and diff against the Teams file | |
| Distribution | Steps 4 and 5 after saving a layout | Both read "Layout: <config name>, 57 columns" — never a mystery which config won | |
| Distribution | Manual → step 4, defaults untouched | The same file you got before. **The whole change is meant to be invisible unless you move a control** | |
| Distribution | Step 4 → pick yesterday | Batch list repopulates for that date with counts; a stale batch pick clears itself | |
| Distribution | Step 4 → pick one batch → download | CSV contains only that batch, and the file is named after it | |
| Distribution | Open a back-dated CSV | `CREATEDONDATE` and `LeadExpiry` carry **that day's** dates, not today's — the bug the picker would have exposed | |
| Distribution | Change the date in step 4, then look at step 5 | Step 5 shows the **same** date and batch — they share one pick | |
| Distribution | A date with no leads | Both buttons disable and the label reads "No leads on this date"; step 5's error names that date, not "today" | |
| Distribution | Step 3 (Snowflake source) → Download data | Now carries the same pickers — it used to be a duplicate hardcoded to today | |
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
