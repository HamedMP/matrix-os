# Spec 639: Getting started desktop app

Status: Draft for review.
Ticket: [ENG-412](https://linear.app/matrix-os/issue/ENG-412/getting-started-desktop-app-first-week-tasks-with-points).
Design: [Desktop app › 🧭 Getting started](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1929-624): [First login 1938:645](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1938-645), [In progress 1938:1226](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1938-1226), [Task card 1937:227](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1937-227). The page is marked 🚧 (exploration, October 13, 2026); confirm the frames are final before UI work starts.
Builds on: Getting started popover ([HamedMP/matrix-os#1518](https://github.com/HamedMP/matrix-os/pull/1518), [ENG-309](https://linear.app/matrix-os/issue/ENG-309/fix-overlapping-getting-started-and-help-menus)), Get started wizard ([Spec 635](../635-guided-onboarding/spec.md), [ENG-366](https://linear.app/matrix-os/issue/ENG-366/guided-onboarding-get-started-wizard-and-personalized-first-run)).
Owner: Stefan. Reviewers suggested: Hamed (product), design owner of the Figma page, Nima (Help popover, GitHub readiness in [ENG-378](https://linear.app/matrix-os/issue/ENG-378/featsettings-add-github-developer-access-on-web-and-electron)).

## Goal

A new owner opens **Getting started** from its desktop icon and sees, in one window, what to do next and how far they are: 12 tasks, a progress bar and a points total. Finished tasks show Done, and finishing one while Matrix is open shows a short "+20 pts" toast.

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

**First open.** The app opens once automatically, and its icon is placed first on the desktop, the first time the desktop loads after the Get started wizard has finished or been skipped. The server claim (`/auto-open`) makes this happen once per owner across Web and Electron. Owners who never get the wizard are not auto-opened. After that it opens from its icon, the launcher or the Help popover.

**Screen** (Figma "First login"):

- Header: "Getting started", "X of 12 done" with a progress bar, and a points badge.
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
| `gmail` | Connect | Gmail | 20 | `gmail` is an active service in `/api/integrations` | Settings › Integrations, Gmail |
| `google-calendar` | Connect | Google Calendar | 20 | `google_calendar` is an active service in `/api/integrations` | Settings › Integrations, Google Calendar |
| `slack` | Connect | Slack | 20 | `slack` is an active service in `/api/integrations` | Settings › Integrations, Slack |
| `whatsapp` | Connect | WhatsApp | 20 | WhatsApp is connected (`/api/messaging/platforms` or `/api/channels/status`; to confirm) | The WhatsApp connect flow |
| `github` | Connect | GitHub | 20 | Same rule as the popover's GitHub step (gh CLI authenticated or GitHub integration active); ENG-378's readiness when it lands | Agents & providers › GitHub |
| `ai-provider` | Connect | AI provider | 20 | A signed-in Codex or Claude, or a ready own-account or own-API-key access source in `/api/ai/provider-settings` | Settings › Agents & providers |
| `mobile-app` | Go further | Get the mobile app | 20 | The owner has signed in on Native Mobile (signal to confirm) | Mobile download page |
| `invite-friends` | Go further | Invite friends | 100 per friend | Needs referrals ([GTM-529](https://linear.app/matrix-os/issue/GTM-529/affiliate-links-for-users)) | Hidden until GTM-529 ships |

- A task without a reliable signal yet shows **unavailable** (no chip, button still works) and is never marked Done by guesswork. It counts toward the 10 but not toward "done".
- Points are fixed per task on the server. The eleven tasks other than Invite friends add up to 280 points; Invite friends adds 100 per friend once referrals exist.
- Buttons only open places that already exist. This app adds no new connect or sign-in flows.

**Toast.** When a task turns Done while the owner is signed in, Matrix shows "Slack connected +20 pts" (task-specific copy) in the shared shell notification stack (`ShellNotificationPortal`), whether or not the app is open. Tasks that were already Done the first time they are seen are awarded silently.

**Help popover.** The popover gains a summary row under its progress bar: **Open Getting started**, "X of 12 done" and the points total. Its own list stays for now, because since spec 635 it also carries the wizard's bots and "Try" prompts; removing it is a product decision (open question 9). Billing is not one of the 12 tasks (see open questions).

## Points

- Points belong to Getting started only. Nothing else reads them, and they cannot be spent in this version.
- Each task pays out once per owner, ever. Disconnecting Slack later does not remove points, and reconnecting does not add them again.
- A card's Done follows its live status: a disconnected Slack, GitHub or AI provider shows "20 pts earned" instead of Done until it is reconnected. Tasks Matrix cannot check, and the one-time first prompt, stay Done once earned.
- When a task pays out while the app is on screen, the reward plays in the app (the hero shows it, the total floats "+N") instead of a corner toast. A minimized window or background tab gets the corner toast.
- Desktop icon names wrap to two lines on Web Desktop and Electron Desktop, so "Getting started" is never cut off.
- The icon takes the top-left slot. Icons on the slots before the first empty one move down one slot each (filling down, then right), once, when the icon is placed. If a hand-placed icon sits in that run, it goes in the first empty slot instead.
- The server decides the amount from its own table; the client only names the task.
- Points are progress, not money. Before points ever become credit or rewards, completion must be verified by the server or platform (see Risks).

## Design

| Piece | What |
| -- | -- |
| Contracts (`packages/contracts`) | `GETTING_STARTED_APP_TASK_IDS` and the task table (group, title, description, points, icon, destination); `deriveGettingStartedAppTasks(results)` built next to `deriveGettingStartedSnapshot`, reusing its parsers so the popover and the app agree; Zod schemas for the progress and award endpoints |
| Gateway (`packages/gateway`) | `getting-started/` repository on owner Postgres (Kysely), `routes/getting-started.ts` with the two endpoints below, wired in `server.ts` and closed on shutdown |
| Shared UI (`packages/ui`) | `GettingStartedApp` view (header, hero, grid, task card, footer) and a port interface `{ loadStatus, loadProgress, award, open(destination) }`, rendered by both shells |
| Web shell | `__getting-started__` in `builtin-apps.ts` (values, aliases, title), rendered by `desktop/DesktopWindow.tsx` and `canvas/CanvasWindow.tsx`; `getting-started-app/web-getting-started-app.tsx` (port, host, toast); launcher entry only while served; popover summary |
| Electron | `getting-started` tab kind; `GETTING_STARTED_DESKTOP_APP` added to destinations only while served (`FIXED_DESKTOP_APPS` stays the default desktop set); `features/getting-started-app/DesktopGettingStartedAppHost.tsx` (port, host, sonner toast); popover summary |
| OS view (`os-view.ts`) | `getting-started` appearance and bundled artwork `/system-app-icons/v2/getting-started.png`. Not in `DEFAULT_OS_VIEW_DESKTOP_APP_PATHS`: the icon is placed by the first automatic open instead, so computers on older bundles never show a broken icon |
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
| 1 | New owner, wizard just finished | Desktop loads | Getting started opens once in the "First login" state with 0 of 12 and 0 pts; reloading or opening Electron does not open it again | Web Desktop, Web Canvas, Electron Desktop / e2e |
| 2 | App open, Slack not connected | Connect Slack in Settings | Slack card shows Done, total +20, toast "Slack connected +20 pts" once | all three / e2e with fixture integration |
| 3 | Slack already awarded | Disconnect and reconnect Slack | No new points, no toast | gateway integration test on real Postgres |
| 4 | Two windows open | Both see Slack turn Done | One award row; one toast | gateway integration test (concurrent POSTs) |
| 5 | Chat exists | Open app | Hero shows "Up next" with the first incomplete task; video shows "Watch the intro again" | all three / UI test + live capture |
| 6 | Integrations endpoint failing | Open app | Connect cards show unavailable, nothing marked Done, other cards normal | UI test with fault injection |
| 7 | Any | Click the icon on desktop, launcher and dock | App opens in a window and keeps its position after reload | all three / e2e |
| 8 | Any | Open Help | Popover shows "X of 12 done", points and Open Getting started; no separate step list | all three / UI test |
| 9 | Malformed award request | POST unknown task or with `points` | `400` generic, no row written | gateway route test |

Evidence: live screenshots and a short recording on Web Desktop, Web Canvas and Electron Desktop, in the PR and #tech.

## Open questions

1. Are the Figma frames final (the page is marked 🚧)?
2. Do points mean anything yet, or are they progress only? This spec assumes progress only.
3. Where is the 45-second intro video, who owns it, and where is it hosted? Until it exists the hero shows the card alone.
4. What counts as done for **Build your memory**, and where does its button go?
5. Which signal says the owner has **built an app** (own app in the catalog vs. any App Gallery install) and **signed in on mobile**?
6. Billing is a popover step but not one of the 12 tasks. Drop it, or keep a billing nudge elsewhere?
7. Existing owners: confirm the "icon yes, auto-open no, silent backfill" proposal.
8. Icon artwork for `getting-started` in the v2 app icon family. A placeholder compass ships at `shell/public/system-app-icons/v2/getting-started.png`.
9. Should the popover's own list go away now that the app exists, and where do the wizard's bot and "Try" rows live then?
10. The mobile download link (`https://matrix-os.com/mobile`) and the Create an agent / Build your memory chat prompts are placeholders until product confirms them.

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

---

# Iteration 2: an extension of onboarding (stack layer 3)

Team feedback on the first build (#tech, Oct 29): it should feel like an extension of the onboarding process with Matrix's vibe (Stefan), share the onboarding widget's components and bring in Sahar's chat-first design (Nima), and it reads a bit empty: use the real integration logos (Hamed).

## Plan

1. **One set of components with the onboarding widget.** The widget's design tokens (`--mxo-*`) apply to the Getting started app too, and its starter-task button becomes a shared `OnboardingTaskButton` used by both. The app reuses the widget's `RabbitAvatar`, `AppLogo`, tiles, tags and rise animation instead of its own look-alikes.
2. **The hero continues onboarding.** The left panel becomes the Matrix agent: rabbit avatar, "Hey {name} 👋" and a line that reacts to progress (next step, a just-finished task, all done). The right panel shows Sahar's four starter tasks from `ONBOARDING_TASKS` (Research anything, Plan my week, Build a website, Work on my code), ordered by the owner's Get started goals, with "Needs Calendar/GitHub" tags until those apps are connected.
3. **Starting a task hands off to the widget.** Clicking a starter task opens the onboarding widget in the corner and starts that task there, through a small typed request channel the widget host listens to (one listener per shell, no globals). When no widget is mounted, it opens Chat with the same task prompt instead. Any started chat completes "Put your agent to work" (+50).
4. **Real logos.** Connect cards show the integration's real logo from the integrations catalog (`/api/integrations/available`, the same source as Settings › Integrations); AI provider shows the Claude and OpenAI marks; Build cards use the sculpted app icons (Create app, Notes) and the Matrix rabbit for Create an agent. Missing logos fall back to the line icon.
5. **More spirit, still calm.** Points count up when they change; a card that turns Done pops once with a soft glow; cards rise in with the widget's stagger. All motion is skipped under `prefers-reduced-motion`.

## Not in this iteration

- A new Figma frame: the layout follows the widget's existing components and Sahar's onboarding pages until design publishes an updated Getting started frame.
- Removing the Help popover's own list (open question 9).

## Iteration 3: email, calendar and the finish line

Team feedback (Oct 30): email and calendar were missing, and finishing should feel like a reward.

1. **Gmail and Google Calendar cards.** Two Connect cards, first in that group (+20 each), Done when `gmail` / `google_calendar` is an active integration, with their catalog logos. They also cover the starter task "Plan my week", which needs Calendar. That makes 12 tasks and 280 awardable points.
2. **Matrix unlocked.** Once nothing Matrix can check is left (first prompt done and no incomplete task), the hero becomes a "Matrix is fully unlocked" banner: a gold medal with the rabbit, a slow ray burst, a short confetti fall, points collected, tasks done, and **Put Matrix to work** (opens Chat). Cards Matrix cannot check yet never block it; a note says they turn Done later. When the last task finishes in view, its reward plays first. Motion is skipped under `prefers-reduced-motion`.

## Iteration 4: one job per piece, no repeated lists

Team feedback (Oct 30): the app, the corner widget and the Help checklist repeated the same starter tasks.

| Piece | Job |
| -- | -- |
| Onboarding widget (corner) | Runs the starter tasks. The only place they run while it is open. |
| Getting started app | Progress, points, what is left, and the Matrix unlocked finish line. |
| Help › Getting started | One row, "Getting started · X of 12 · pts", that opens the app. |

1. **The widget publishes its state** on the shell's typed task channel (`task-requests.ts`): open (in the corner) or minimized, and its activity (choosing, setting up a task, running, done, failed) with the task's title. One value, newest widget wins, cleared on unmount; readers are capped.
2. **The app hero mirrors the widget** while it is open and waiting for the first pick, or while it is setting up or running a task: "Pick your first task in the corner", "Matrix is working on Plan my week", with **Show Matrix panel** when the widget is minimized. When the widget is minimized with nothing running, missing, or done, the hero shows its own content: the four starter tasks (which still hand off to the widget, or Chat without one), then Up next, then Matrix unlocked.
3. **Help keeps one row** where the computer serves the app (and while that is being checked, so the old checklist never flashes): it opens the app and shows progress and points. Web keeps its desktop download link under it. Computers whose gateway predates the app keep the old checklist popover as a fallback, so nothing is lost there. The checklist's bot and "Try" rows therefore only remain on those older computers (open question 9).
4. The widget's open/minimized state is stored per browser, so the mirror follows the device the owner is on.

