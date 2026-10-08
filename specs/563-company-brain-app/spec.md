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

