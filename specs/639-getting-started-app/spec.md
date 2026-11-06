# Spec 639: Getting started desktop app

Status: Draft for review.
Ticket: [ENG-412](https://linear.app/matrix-os/issue/ENG-412/getting-started-desktop-app-first-week-tasks-with-points).
Design: [Desktop app › 🧭 Getting started](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1929-624): [First login 1938:645](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1938-645), [In progress 1938:1226](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1938-1226), [Task card 1937:227](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1937-227). The page is marked 🚧 (exploration, October 13, 2026); confirm the frames are final before UI work starts.
Builds on: Getting started popover ([HamedMP/matrix-os#1518](https://github.com/HamedMP/matrix-os/pull/1518), [ENG-309](https://linear.app/matrix-os/issue/ENG-309/fix-overlapping-getting-started-and-help-menus)), Get started wizard ([Spec 635](../635-guided-onboarding/spec.md), [ENG-366](https://linear.app/matrix-os/issue/ENG-366/guided-onboarding-get-started-wizard-and-personalized-first-run)).
Owner: Stefan. Reviewers suggested: Hamed (product), design owner of the Figma page, Nima (Help popover, GitHub readiness in [ENG-378](https://linear.app/matrix-os/issue/ENG-378/featsettings-add-github-developer-access-on-web-and-electron)).

## Goal

A new owner opens **Getting started** from its desktop icon and sees, in one window, what to do next and how far they are: 10 tasks, a progress bar and a points total. Finished tasks show Done, and finishing one while Matrix is open shows a short "+20 pts" toast.

Why: the five-step Help popover is easy to miss and says nothing about what Matrix can do. A real app on the desktop is something people find, reopen and come back to in the first week.

## Not the wizard

The Get started wizard (spec 635) runs once, before the desktop. This app is what stays on the desktop afterwards. The wizard's answers may order or highlight tasks later; this spec does not depend on them.

## Affected surfaces

| Surface | Scope |
| -- | -- |
| Web Desktop | In scope |
| Web Canvas | In scope (same app in a canvas window) |
| Electron Desktop | In scope |
| Web Mobile | N/A: the design is desktop-only and Web Mobile has no built-in app windows. Needs reviewer approval |
| Native Mobile | N/A: same rationale. Needs reviewer approval |

## Journey

**First open.** The app opens once automatically, the first time the desktop loads after the Get started wizard finishes or is skipped (or straight away for owners who never get the wizard, see "Existing owners"). After that it opens only from its icon, the launcher or the Help popover.

**Screen** (Figma "First login"):

- Header: "Getting started", "X of 10 done" with a progress bar, and a points badge.
- Hero, first state: the 45-second "Welcome to Matrix" intro video on the left; on the right a "Start here · +50 pts" card, "Put your agent to work", a suggested prompt ("Build me a habit tracker") and **Start in chat**, which opens Chat with that prompt in the composer (not sent).
- Hero, later (Figma "In progress"): the video shrinks to "Watch the intro again" and the card becomes **Up next**: the first incomplete task in grid order, with its points and its button.
- Grid of task cards, each with an icon, title, one-line description, and a points chip or a ✓ Done chip (component 1937:227).
- Footer: "Stuck? Chat with us" opens Support chat, the same destination as Help › Support chat.

**Tasks.** Ten in total: the hero task plus nine cards.

| ID | Group | Card | Points | Done when | Button opens |
| -- | -- | -- | -- | -- | -- |
| `first-prompt` | Hero | Put your agent to work | 50 | The owner has at least one chat (existing `first-work` chats signal) | Chat, prompt prefilled |
| `build-app` | Build | Build an app | 30 | The owner has an app they created (source to confirm, see open questions) | App Gallery › Create app |
| `create-agent` | Build | Create an agent | 30 | The owner has at least one bot besides the main bot (`/api/settings/get-started/bots` or the bots list; to confirm) | Bots |
| `build-memory` | Build | Build your memory | 30 | To define (open question) | To define |
| `slack` | Connect | Slack | 20 | `slack` is an active service in `/api/integrations` | Settings › Integrations, Slack |
| `whatsapp` | Connect | WhatsApp | 20 | WhatsApp is connected (`/api/messaging/platforms` or `/api/channels/status`; to confirm) | The WhatsApp connect flow |
| `github` | Connect | GitHub | 20 | Same rule as the popover's GitHub step (gh CLI authenticated or GitHub integration active); ENG-378's readiness when it lands | Agents & providers › GitHub |
| `ai-provider` | Connect | AI provider | 20 | A signed-in Codex or Claude, or a ready own-account or own-API-key access source in `/api/ai/provider-settings` | Settings › Agents & providers |
| `mobile-app` | Go further | Get the mobile app | 20 | The owner has signed in on Native Mobile (signal to confirm) | Mobile download page |
| `invite-friends` | Go further | Invite friends | 100 per friend | Needs referrals ([GTM-529](https://linear.app/matrix-os/issue/GTM-529/affiliate-links-for-users)) | Hidden until GTM-529 ships |

- A task without a reliable signal yet shows **unavailable** (no chip, button still works) and is never marked Done by guesswork. It counts toward the 10 but not toward "done".
- Points are fixed per task on the server. The nine tasks other than Invite friends add up to 240 points; Invite friends adds 100 per friend once referrals exist.
- Buttons only open places that already exist. This app adds no new connect or sign-in flows.

**Toast.** When a task turns Done while the owner is signed in, Matrix shows "Slack connected +20 pts" (task-specific copy) in the shared shell notification stack (`ShellNotificationPortal`), whether or not the app is open. Tasks that were already Done the first time they are seen are awarded silently.

**Help popover.** The popover keeps its place in the top bar but becomes a summary: "X of 10 done", the points total, and **Open Getting started**. Its own five-step list is removed, so there is one task list. Billing is not one of the 10 tasks (see open questions).

## Points

- Points belong to Getting started only. Nothing else reads them, and they cannot be spent in this version.
- Each task pays out once per owner, ever. Disconnecting Slack later does not remove points, and reconnecting does not add them again.
- The server decides the amount from its own table; the client only names the task.
- Points are progress, not money. Before points ever become credit or rewards, completion must be verified by the server or platform (see Risks).

## Design

| Piece | What |
| -- | -- |
| Contracts (`packages/contracts`) | `GETTING_STARTED_APP_TASK_IDS` and the task table (group, title, description, points, icon, destination); `deriveGettingStartedAppTasks(results)` built next to `deriveGettingStartedSnapshot`, reusing its parsers so the popover and the app agree; Zod schemas for the progress and award endpoints |
| Gateway (`packages/gateway`) | `getting-started/` repository on owner Postgres (Kysely), `routes/getting-started.ts` with the two endpoints below, wired in `server.ts` and closed on shutdown |
| Shared UI (`packages/ui`) | `GettingStartedApp` view (header, hero, grid, task card, footer) and a port interface `{ loadStatus, loadProgress, award, open(destination) }`, rendered by both shells |
| Web shell | `__getting-started__` in `builtin-apps.ts` (values, aliases, title), handled in `Desktop.tsx` and `canvas/CanvasWindow.tsx`; web port; popover summary |
| Electron | Entry in `FIXED_DESKTOP_APPS`, bundled icon in `bundledDesktopIconForPath`, Electron port; popover summary |
| OS view (`os-view.ts`) | `getting-started` in `OS_VIEW_FIXED_APP_APPEARANCES`, `OS_VIEW_PLACEABLE_BUILTIN_APPS` and `DEFAULT_OS_VIEW_DESKTOP_APP_PATHS`; artwork at `/system-app-icons/v2/getting-started.png` |
| Status polling | The app and the toast watcher reuse the popover's existing status reads and its 15 s refresh (`GETTING_STARTED_REFRESH_MS`), one poller per window, paused while the browser tab is hidden |

The `__getting-started__` path must never reach `AppViewer` (repo rule for `__…` paths). Window size defaults to the Figma frame width (about 1,000 px content) and follows normal window persistence.

## Storage

Owner Postgres, two tables created idempotently at gateway startup (`CREATE TABLE IF NOT EXISTS`, the same bootstrap pattern as `os-view-state/repository.ts`); a versioned migration set is only needed once a column changes:

```sql
CREATE TABLE getting_started_awards (
  owner_id   TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
  task_id    TEXT NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  points     INTEGER NOT NULL CHECK (points BETWEEN 0 AND 1000),
  silent     BOOLEAN NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, task_id)
);

CREATE TABLE getting_started_owner_state (
  owner_id               TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 128),
  auto_opened_at         TIMESTAMPTZ,
  desktop_icon_placed_at TIMESTAMPTZ  -- added with ADD COLUMN IF NOT EXISTS
);
```

- Award: `INSERT … ON CONFLICT (owner_id, task_id) DO NOTHING RETURNING points`. One statement, so two windows or two surfaces racing cannot double-award.
- Total: `SELECT sum(points)` for the owner. No stored counter, so nothing can drift.
- Auto-open: `INSERT … ON CONFLICT (owner_id) DO UPDATE SET auto_opened_at = now() WHERE auto_opened_at IS NULL RETURNING owner_id`. Only the request that gets a row back opens the app, so it opens once across Web and Electron.
- Invite friends is not awardable here: its points are per friend and depend on referrals.
- Referral awards (later) need a per-friend key; that is a later migration, not a reason to change this table now.

## Security architecture

| Route | Method | Auth | Body limit | Validation |
| -- | -- | -- | -- | -- |
| `/api/getting-started/progress` | `GET` | Gateway owner auth (same as `/api/settings/get-started`) | n/a | none (no params) |
| `/api/getting-started/awards` | `POST` | Gateway owner auth | 1 KiB (`bodyLimit`) | strict Zod `{ taskId: enum(GETTING_STARTED_APP_TASK_IDS), silent: boolean }` |
| `/api/getting-started/auto-open` | `POST` | Gateway owner auth | 1 KiB (`bodyLimit`) | empty strict object |
| `/api/getting-started/desktop-icon` | `GET` | Gateway owner auth | n/a | none (no params) |
| `/api/getting-started/desktop-icon` | `POST` | Gateway owner auth | 1 KiB (`bodyLimit`) | empty strict object; marks the icon placed after a surface saved it |

- **Input:** the task ID is an enum; points are never accepted from the client.
- **Owner scope:** `owner_id` comes from the request principal, never the body.
- **Errors:** clients get generic messages ("Getting started is unavailable"). Postgres errors are logged server-side and never returned. A missing database handle is `503`, not `404`.
- **No external calls:** the gateway endpoints only touch owner Postgres. Task status still comes from the existing status endpoints, with their own auth and timeouts.

| Request | Result |
| -- | -- |
| Not signed in | `401` (existing gateway auth) |
| Unknown task ID or extra fields | `400` generic |
| Award already recorded | `200 { awarded: false, total }` |
| New award | `200 { awarded: true, points, total }` |
| Database not configured | `503` |
| Database error | `500` generic, logged |

## Integration wiring

- `startup/owner-database.ts`: create `GettingStartedAppRepository` on the shared owner Kysely handle and bootstrap its tables, next to the OS-view state repository. It does not own the pool, so its `destroy()` never ends it; the owner database startup owns shutdown.
- `server/settings-routes.ts`: mount the routes under `/api/getting-started`, covered by the gateway's owner auth like every other `/api/*` route. `server.ts` passes only the repository.
- No kernel IPC tools and no `globalThis`. The UI reaches the gateway through each shell's existing authenticated client.
- No feature flag: the app is on wherever this gateway runs. A shell talking to an older gateway gets `404` from `/api/getting-started/progress` and hides the app, launcher entry and popover summary.

## Failure modes

- **A status read fails or times out:** that task shows unavailable; others still render. Status reads keep their existing timeouts (10 s).
- **Progress read fails:** the grid still renders from status; the points badge shows "–" with no error toast. Retried on the next refresh.
- **Award fails:** no toast, no Done-with-points flash; the next refresh retries. The card may show Done (status) before its points arrive, which is acceptable.
- **Two surfaces open:** both may POST the same award; the database keeps one row and only the request that inserted it returns `awarded: true`, so only that window shows the toast.
- **Computer switch:** pending reads are dropped when the active computer changes, so one computer's status never awards on another.
- **Shutdown:** the repository closes with the gateway; in-flight requests fail generically.

## Resource management

- One status poller per window (15 s, paused when hidden), cancelled on unmount.
- The toast watcher keeps only the last seen status per task (10 entries), cleared on sign-out or computer switch.
- Tables grow by at most one row per task per owner (11 rows today).
- No files, no temp data, no third-party data flow.

## Existing owners

Proposal (needs product sign-off): every owner gets the app once their computer runs this release. Owners whose computer existed before release do not get the auto-open; their already-done tasks are awarded silently on first load, so they start with an honest count and no burst of toasts.

## Acceptance checks

| # | Starting state | Action | Observable result | Surface / lane |
| -- | -- | -- | -- | -- |
| 1 | New owner, wizard just finished | Desktop loads | Getting started opens once in the "First login" state with 0 of 10 and 0 pts; reloading or opening Electron does not open it again | Web Desktop, Web Canvas, Electron Desktop / e2e |
| 2 | App open, Slack not connected | Connect Slack in Settings | Slack card shows Done, total +20, toast "Slack connected +20 pts" once | all three / e2e with fixture integration |
| 3 | Slack already awarded | Disconnect and reconnect Slack | No new points, no toast | gateway integration test on real Postgres |
| 4 | Two windows open | Both see Slack turn Done | One award row; one toast | gateway integration test (concurrent POSTs) |
| 5 | Chat exists | Open app | Hero shows "Up next" with the first incomplete task; video shows "Watch the intro again" | all three / UI test + live capture |
| 6 | Integrations endpoint failing | Open app | Connect cards show unavailable, nothing marked Done, other cards normal | UI test with fault injection |
| 7 | Any | Click the icon on desktop, launcher and dock | App opens in a window and keeps its position after reload | all three / e2e |
| 8 | Any | Open Help | Popover shows "X of 10 done", points and Open Getting started; no separate step list | all three / UI test |
| 9 | Malformed award request | POST unknown task or with `points` | `400` generic, no row written | gateway route test |

Evidence: live screenshots and a short recording on Web Desktop, Web Canvas and Electron Desktop, in the PR and #tech.

## Open questions

1. Are the Figma frames final (the page is marked 🚧)?
2. Do points mean anything yet, or are they progress only? This spec assumes progress only.
3. Where is the 45-second intro video, who owns it, and where is it hosted? Until it exists the hero shows the card alone.
4. What counts as done for **Build your memory**, and where does its button go?
5. Which signal says the owner has **built an app** (own app in the catalog vs. any App Gallery install) and **signed in on mobile**?
6. Billing is a popover step but not one of the 10 tasks. Drop it, or keep a billing nudge elsewhere?
7. Existing owners: confirm the "icon yes, auto-open no, silent backfill" proposal.
8. Icon artwork for `getting-started` in the v2 app icon family.

## Deliverables

- Code and tests in this repository under ENG-412. Likely a small stack: contracts + gateway storage/routes → shared UI + web shell → Electron + popover summary.
- Public docs: a separate PR in `FinnaAI/matrix-os-site` describing the Getting started app, after it ships.

## Out of scope

- Web Mobile and Native Mobile versions.
- Spending, redeeming or displaying points outside this app.
- Referrals (GTM-529); Invite friends stays hidden until then.
- Personalising task order from wizard answers.

## Risks

- **Points become money later.** Awards are claimed by the owner's own client after reading status. That is fine for progress on a single-owner computer, but not for credit. If points gain value, verification must move server-side or to the platform first.
- **Two task lists drifting.** Mitigated by deriving both the app and the popover summary from one contracts function and removing the popover's own list.
- **Default desktop icon.** Adding a path to `DEFAULT_OS_VIEW_DESKTOP_APP_PATHS` must not rearrange existing owners' saved layouts; verify with an existing-layout fixture.
