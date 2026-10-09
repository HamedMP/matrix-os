# Company Brain app

**Status:** Implementation target (the view of the Company Brain; builds on specs 551 to 562, 564 and 566)  
**Owner:** `packages/ui/src/brain/` (shared view); adapters in `shell/src/components/brain/` and
`desktop/src/renderer/src/features/brain/`  
**Date:** 2026-10-02

## Outcome

On Web Desktop, Web Canvas, Web Mobile and Electron Desktop, the owner opens "Company Brain" like Files or Notes
and, for any of their projects, can ask a question and get cited answers, read today's brief, browse decisions,
commitments and risks with their verbatim quotes and conflict flags, follow the timeline of a file, folder, person
or spec, and connect, sync and inspect the sources that feed the brain. Every answer shows where it came from (pull request, commit, spec, note, issue) with a link when one exists.

## Scope of this increment

In scope: the shared view in `packages/ui/src/brain/` (seven screens, a typed client with one method per
`/api/brain` route over an injected HTTP transport, copies of the gateway view shapes the screens render, and the
controls and token classes both renderers share), a Web adapter (`shell/src/components/brain/`) and an Electron
Desktop adapter (`desktop/src/renderer/src/features/brain/`), and component tests with a fake client. Business and
presentation derivation live only in the shared view; the adapters bind a gateway client and register the app. The
gateway is unchanged; the view calls the routes of specs 552 to 564 and 566 as they are mounted. Out of scope (no
stubs): see Deferred.

## Screens

A project picker (the owner's active projects, `GET /api/workspace/projects`, first page), then: **Ask** (hits best
first with matched terms marked, stale claims marked "Outdated", a note while the index catches up; a question that
is a repo path, with no spaces and a "/" or a file ending, shows that path's history from the why route instead,
newest first; a leading "./" is dropped, and a leading "/" or an empty, "." or ".." segment is searched as words, since
the why route refuses it; "Search the words instead" shows while the history loads and after any error); **Today** (the
day or week brief in one shrinkable column, changes before the long commitments list, every line cited, and
Rebuild; a cite never repeats the line's text or a label equal to its title); **Decisions, Commitments, Risks** (statement, verbatim quote,
label, confidence, rules or model, due, assignee, severity, cite and conflict flags, a path filter and "Only
conflicts"); **Timeline** (newest first for a file, folder, spec or person, a person found by name first; the
person view lists "Possible duplicates" from `GET .../entities/merge-suggestions`, each pair with its score, link
counts and reasons, Merge into the person who stays and Undo, both over the alias route; Undo unmerges, which
leaves nothing behind, so the pair can be suggested and merged again); and
**Sources**: the repository (connect, sync, find claims, find claims with the model after a confirm, recent syncs;
the three runs are background jobs with progress, Stop and the result, and say when a run waits for another run of
the project; the card shows the owner's model spend for the last 30 days across all projects, and the model confirm
shows the budget left, which is per owner, not per project), every other source (last sync and what to do next, sync as a background job,
pause or resume, recent syncs, disconnect after a second click) and a connect form. The form lists every
kind with its availability ("Ready", "Connect the account in Settings", or "Not set up on this server" for
`not_configured`, which covers every server-side gap, not only a missing integration key), offers the first page of the kind's options, or a typed value when the kind lists none (GitHub
`owner/name`, the Slack bridge's Company Brain scope id, Matrix note tags or none for every note), and per-kind
settings: GitHub and Linear item types (at least one), Matrix file endings (1 to 32) and largest file (64 KiB,
256 KiB or 1 MiB), calendar days back and ahead (0 to 90, no event bodies). Defaults: every item type, Markdown and
text files up to 256 KiB, 14 days each way. The gateway validates every config.

## States

Every request shows loading, then its data, an empty state that says what to do next, or an error. Errors come only
from the HTTP status class and a known error code; the server's message is never shown: no access (401 or 403),
offline, too slow, brain off (503 or an unknown server code), not found (the code's fixed text, or "not turned on yet"
for a route that is not mounted), and refused (the code's fixed text). The not-connected codes add an "Open Sources"
button. A reload keeps the previous data on screen until the new answer arrives.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| `/api/brain/projects/:projectId/...`, `GET /api/workspace/projects` on Web | the Web gateway session (same origin) | the gateway checks the request principal and the project owner | mapped to the states above |
| the same routes on Electron Desktop | the desktop's gateway session; the main process adds the token for the gateway origin only | the same | the same; `fatalSession` reads as no access, `misconfigured` as offline |

Input validation: the view trims and bounds what it sends (question 500 characters, path 1,024, person query 200,
source name 120, choices per kind as the gateway config limits, typed values against the gateway patterns) and the
gateway validates again. Path segments are URI-encoded; queries use `URLSearchParams`. Responses render as text; only
`https://` permalinks become links. The project list is checked field by field; no credentials pass through the view;
logs carry an error name only. "Find claims with the model" asks first: the gateway sends this project's pull request,
commit and spec text to Anthropic, at up to the per-run cap (`MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN`, spec 555)
and the 30-day spend cap (`MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D`, default 5 USD, spec 555), whose remaining
amount the confirm shows from `modelSpend` of `GET .../claims` (rounded down to the cent).

## Integration wiring

Shared (`packages/ui`, root exports): `BrainApp({ api, loadProjects, initialScreen, initialProjectId, showHeading })`
with `api = createBrainShellApi(transport)` and `loadProjects = () => listBrainProjects(transport)`. The transport is
four JSON calls (`get`, `post`, `patch`, `delete`) with a per-call timeout; a failed call rejects with an `Error` that
has `category` (`unauthorized`, `offline`, `timeout`, `notFound` or `server`) and may have `detail`, a lower_snake
gateway code. Anything else reads as "unavailable". `BRAIN_SHELL_VIEW` (path `__brain__`, title "Company Brain",
aliases `brain`, `company-brain`, `apps/brain/index.html`, default 1100 by 720, minimum 360 by 420) and
`BRAIN_APP_KEYWORDS` (the palette words) are shared by every surface. Both renderers scan `packages/ui/src/brain` for
Tailwind classes.

Web Desktop, Web Canvas and Web Mobile: the shell `BrainApp` binds the shared view to `shellApi`.
`lib/builtin-apps.ts`, the render branches in `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx` (heading
hidden, as the window title bar names the app), `ShellHome.tsx`, the mobile shell (heading shown), the taskbar start
list, the command palette in `Desktop.tsx`, the Web Desktop icons (`lib/web-desktop-app-launch.ts`, so
`?launch=__brain__` opens it) and the minimum size in `hooks/useWindowManager.ts`.

Electron Desktop: tab kind `brain` (one tab, like Notes), the fixed app `__brain__` right after Whiteboard in the
launcher (not placed on the desktop by default, as on Web Desktop; "Add to desktop" places it), the palette entry
"Open Company Brain", the surface icon, the analytics kind `brain`, and restore and persistence of `__brain__` in the
shared OS-view state (each surface restores what the other saved). The transport is the desktop gateway client pinned
to the runtime slot; its delete sends an empty JSON body, which the routes accept. A runtime switch or a new sign-in
remounts the view. The tile (`OS_VIEW_FIXED_APP_APPEARANCES.brain`, brand green with forest ink) is shared with the
Web Launchpad and the Web Desktop icon, dock and window icons. The Windows-style taskbar start list and Web Mobile draw
every built-in app from the gateway's shipped icon images, not tiles, and there is no brain image, so Company Brain
shows the `search` image there. No environment variables and no new dependencies.

## Failure modes

- Timeouts: reads 15 s; sync, rules extract, refresh, brief and impact 45 s (one bounded 20 s server run), on every
  surface. Every request ends at 30 s in a proxy in front of the gateway today (Next's default `proxyTimeout` on Web,
  the platform's `PROXY_TIMEOUT_MS` on every surface, Electron Desktop included), so
  the repository's sync, find claims and model run, and every other source's sync, start a background job
  (`POST .../jobs`, 202, spec 566) and poll
  `GET .../jobs/:jobId`: after 1 s, then doubling to 10 s, at most 90 polls (about 15 minutes, then "Check again").
  Stop is `POST .../jobs/:jobId/cancel`. When the gateway has no jobs route (a 404 without a known code) or answers
  `job_kind_unavailable` (no step of that kind, or its worker runs another owner's jobs), the action runs directly
  as before. A failed job is worded by its code when the screens know it, else by the next action its last pass
  reported (`connect_account`, `raise_budget`, ...). A direct model run (it may take 190 s) cut short on
  its way back (too slow, or a 500 without a known code from a proxy) says it may still be finishing and its claims
  will appear. A failed job start, or an answer with a code (brain off included), is shown as that error: no run began.
- Concurrent access: each request gets a new number per key change or reload and an answer for an older number is
  dropped, so a slow answer never overwrites a newer one; a brief built again also drops a still-running load of the
  same request. One action at a time per card, and per duplicates list: its buttons (the model confirm too) are off
  while one runs. Pause, resume and remove send the loaded revision (`revision_conflict`: "Reload and try again").
- Polling: three failed polls in a row (offline, too slow, brain off), or one refused poll (no access, gone), stop
  with the error and "Try again". A new job, "Check again" or leaving the screen drops every answer meant for the
  older one; a job's end reloads the receipts once, whether a poll or the cancel answer brought it.
- Crash recovery: no durable state in the view; a job keeps running in the gateway when the window closes. When
  Sources opens it reads `GET .../jobs?limit=20` once, and each card follows the newest queued or running job of its
  slot (the repository's sync, rules and model runs; each source's sync), so after a reload the run shows and its
  buttons stay off until it ends. A gateway without the jobs route resumes nothing. Inactive Electron Desktop tabs
  stay mounted, so a followed job keeps polling there, with the same cap.
- Not connected: Electron Desktop without a gateway session shows "Connect to your Matrix computer to open the
  Company Brain." instead of the view.
- Error propagation: every failure is a visible state on its screen.

## Resource management

Lists keep at most 500 items (then Load more stops); pages are 20 (search, timeline, path history), 50 (claims,
conflicts) and 10 (people, merge suggestions); 200 projects; 5 receipts; the first page of connect options (at most
100); 5 reasons per suggestion. One poll timer per followed job, cleared on unmount; no sockets or caches; every
request ends with its timeout. The view sends nothing to a third party; a confirmed model run makes the gateway
send project text to Anthropic (see Security architecture).

## Invariants

- **Source of truth**: the gateway routes; the view keeps only what is on screen and refetches on every open. The
  only thing kept is the id of the project this surface picked last (`localStorage`, kept apart for Web and
  Electron Desktop), so the app opens on it while the gateway still lists it.
- **Lock/transaction scope**: none in the view; writes carry the loaded source revision and the gateway decides.
- **Acceptable orphan states**: none; an answer for a request the view has moved past is dropped.
- **Auth source of truth**: the gateway request principal, reached through each renderer's gateway session; the view
  never decides access.
- **Deferred scope**: listed below.

## OS-view surface matrix

| Surface | Covered | Notes |
| --- | --- | --- |
| Web Desktop | yes | window branch; the title bar names the app, so the in-app heading is hidden |
| Web Canvas | yes | window branch; heading hidden as on Web Desktop |
| Electron Desktop | yes | tab kind `brain` in the standard window frame; heading hidden; the desktop's shared window minimum |
| Web Mobile | yes | mobile shell list and render branch; the heading shows, as the app frame has no title bar |
| Native Mobile | no | deferred: the Expo app has no brain screen yet |

Every covered surface renders the same view: the screen list is a side column from 42rem and a scrolling row below
it, down to 360 px.

## Accessibility

A tab list with arrow keys (both axes, wrapping), Home and End, a roving tab stop and a labelled panel. Every control
has a name; progress uses `role="status"`, errors `role="alert"`; the period buttons carry `aria-pressed`, the syncs
toggle `aria-expanded`; the model confirm is a labelled group; an invalid typed value sets `aria-invalid`. A running
job shows a labelled `progress` element and its state in `role="status"`; the connect settings are a fieldset whose
problem text describes it; the path history, kinds, people and reasons are labelled lists. Rows wrap down to 360 px.

## Integration test checkpoint

`pnpm exec vitest run tests/ui/brain-*.test.ts tests/ui/brain-*.test.tsx` (jsdom, fake client, no network) covers
every route mapping, error reading by shape, request ordering, and all seven screens with their states and buttons;
`brain-jobs` polls with fake timers (backoff, failures, cap, stop, stale answers) and words a model run as still
finishing only when a direct run was cut short, `brain-ask-path`, `brain-merges` and `brain-source-settings` cover
the path history, duplicates and per-kind settings. `tests/shell/brain-shell.test.tsx` covers the Web binding (the
Web client by default, its errors read by the shared reader, a delete with no body, the heading).
`tests/desktop/brain-desktop-view.test.tsx` covers the Electron Desktop transport (empty delete body, the two
desktop-only categories) and view (connect message, runtime pinning, remount on a runtime switch or new sign-in); the
launcher, palette, tab, persistence and analytics suites cover its registration, and
`tests/e2e/desktop/company-brain.e2e.test.ts` opens it in a built Electron Desktop. The type half of
`tests/ui/brain-types-compat.test.ts` (client and error shapes against the gateway contracts, the job and merge routes
included) runs in the root `typecheck` script (`tsc --noEmit -p tests/ui/tsconfig.brain-compat.json`).
Manual (dev Docker setup, project `matrix-os`): Decisions lists quoted, cited claims; Sources shows recent syncs and
runs syncs and claim reading as jobs through the gateway's `/jobs` routes.

## Code review checklist

Every error shown is a known code or a fixed state, never the server's text; every list, page, poll and timer is
capped and cleared on unmount; an answer for an older request is dropped; one action per card at a time; long text
wraps or truncates inside a 390 px screen; no new dependency.

## Delivery and evidence

- [ ] The view, its adapters, tests and this spec come to about 5,900 lines, over the one-PR budget of about 2,900,
      so they land as three PRs, each with checks green: (1) the shared client, view shapes, controls and the Ask and
      Timeline screens with their tests; (2) the other screens, the app and the Web registration; (3) the Electron
      Desktop registration.
- [x] The CI type check of `brain-types-compat.test.ts` (the root `typecheck` script) is part of this change.
- [ ] Screenshots of Web Desktop, Web Canvas, Web Mobile and Electron Desktop in the PR bodies.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): the Company Brain app.

## Deferred

Native Mobile screen; filtering and paging connect options; editing source settings after connect; background jobs
for the index refreshes; a screen listing past jobs (Sources only resumes the running ones); impact and stale
screens (their answers stay untyped);
opening a cited Matrix note or file inside Matrix OS; brief history by date.
