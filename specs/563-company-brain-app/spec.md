# Company Brain app

**Status:** Implementation target (the view of the Company Brain; builds on specs 551 to 562, 564, 566 and, for the
Chat tab, 567)  
**Owner:** `packages/ui/src/brain/` (shared view); adapters in `shell/src/components/brain/` and
`desktop/src/renderer/src/features/brain/`  
**Date:** 2026-10-02

## Outcome

On Web Desktop, Web Canvas, Web Mobile and Electron Desktop, the owner opens "Company Brain" like Files or Notes
and it opens on a chat: for any of their projects they ask in plain English and the Company Brain Bot (spec 567)
answers only from that project's brain, with a link to every source. Every brain chat is a saved Matrix Chat, listed
per project so any can be reopened and continued, after a reload or restart and on every surface. The other tabs
search the brain without a model (with cited hits), read today's brief, browse decisions,
commitments and risks with their verbatim quotes and conflict flags, follow the timeline of a file, folder, person
or spec, and connect, sync and inspect the sources that feed the brain. Every answer shows where it came from (pull request, commit, spec, note, issue) with a link when one exists.

## Scope of this increment

In scope: the shared view in `packages/ui/src/brain/` (six tabs, a typed client with one method per
`/api/brain` route over an injected HTTP transport, copies of the gateway view shapes the screens render, and the
controls and token classes both renderers share), a Web adapter (`shell/src/components/brain/`) and an Electron
Desktop adapter (`desktop/src/renderer/src/features/brain/`), a chat slot each surface fills with its own chat view
(no second chat system), and component tests with a fake client. Business and
presentation derivation live only in the shared view; the adapters bind a gateway client and register the app. In the
gateway only its copy of the screen list (`BRAIN_SHELL_SCREENS` in `packages/gateway/src/brain/contracts/http.ts`)
changes, with the shared one (`tests/ui/brain-types-compat.test.ts` keeps the two the same). The Chat tab needs the
Bot thread routes of spec 567; the other tabs call the routes of specs 552 to 564 and 566 as they are mounted. Out of
scope (no stubs): see Deferred.

## Screens

A project picker (the owner's active projects, `GET /api/workspace/projects`, first page) and, in one row next to it,
six tabs: Chat, Today, Decisions, Timeline, Search and Sources. Chat is first, in bold, and the tab the app opens on.
Older ids still open: `ask` opens Search, `commitments` and `risks` open Decisions on that kind.

**Chat** is an ordinary Matrix Chat run by the owner's Company Brain Bot. The tab finds the Bot through the shared Chat
Agents client (`GET /api/chat-agents`, which lists active Bots only): an active one is used; none shows a one-time card,
"Chat with your Company Brain", whose Start creates it (`GET /api/chat-agents/bot-recipes?recipeId=company-brain`, then
`POST /api/chat-agents/instantiate` with no model, so the server picks Automatic, and a request id fixed per recipe
version, so a retry makes one Bot). When the Bot that Start returns is not listed as active (a replay of a Bot archived
since), the tab says "The Company Brain chat was archived, so it cannot start here. Search, Today, Decisions and
Timeline still work." with a way to Search. Bots that are off, a gateway that lists no brain recipe (one with no runtime
host, spec 567), or Bots that answer 503 to the recipe, Start or thread list calls, show "Chat with the brain is not
running on this computer. Search, Today, Decisions and Timeline still work." with a way to Search, before any thread is
made. Past brain chats of the project are listed beside the chat (`GET /api/chat-agents/:agentId/threads?projectId=`, 50
a page, "Show more" up to 500, kept through a reload), with title and how long ago; each row's menu (right click or
More) renames it or deletes it after a confirm, over the normal Chat routes of the surface's chat client, and deleting
the open chat opens the next one or a draft. The list reloads on open, on window focus, when a thread is created and
after every admitted turn the chat view reports, the same on every surface. The tab opens the chat this viewer had open
last for the project if it is still listed, else the newest, else a draft, and remembers the chat it opens; "New chat"
opens a draft. A draft saves nothing until its first send, which creates one thread (`POST
/api/chat-agents/:agentId/threads` with the project) however often the view asks, then sends the turn through the normal
Chat routes; the tab shows the new thread as soon as it exists, even when that first turn fails, and a refused first
question goes back into the composer. A thread is named from its first question by the shared automatic title, where a
long path reads by its last part. The tab also reads the project's sources (`GET .../sources`): with none, a new chat
shows "Connect this project's repository in Sources first." and Open Sources in place of the composer, and a brain that
is off shows its error with Try again there, since the Bot could only answer "I could not find that in the brain.";
saved chats still list and open. "Open in Chat" shows the same Chat in the Chat app. Below 42rem the list folds behind a
"Chats" button. The transcript, composer, Bot header and model controls are each surface's own chat view, so answers
render their Markdown source links like every Chat. The empty chat's heading and line come from the tab, so they read
the same everywhere; the embedded view offers no suggestion chips, no project picker, no harness setup (a Bot runs on
its own model) and no Share, settings or connection line.

**Search** (once Ask; hits best
first with matched terms marked, stale claims marked "Outdated", a note while the index catches up; a question that
is a repo path, with no spaces and a "/" or a file ending, shows that path's history from the why route instead,
newest first; a leading "./" is dropped, and a leading "/" or an empty, "." or ".." segment is searched as words, since
the why route refuses it; "Search the words instead" shows while the history loads and after any error); **Today** (the
day or week brief in one shrinkable column, changes before the long commitments list, every line cited, and
Rebuild; a cite never repeats the line's text or a label equal to its title); **Decisions**, with a switch to
Commitments and Risks (statement, verbatim quote,
label, confidence, rules or model, due, assignee, severity, cite and conflict flags, a path filter and "Only
conflicts"); **Timeline** (newest first for a file, folder, spec or person, a person found by name first; the
person view lists "Possible duplicates" from `GET .../entities/merge-suggestions`, each pair with its score, link
counts and reasons, Merge into the person who stays and Undo, both over the alias route; Undo unmerges, which
leaves nothing behind, so the pair can be suggested and merged again); and
**Sources**: the repository (connect, sync, find claims, find claims with the model after a confirm, recent syncs;
the three runs are background jobs with progress, Stop and the result, and say when a run waits for another run of
the project; the card shows the owner's background model work (claims) for the last 30 days across all projects, and
the model confirm shows the budget left, which is per owner, not per project; chat answers are billed like any Chat,
not from this budget), every other source (last sync and what to do next, sync as a background job,
pause or resume, recent syncs, disconnect after a second click) and a connect form. The form lists every
kind with its availability ("Ready", "Connect the account in Settings", or "Not set up on this server" for
`not_configured`, which covers every server-side gap, not only a missing integration key), offers the first page of the kind's options, or a typed value when the kind lists none (GitHub
`owner/name`, the Slack bridge's Company Brain scope id, Matrix note tags or none for every note, Linear team keys,
Drive folder ids or calendar ids), and per-kind settings: GitHub and Linear item types (at least one; GitHub reviews
need pull requests), Matrix file endings (1 to 32) and largest file (64 KiB,
256 KiB or 1 MiB), calendar days back and ahead (0 to 90, no event bodies). Defaults: every item type, Markdown and
text files up to 256 KiB, 14 days each way. The gateway validates every config.

## States

Every request shows loading, then its data, an empty state (icon, headline, next step), or an error. Errors come only
from the HTTP status class and a known error code; the server's message is never shown: no access (401 or 403), offline,
too slow, brain off (503 or an unknown server code), not found (the code's fixed text, or "not turned on yet" for a
route that is not mounted), and refused (the code's fixed text). The not-connected codes add an "Open Sources" button. A
reload keeps the previous data on screen until the new answer arrives. The Chat tab has its own fixed states: loading,
no sources (in place of a new chat), "The brain chat could not be opened." with Try again, the not running, archived and
Start states above, "Past chats could not be loaded." with Try again (a draft opens meanwhile), "No brain chats for
<project> yet.", "The chat could not be renamed. Try again." (or deleted) in the row, and "Chat is not available here."
on a host without a chat view. Errors inside the chat are the chat view's own (the shared Chat failure and Bot model
notices).

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| `/api/brain/projects/:projectId/...`, `GET /api/workspace/projects` on Web | the Web gateway session (same origin) | the gateway checks the request principal and the project owner | mapped to the states above |
| the same routes on Electron Desktop | the desktop's gateway session; the main process adds the token for the gateway origin only | the same | the same; `fatalSession` reads as no access, `misconfigured` as offline |
| `/api/chat-agents` (list, recipe, instantiate, threads) and `/api/chats/...` for the Chat tab | each surface's Chat client session | the gateway checks the owner's Bot and the project (spec 567) | the Bot client's fixed text by status class; the tab shows its own fixed states |

Input validation: thread calls check the project id (`proj_...`) and request id before sending and leave out a
title that is not a safe label of at most 120 characters (the server then names the thread). The view trims and
bounds what it sends (question 500 characters, path 1,024, person query 200,
source name 120, choices per kind as the gateway config limits, typed values against the gateway patterns) and the
gateway validates again. Path segments are URI-encoded; queries use `URLSearchParams`. Responses render as text; only
`https://` permalinks become links. The project list is checked field by field; no credentials pass through the view;
logs carry an error name only. "Find claims with the model" asks first: the gateway sends this project's pull request,
commit and spec text to Anthropic, at up to the per-run cap (`MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN`, spec 555)
and the 30-day spend cap (`MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D`, default 5 USD, spec 555), whose remaining
amount the confirm shows from `modelSpend` of `GET .../claims` (rounded down to the cent).

## Integration wiring

Shared (`packages/ui`, root exports): `BrainApp({ api, loadProjects, initialScreen, initialProjectId, showHeading, chat })`
with `api = createBrainShellApi(transport)` and `loadProjects = () => listBrainProjects(transport)`. The transport is
four JSON calls (`get`, `post`, `patch`, `delete`) with a per-call timeout; a failed call rejects with an `Error` that
has `category` (`unauthorized`, `offline`, `timeout`, `notFound` or `server`) and may have `detail`, a lower_snake
gateway code. Anything else reads as "unavailable". `BRAIN_SHELL_VIEW` (path `__brain__`, title "Company Brain",
aliases `brain`, `company-brain`, `apps/brain/index.html`, default 1100 by 720, minimum 360 by 420) and
`BRAIN_APP_KEYWORDS` (the palette words) are shared by every surface. Both renderers scan `packages/ui/src/brain` for
Tailwind classes. `chat` is a `BrainChatHost`: the surface's Chat Agents client, `render(slot)` for its own chat view
of one Chat or a draft (the slot carries the project, the Bot, the Chat id or null, the empty-chat heading and line,
`createChat` and `onChatChanged`, which the view calls after every admitted turn), `openInChat`, and `rows` (rename,
delete and the menu layer, over the surface's chat client).

Web Desktop, Web Canvas and Web Mobile: the shell `BrainApp` binds the shared view to `shellApi`.
`lib/builtin-apps.ts`, the render branches in `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx` (heading
hidden, as the window title bar names the app), `ShellHome.tsx`, the mobile shell (heading shown), the taskbar start
list, the command palette in `Desktop.tsx`, the Web Desktop icons (`lib/web-desktop-app-launch.ts`, so
`?launch=__brain__` opens it) and the minimum size in `hooks/useWindowManager.ts`. The Web chat slot
(`components/brain/BrainChatHost.tsx`) renders the shell `ChatApp` with `layout="embedded"` (no rail) and the Bot id,
driven by `hooks/useCanonicalChatThread.ts` (one Chat, the shell's one event stream, which `useCanonicalChatState`
now returns as `chatRuntime`; no URL or selection changes). Open in Chat switches the Chat app to that Chat and
focuses or opens the Chat window through `lib/shell-window-focus.ts`, the helper the dock, palette and Files share,
so Web Canvas pans to it (the Chat app on Web Mobile). Rows rename with `PATCH /api/chats/:id/title` and delete with
`DELETE /api/chats/:id`.

Electron Desktop: tab kind `brain` (one tab, like Notes), the fixed app `__brain__` right after Whiteboard in the
launcher (not placed on the desktop by default, as on Web Desktop; "Add to desktop" places it), the palette entry
"Open Company Brain", the surface icon, the analytics kind `brain`, and restore and persistence of `__brain__` in the
shared OS-view state (each surface restores what the other saved). The transport is the desktop gateway client pinned
to the runtime slot; its delete sends an empty JSON body, which the routes accept. A runtime switch or a new sign-in
remounts the view. The Electron Desktop chat slot (`features/brain/DesktopBrainChat.tsx`) renders
`CanonicalChatWorkspace` with `externalNavigation` (it never opens a Chat tab on its own), `botId`, `createChat`
(threaded into `useCanonicalChatRouteController` for a draft's first send) and `draftWelcome` (in place of the starter
cards), on the tab's own chat client and event stream (`WorkSurfaceRuntimeProvider`, streaming while the tab is
visible). With `createChat` or `botId` the workspace shows no project picker (a brain thread keeps no project of its
own) and no Share. The workspace's report of the Chat it opened is not passed on; its report after each turn is.
Open in Chat opens the Chat tab on the same Chat; rows rename and delete over the tab's chat client. The tile (`OS_VIEW_FIXED_APP_APPEARANCES.brain`, brand green with forest ink) is shared with the
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
- Chat: a draft's first send asks for one thread per draft (a second ask gets the same answer; a failed create may be
  sent again and the server replays the same request id); the tab then shows that thread without remounting the view,
  even if the first turn fails. A chat list answer for a project the tab has left is dropped, a late list never moves
  the viewer off the chat they opened, and the open chat's title is kept apart from the list. A rename or delete
  shows at once and stays over a reloaded list until the server list agrees. An answer keeps streaming in the gateway when the tab closes and shows when the chat opens again.
- Crash recovery: no durable state in the view; a job keeps running in the gateway when the window closes. When
  Sources opens it reads `GET .../jobs?limit=20` once, and each card follows the newest queued or running job of each
  slot in turn (the repository's sync, rules and model runs; each source's sync), so after a reload each run shows and
  buttons stay off until it ends. A gateway without the jobs route resumes nothing. Inactive Electron Desktop tabs
  stay mounted, so a followed job keeps polling there, with the same cap.
- Not connected: Electron Desktop without a gateway session shows "Connect to your Matrix computer to open the
  Company Brain." instead of the view.
- Error propagation: every failure is a visible state on its screen.

## Resource management

Lists keep at most 500 items (then Load more stops); pages are 20 (search, timeline, path history), 50 (claims,
conflicts) and 10 (people, merge suggestions); claims are checked against up to 500 conflicts, and a cut is shown;
200 projects; 5 receipts; the first page of connect options (at most
100); 5 reasons per suggestion. One poll timer per followed job, cleared on unmount; no sockets or caches; every
request ends with its timeout. The chat list keeps at most 500 brain chats; the Chat tab opens no stream of its own
(each surface's one Chat event stream is shared). The view sends nothing to a third party; a confirmed model run makes
the gateway send project text to Anthropic (see Security architecture), and a chat answer is billed like any Bot run.

## Invariants

- **Source of truth**: the gateway routes; the view keeps only what is on screen and refetches on every open. Brain
  chats are gateway Chat records, so they come back after a reload or restart and on every surface. The only things
  kept are the id of the project this surface picked last and of the brain chat last open per project (`localStorage`,
  kept apart for Web and Electron Desktop), each used only while the gateway still lists it.
- **Lock/transaction scope**: none in the view; writes carry the loaded source revision and the gateway decides.
- **Acceptable orphan states**: none; an answer for a request the view has moved past is dropped.
- **Auth source of truth**: the gateway request principal, reached through each renderer's gateway session; the view
  never decides access.
- **Deferred scope**: listed below.

## OS-view surface matrix

| Surface | Covered | Notes |
| --- | --- | --- |
| Web Desktop | yes | window branch; the title bar names the app, so the in-app heading is hidden; chat slot is the shell `ChatApp` (embedded); Open in Chat focuses the Chat window |
| Web Canvas | yes | window branch; heading hidden as on Web Desktop; the same chat slot |
| Electron Desktop | yes | tab kind `brain` in the standard window frame; heading hidden; the desktop's shared window minimum; chat slot is `CanonicalChatWorkspace` (`externalNavigation`); Open in Chat opens the Chat tab |
| Web Mobile | yes | mobile shell list and render branch; the heading shows, as the app frame has no title bar; the same chat slot with touch sizes; Open in Chat switches to the Chat app |
| Native Mobile | no | deferred: the Expo app has no brain screen yet |

Every covered surface renders the same view: the tabs are one scrolling row next to the project picker (the app's one
column may be narrower than that row, so Web Mobile at 390 px cuts nothing off), and the past chats list is a side
column from 42rem and folds behind "Chats" below it, down to 360 px.

## Accessibility

A tab list with arrow keys (both axes, wrapping), Home and End, a roving tab stop and a labelled panel. The past chats
are a labelled list whose open chat has `aria-current`; the "Chats" button carries `aria-expanded` and
`aria-controls`; opening the folded list moves focus to the open chat (or New chat), Escape closes it, and a pick or
Escape returns focus to "Chats"; each row's menu also opens from a named More button, and the rename field and the
delete confirm take focus and give it back to the row (to New chat after a delete); the claim kind switch uses `aria-pressed`; rows are at least 44 px tall on narrow screens. Every control
has a name; progress uses `role="status"`, errors `role="alert"`; the period buttons carry `aria-pressed`, the syncs
toggle `aria-expanded`; the model confirm is a labelled dialog over the card that takes focus, and its button, Escape
or a click outside closes it (Cancel and Escape refocus the button); an invalid typed value sets `aria-invalid`. A running
job shows a labelled `progress` element and its state in `role="status"`; the connect settings are a fieldset whose
problem text describes it; the path history, kinds, people and reasons are labelled lists. Rows wrap down to 360 px.

## Integration test checkpoint

`pnpm exec vitest run tests/ui/brain-*.test.ts tests/ui/brain-*.test.tsx` (jsdom, fake client, no network) covers
every route mapping, error reading by shape, request ordering, and all six tabs with their states and buttons
(`brain-chat` the Chat tab: opening order and memory, one thread per draft shown before its turn, Show more kept
through a reload, Start with no model, archived after Start, not running on 503 and with no runtime host, no sources
and brain off with saved chats still open, rename and delete, stale lists, the narrow fold and its focus;
`brain-app` the six tabs and a column that never grows wider than a phone; `generated-chat-title` titles of path
questions; `brain-company-bot` the thread calls, the Bot lookup, 503 and the
archived replay; `brain-chat-boundary` that the
folder opens no stream or request and draws no transcript or composer);
`brain-jobs` polls with fake timers (backoff, failures, cap, stop, stale answers) and words a model run as still
finishing only when a direct run was cut short, `brain-ask-path`, `brain-merges` and `brain-source-settings` cover
the path history, duplicates and per-kind settings. `tests/shell/brain-shell.test.tsx` covers the Web binding (the
Web client by default, its errors read by the shared reader, a delete with no body, the heading);
`tests/shell/canonical-chat-thread.test.tsx` covers the one-Chat hook (one create per draft, a report after every
admitted turn and none when it fails, a refused first question given back, content deltas, a snapshot on a gap, no
URL change) and the Web slot end to end (no rail, chips, harness setup, settings or connection line, a draft sent as
a brain thread, Open in Chat, and on Web Canvas the Chat window restored and panned to); `tests/shell/canonical-chat-client.test.ts` covers the Chat delete; and
`tests/desktop/brain-chat-tab.test.tsx` covers the Electron slot through `useDesktopBrainChatHost().render(slot)` (a
draft made through the host and sent as the Bot, the turn reported once, a saved chat opened in the conversation
view without its open report, no project picker or Share, no Chat tab opened on its own, Open in Chat), and
`tests/desktop/canonical-new-chat-content.test.tsx` the brain greeting with no starter cards or harness setup.
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
- [ ] The chat-first app (Chat tab, the Web and Electron Desktop chat slots, the tests above) lands after the spec
      567 server, with checks green, followed by the spec 567 real run.

## Deferred

Native Mobile screen; a model field on the Start card (the model is changed later in the chat's Bot controls); filtering and paging connect
options; editing source settings after connect; background jobs
for the index refreshes; a screen listing past jobs (Sources only resumes the running ones); impact and stale
screens (their answers stay untyped);
opening a cited Matrix note or file inside Matrix OS; brief history by date.
