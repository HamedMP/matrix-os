# Spec 635: Guided onboarding ("Get started")

Status: Draft for review, hackathon scope.
Ticket: [ENG-366](https://linear.app/matrix-os/issue/ENG-366/guided-onboarding-get-started-wizard-and-personalized-first-run).
Linear copy: [Spec 633: Guided onboarding](https://linear.app/matrix-os/document/spec-633-guided-onboarding-get-started-54ae102871ac) (filed as 635 here because `633` and `634` are taken by other branches).
Target: the final demo video (40 s, posted in the #tech thread) and the clickable demo. The video is the reference for look, copy and order; this spec describes it scene by scene.
Builds on: onboarding widget ([ENG-191](https://linear.app/matrix-os/issue/ENG-191/onboarding-and-chat-widget), spec 627), Getting started popover, App Gallery app builder, personal Matrix Bot + owner SOUL ([ENG-235](https://linear.app/matrix-os/issue/ENG-235/connect-settings-soul-to-the-personal-matrix-bot), spec 551). Overlaps [ENG-141](https://linear.app/matrix-os/issue/ENG-141/featonboarding-implement-the-figma-chat-first-first-task-experience) (chat-first first task).
Owner: Stefan. Reviewers suggested: Hamed (product), Nima, Yuhan (bots).

## Goal

Right after payment, when their new computer's desktop first loads, a new member goes through one short "Get started" wizard. It learns what they want and lets them connect the tools they use. They then land on a desktop where Getting started is already partly done and the onboarding widget picks up from their answers, asks before doing anything, and helps them get a first real result (a fix in their repo, an app built from one sentence).

Why: today a new member pays, waits on a progress screen, and lands on a generic desktop. Getting started and the widget know nothing about them, so the first minutes go to setup instead of value.

## Team feedback (Slack, #tech)

| Who | Feedback | How this spec handles it |
| -- | -- | -- |
| Hamed | The first part should not be a white screen; use a blurred desktop background like the Settings app. | The wizard shows in the Getting started widget over the blurred desktop wallpaper (scene 1). The demo's white screen is a placeholder. |
| Hamed | It is the Get started app, and it cannot be closed until the wizard is finished, like the macOS setup assistant. | The widget cannot be closed or minimized until the wizard is finished. See "Rules". |
| Nima | Later add Aoede (voice assistant) for a "Her" feeling. | Out of scope. Voice comes later. |
| Nima | Target the weekend hackathon. | Priorities below; cut from the bottom if time runs short. |
| Hamed | The very first bot is configured here: a name and personality. It becomes the one connected to WhatsApp and the tech resolver for Matrix issues. | Bonus P2 "Make your AI yours" writes the name and personality into SOUL, which the personal Matrix Bot already reads (ENG-235). WhatsApp ([ENG-126](https://linear.app/matrix-os/issue/ENG-126/use-one-central-matrix-pi-conversation-across-whatsapp-and-matrix)), tech resolver and bots creating bots are later. |
| Stefan | The bot is a plus; the video flow is the most important part. | P0/P1 cover the video; the bot setup is P2. |
| Hamed | Tool selection and connecting should come earlier, not on the last screen: "Connect the tools you use", connected directly, in the exact Integrations design with icons. | Step 3 is "Connect the tools you use" and renders the shared `IntegrationMarketplace` from Settings > Integrations (search, filters, icons, Connect / waiting / Connected). The summary no longer has a connect list. |
| Hamed | Suggest Matrix apps: "because you connected x, y, z, these apps are ready with your data", in a nice listing with icons. | Step 5 lists App Gallery apps whose required services are connected (App Gallery's own readiness rule), with their icons and Add. |
| Nima | The coding agent and first app idea answers are not used: there is no Claude/Codex login afterwards. Use the actual Settings connect components for agent login, and move the app idea to the App Gallery step so picking it starts the build and jumps to Chat. Less a form, more a login step. | Step 3 shows the Settings agent sign-in under each picked agent. The app idea moved to the App Gallery step; finishing with one starts the build when an AI is ready and opens its chat (Stefan: only when the harness is set up). |
| Nima | People sign up with Clerk (Google, GitHub), so we may already have their name. | Step 1 is pre-filled with the sign-in account's first name (Clerk on Web, the signed-in display name on Electron), still editable. Usernames and emails are skipped, and a typed or saved name is never replaced. |


## Customer feedback (22 October 2026)

User-feedback changes, kept apart from the team feedback above (separate stack layer). Main point: after connecting accounts he did not know what to do next; setup must end with a clear, useful first result.

| Feedback | How this spec handles it |
| -- | -- |
| "Connect GitHub" opens the general app directory; he still has to search. | Getting started rows start that app's own sign-in directly (the same connect flow as the onboarding widget). |
| The checklist does not update after connecting GitHub and email. | Getting started reloads every 15 s and on focus on every surface, and at once on any connection change (gateway events on Web, the connect poll on Electron). |
| Email & calendar stays unchecked with only Gmail connected. | The row reads "Connect Google Calendar (1 of 2)" and connects the missing app. |
| Settings shows Codex "Connected on this device" while the login step stays unchecked. | The step adds "On your Matrix computer, where your AI runs"; the device subscription and the computer sign-in are different things. |
| He is asked to connect tools without knowing what they enable. | The wizard's integrations list shows the benefit for known tools ("So your AI can sort and draft email"). |
| After setup he has to work out the next action himself. | A finished step becomes a "Try" action that opens Chat with a ready prompt (for example "Find emails that need a reply"); nothing runs until he sends it. |
| Out of scope here | The update dialog and the "unavailable" repository listing in Chat; tracked separately. |

## Priorities

| Priority | What | Reuses |
| -- | -- | -- |
| **P0** | Get started wizard when the new computer's desktop first loads: name, goals, tools; shown once; resumable | Journey phases in `shell/src/components/BootSequence.tsx` |
| **P0** | "Connect your tools" at the end of the wizard: only the picked tools plus two suggestions | Widget `AppsScreen` connect flow, `useIntegrations().startConnect` |
| **P0** | Desktop opens with Getting started ordered for their goals; connected steps done; billing done | `GettingStartedPopover` step IDs and completion signals |
| **P0** | Onboarding widget greets them by name and leads with what fits their goal | Widget `TasksScreen`, `ONBOARDING_TASKS` |
| **P1** | Widget first task that asks before acting: clone and test a repo, offer a fix on a branch, pull request for review | Widget `RepoScreen` (`/api/github/repos`), `RunScreen` work log, "Open in Chats" |
| **P1** | "Build an app for this" opens App Gallery with the idea; Build hands off to the AI; the new app opens | App Gallery `requestAppBuild` |
| **P2** | "Make your AI yours": name and personality written to `system/soul.md`; personal Matrix Bot created | ENG-235 SOUL reader, `POST /api/chat-agents/instantiate` |
| Later | Weekday check-ins, WhatsApp main bot, tech resolver, bots creating bots, mobile | Schedules, ENG-126 |
| Out of scope | Voice assistant (Aoede) | Later |

If time runs short, cut from the bottom. P0 alone delivers the main promise: answers turn into a desktop that is already partly set up.

## The target, scene by scene

Times are positions in the demo video. Quoted copy is the intended product copy.

### Scene 1: The Get started wizard (0:00–0:13), P0

- **Window:** the Getting started widget, large over the blurred desktop wallpaper like Settings. It cannot be closed or minimized until the wizard is finished. Matrix rabbit logo and "Matrix" top left.
- **Build status, top right (Section 8, optional):** the real provisioning stage, then a green dot, "Your computer is ready" and "Skip to desktop".
- **Progress dots:** four short bars at the top; current and completed steps are dark.
- **Navigation:** Back (left), Skip and Next (right). Next is the dark primary button; on the last question it reads "Finish".
- **Step 1, "What should we call you?"** Text field, placeholder "Your first name", hint "Your AI will use this." Enter goes to the next step. Soft grey focus border.
- **Step 2, "What will you use Matrix for?"** Multi-select chips: "Write code with agents", "Run my business", "Personal assistant", "Build apps", "Just exploring". Hint: "Pick any. We'll set up those first." Selected chips fill black.
- **Step 3, "Connect the tools you use"** The Settings > Integrations marketplace (`IntegrationMarketplace`, same rows, icons, search and filters), with the integrations that fit the chosen goals first. Connect opens the app's own sign-in, like Settings. Above it, only choices that are not integrations:
  - Your coding agent (Write code with agents): Claude Code, Codex. Picking one shows its sign-in right below: the Settings > Agents & providers `HarnessWorkflowPanel`, fed by the surface's own provider snapshot (V3) and workflow client, so state and actions match Settings. The wizard cannot show Terminal, so Terminal sign-ins are not offered there. An agent that is not installed yet (smaller computers preinstall one agent) installs right on the card, running in the background with progress, and its sign-in follows. When connected, the card shows a green Connected and how (the agent's own account, or an API key). OpenCode is not offered until it has a sign-in here.
  - Sounds fun (exploring, or nothing picked): Build something small, Play a game, Ask anything

  The connected integrations become the owner's tools for personalisation (Getting started, widget, bots). A surface without app connections shows "You can connect apps later in Settings".
- **Step 4, "Name your main bot"** (Atlas, Nova, Ada, Sage or own; Brief / Friendly / Playful): "This is your main bot. It uses this name and style everywhere you talk to Matrix." Becomes the full P2 bot setup. Without P2 this step is dropped and the AI stays "Matrix".
- **Step 5, App Gallery:** when connected integrations make App Gallery apps ready (App Gallery's `deriveGalleryReadiness`), the title is "Apps ready with your data" and the hint "Because you connected Gmail and Google Calendar, these apps are ready with your data." Each app shows its gallery icon, name, tagline and "Uses Gmail, Google Calendar", with Add (installs it right away, like App Gallery's own install) then "Added". Up to six apps, most connected services first. Below, "Or build your first app" with the four app ideas. With no ready apps, the step is "Build your own apps" with the four idea cards (icon and one line). This is the only place the first app idea is picked. When the owner finishes setup with an idea and an AI can run it (Matrix AI or a signed-in agent), the widget starts building it at once and opens its chat so they watch it build; without a ready AI it stays the widget's one-click "Build a …" task. Skip clears the idea pick.
- **Step 6, "Meet your bots":** see Section 7b.

### Scene 2: All set (0:13–0:18), P0

- **Heading:** "All set, Sam." with "Using it for" (goals), "Your AI" (name · tone) and "Your bots". Connecting now happens on step 3.
- **Button:** "Enter your computer" (disabled with "Finishing your computer…" until ready).
- Real: `useIntegrations().startConnect`, `shell:open-external`, bounded polling (widget `AppsScreen`), agent sign-in through the provider workflow client.

### Scene 3: Arriving on the desktop (0:18–0:20), P0

- Owner wallpaper, top bar, auto-hiding dock.
- **Getting started popover** open on arrival, ordered by goal, with already-connected steps done.
- **Onboarding widget** bottom-right, compact, with the AI's name. Message: "Hey Sam 👋 … GitHub is connected. Want me to clone your most recent repo, **sam/habit-tracker**, and run its tests?" Chips "Clone it", "Pick another repo", "Not now". Nothing runs until they choose.

### Scene 4: First task, asking before every action (0:20–0:27), P1

- "Clone it" → work log: "Cloned sam/habit-tracker", "Ran the tests: 18 passed", "Read your 3 open Linear issues".
- Follow-up offer: "Your top issue is … Want me to fix it? I'll work on a branch and open a pull request for you to review." Chips "Fix it on a branch", "Not now".
- "Fix it on a branch" → branch, fix, test, pull request. Result card: "Pull request #14 is ready for your review … Nothing is merged until you approve it."
- It never pushes to main, never merges, never changes Linear without asking.
- Real: `RepoScreen`, `RunScreen`, `/api/github/repos`, existing tool approvals. New: the opening question after GitHub is connected, and the follow-up offer.

### Scene 5: Weekday check (0:27–0:28), Later

Out of scope for the hackathon; keep only if schedules can be created with explicit confirmation.

### Scene 6: Build an app from one sentence (0:28–0:36), P1

- "Build an app for this" opens **App Gallery** with personalised Ideas.
- The widget shows "Build: …" with a work log and "Open <app>" on success. The dock shows the new icon. Getting started: "Build your first app" ✓.
- Real: App Gallery and `requestAppBuild` handoff (`[BUILD] …` prompt), default Vite app template, dock.

### Scene 7: Tuck away and see progress (0:36–0:40), P0 popover / P1 bubble

- Minimize shrinks the widget to its bubble with the latest status.
- The Getting started popover shows full progress; the dot disappears.

## Bot setup ("Make your AI yours"), P2

Everything here goes into SOUL; SOUL never grants tools, integrations or approvals (spec 551 R3).

Screen A: **Name** (Matrix, Atlas, Nova, Ada, Sage or own, 1–24 characters); **Personality** (Friendly helper, Straight shooter, Calm mentor, Playful sidekick, Professional assistant, each with a live sample reply); **Avatar** colour via `avatarSeed` (nice-to-have).

Screen B: **Reply length** Short / Balanced / Detailed; **Tone** Casual / Neutral / Formal; **Humour** None / A little / Plenty; **Emoji** Never / Sometimes / Often; **Language** Match my language (default) or a fixed language; **Initiative** Only when I ask / Suggest next steps / Daily summary (preference only); **Always / never** (optional, 500 characters). Shown as a guarantee, not a choice: "Always asks before doing anything outside Matrix." Live preview plus "See what this writes".

| File | Content |
| -- | -- |
| `system/soul.md` | Template stays. A managed section between `<!-- matrix:get-started:start -->` and `<!-- matrix:get-started:end -->` holds the choices. Re-running replaces only that section. Total under the 16 KiB SOUL limit. |
| `system/identity.md` | `Name:` and `Vibe:` lines. |
| `system/user.md` | Name, what to call them, timezone, goals in Context. |

Personal Matrix Bot: at "Enter your computer", create it with `POST /api/chat-agents/instantiate` (`matrix-bot` recipe) and a creation request ID; reuse an existing one. Spec 551 deferred startup bot creation, so this needs Hamed and Yuhan to confirm. The `matrix-bot` recipe has no integrations, so scenes 4 and 6 run through the widget and chat, not the bot.

## Rules

- **The wizard can't be closed until it is finished.** Close and minimize stay hidden while it runs. Each question keeps a Skip.
- **Shown once per account.** Finishing or skipping both count. Recorded on the owner's computer in `system/get-started.json`, so a second device doesn't show it again.
- **Closing the tab or refreshing mid-way does not count.** The wizard resumes with earlier answers.
- **The AI asks before every action.** Clone, branch, pull request, app build, schedules: each needs an explicit yes; connecting always opens the provider's own sign-in. Picking a first app idea on the App Gallery step is that yes for its build: the step says "Pick one and Matrix starts building it in Chat as soon as your AI is ready.", and the build starts at most once, only right after the owner finishes setup.
- **Editable later.** P2 answers change in Settings > Identity & personality; Getting started order follows `get-started.json`.

## Surfaces

| Surface | Scope |
| -- | -- |
| Web Desktop | In scope |
| Web Canvas | In scope (same wizard over the canvas background) |
| Electron Desktop | In scope (enters after device auth through BillingGate) |
| Web Mobile | N/A for the hackathon: mobile onboarding is a separate journey. Needs reviewer approval |
| Native Mobile | N/A for the hackathon: same rationale. Needs reviewer approval |

## Technical approach (checked against main)

| Finding | Consequence |
| -- | -- |
| `BootSequence.tsx` shows provisioning on the platform-served shell before the computer exists; the gateway is not reachable then. | Asking during provisioning needs platform storage and a platform/app-shell deploy. v1 runs the wizard when the desktop first loads; "during the build" is optional Section 8. |
| Gateway `GET /api/settings/onboarding-status` checks `system/onboarding-complete.json`. The platform `first_run` phase depends on a record only a backfill writes. | Wizard progress has its own marker. New homes are seeded; the [existing-owner amendment](existing-owner-enrollment.md) adds owners with no active Matrix agents. |
| `/files/system/soul.md` has a special-cased write path with 16 KiB and control-character validation (spec 551). | P2 renders the SOUL section on the server from validated choices. |
| Getting started has fixed step IDs (`GETTING_STARTED_STEP_IDS`) with real completion detection. | The five steps keep their checks; rows added from answers use existing signals only (connected integrations, a bot's direct chat having messages). |
| The onboarding widget is a shared reducer plus UI (`@matrix-os/contracts`, `@matrix-os/ui`) with thin hosts per surface (ENG-191). | The wizard is built the same way, so all three desktop surfaces share one implementation. |
| Widget starter tasks include "Work on my code" → repo picker → run with work log → "Open in Chats" → one follow-up offer. | P1 maps onto the existing task: reorder it first, use the repo question as the opening, and make "fix the top issue on a branch" the follow-up offer. |
| App Gallery is a sandboxed app; Build sends a fixed `[BUILD] …` prompt through `requestAppBuild`. | v1: the widget sends the same build prompt itself and opens the gallery afterwards. |
| The platform has `POST /internal/first-run`. | Optional completion reporting; not required for the wizard. |

### Data

`system/get-started.json`, owned by the gateway and written only through the endpoint below:

```json
{ "version": 1, "status": "pending" }
{ "version": 1, "status": "in_progress", "updatedAt": "2026-10-25T10:10:00.000Z", "draft": { "name": "Sam", "goals": ["code"] } }
{ "version": 1, "status": "completed", "completedAt": "2026-10-25T10:12:00.000Z", "answers": { "name": "Sam", "goals": ["code", "build"], "tools": ["github", "claude-code", "linear"], "appIdea": "habit-tracker" } }
```

`status` is `pending`, `in_progress` (with a `draft` for resume), `completed` or `skipped`. Tools and app ideas are stable IDs from a shared catalog, never display strings. With no file, the gateway may enroll the primary computer's owner when they have no active Matrix agents and have never completed or skipped this wizard. See the [existing-owner amendment](existing-owner-enrollment.md).

### Gateway endpoint

- `GET /api/settings/get-started` → `{ status: "not_eligible" }` or `{ status, draft? | answers? }`
- `PUT /api/settings/get-started` → body `{ type: "draft" | "complete" | "skip", answers? }` (Zod discriminated union, strict)
- `GET /api/settings/get-started/bots` → what each saved bot choice made `{ bots: { [recipeId]: { status: "created", agentId } | { status: "pending" } } }`, from its Get started creation requests. Getting started uses that bot, never another copy of the same recipe; the bot list leaves removed bots out, so this also tells a removed bot from one whose creation never finished
- `POST /api/settings/get-started/bots` → retries the saved bot choices of a finished setup → `{ bots: { [recipeId]: "ready" | "failed" } }`

A dedicated endpoint instead of generic file writes: answers are validated against enums and caps, files are written to fixed paths only, SOUL is rendered by the server (P2), and completion is one idempotent call. The generic `/files` route is unchanged.

| Request | Current status | Result |
| -- | -- | -- |
| `GET` | no file, eligible primary owner with zero active agents | atomically create `pending`; `200 { status: "pending" }` |
| `GET` | no file, other cohort / kill switch off | `200 { status: "not_eligible" }` |
| `PUT draft` | `pending`, `in_progress` | `200`, status `in_progress` |
| `PUT draft` | `completed`, `skipped` | `409` |
| `PUT complete` | `pending`, `in_progress` | `200`, status `completed` |
| `PUT complete` | `completed` | `200`, existing record (idempotent) |
| `PUT skip` | `pending`, `in_progress` | `200`, status `skipped` |
| `PUT skip` | `skipped` | `200`, existing record (idempotent) |
| `PUT complete` / `skip` | the other terminal status | `409` |
| any `PUT` | not eligible | `404 { error: "Get started is not available" }` |
| `POST /bots` | `completed` | `200 { bots }`, each saved bot created or replayed |
| `POST /bots` | not finished or not eligible | `404`; no request principal `401`; no bot service `503` |
| `GET /bots` | `completed` | `200 { bots }`; same `404` / `401` / `503` rules, `503` when status can't be read |

## Security architecture

| Route | Method | Auth | Public | Body limit | Validation |
| -- | -- | -- | -- | -- | -- |
| `/api/settings/get-started` | `GET` | Gateway global auth (owner runtime bearer or platform JWT) | No | n/a | none (no input) |
| `/api/settings/get-started` | `PUT` | Gateway global auth (owner runtime bearer or platform JWT) | No | 8 KiB | strict Zod discriminated union |
| `/api/settings/get-started/bots` | `POST` | Gateway global auth; request principal required (`401` without) | No | 8 KiB | none (body ignored); acts only on the saved answers |
| `/api/settings/get-started/bots` | `GET` | Gateway global auth; request principal required (`401` without) | No | n/a | none (no input); reads only the saved answers |

Neither path is on the public, webhook, collaboration, route-scoped bearer or WebSocket query-token allowlists, so scoped run tokens, collaborators and app iframes cannot reach it.

- **Auth:** routes sit under `/api/settings`, behind the gateway's existing owner auth (request principal). No new public paths, no query-token WS.
- **Input validation:** `bodyLimit` 8 KiB on PUT; strict Zod discriminated union; enums for goals, tools and app ideas; owner name ≤ 40 and bot name ≤ 24 characters, rules ≤ 500, all free text rejecting control characters and SOUL comment markers (`<!--`, `-->`); arrays capped; the largest valid draft stays ≤ 4 KiB (tested).
- **Who can write:** only the owner. The route sits behind the gateway's global auth; scoped run tokens, Hermes capability tokens, collaborators and app iframes cannot reach it. Only the owner's own text reaches their SOUL.
- **Pinned `system/`:** every read and write of `get-started.json`, `onboarding-complete.json`, `identity.md` and `user.md` goes through `withPinnedSystemDir`, which opens `system/` with `O_DIRECTORY | O_NOFOLLOW` like the owner SOUL writer. On Linux reads, staging writes and renames resolve through the descriptor; every host revalidates the directory before trusting a read or committing a write, so a `system/` replaced by a symlink can never redirect them. A linked profile file is left untouched.
- **Paths:** fixed `system/get-started.json` and `system/onboarding-complete.json` under the home; never derived from input.
- **Writes:** temp file + `rename` for updates; `{ flag: "wx" }` for `onboarding-complete.json`; all mutations serialised per home with `withOwnerFileMutation`; no sync I/O.
- **Errors:** clients get generic messages ("Unable to save your setup"); real errors are logged server-side without answer contents. A corrupt or unreadable state file is a 500 with a generic message, not `not_eligible` (misconfiguration is not not-found), and the shell fails closed to today's desktop.
- **Privacy:** the wizard UI is `ph-no-capture`; analytics carry step IDs and counts only.

## Integration wiring

- `createGetStartedRoutes({ homePath, enabled })` mounted at `/api/settings/get-started` next to the settings routes in `server.ts`; `enabled` is `MATRIX_GET_STARTED_ENABLED=true`, which the platform writes on new computers.
- Eligibility is seeded on the VPS by `matrix-restore.sh` (Section 2), which runs as the owner user before the gateway starts. In its first-installation branch (no `system/vps-meta.json` and no backup pointer in R2, primary runtime slot, `MATRIX_GET_STARTED_ENABLED=true` in `host.env`) it calls `matrix-get-started-seed /home/matrix/home`, which no-clobber writes `{ "version": 1, "status": "pending" }`. Seeding is best effort and never blocks the restore gate.
- The platform passes `MATRIX_GET_STARTED_ENABLED` into `host.env` in both cloud-init templates. It is `true` unless the platform's own env sets it to `false`, which is now only a kill switch (ENG-415).
- Rollout (ENG-415): the PostHog flag `get-started-wizard` (`GET_STARTED_FEATURE_FLAG`) decides who sees the wizard. `GetStartedGate` reads it through each surface's PostHog client (`getShellFeatureFlagSource`, `createDesktopFeatureFlagSource`), holds the widget back while flags load, falls back to today's desktop when the flag is off, fails to load, or takes over 4 seconds, and never closes a wizard that has opened. Builds without PostHog (local dev) and self-hosted computers skip the flag, so the gateway alone decides.
- Shell hosts read the state on desktop load and render the shared wizard (Section 3).

## Failure modes

- Write fails: "We couldn't save your setup. Try again." with Retry; answers kept as draft; not marked done.
- Concurrent PUTs: serialised per home; the second terminal transition sees the first and returns idempotent `200` or `409`.
- Crash mid-write: temp + rename leaves either the old or the new file; stray temp files are dot-prefixed in `system/` and overwritten never (unique names); they are removed on the failure path.
- Connect sign-in doesn't finish: "Sign-in didn't finish" with Try again / Skip.
- Bot creation fails (P2): enter the desktop anyway. The saved answers are the durable intent: reading the finished setup retries any saved bot (at most every 10 minutes per owner, bounded per-owner memory), `POST /bots` retries on request, and Getting started keeps a Create action for a chosen bot whose creation never finished (`GET /bots` says "pending"), even when part of it exists; a bot the owner removed stays hidden. Fixed request IDs make retries idempotent; a bot the owner deleted is never brought back, and a bot already created is never requested again. A retry replays the original request. If the recipe version changed since: an attempt that wrote its definition is finished from it (waiting for any request already finishing it, so it is never made twice), and one that never did starts again under a follow-up request named after the bot it reserved, so it is found again without new state; at most 4 attempts per bot.
- Gateway unreachable on desktop load: don't show the wizard this session; try again on next load.

## Resource management

- State is one small file per home. The only in-memory state is the bot-retry cooldown: one timestamp per owner, capped at 256 owners with the oldest evicted.
- Request bodies capped at 8 KiB; persisted draft capped at 4 KiB.
- Connect polling (Section 4) keeps the widget's existing hard deadline and clears on unmount.

## Deliverables

- Code and tests in this repository, shipped as the ENG-366 stack below.
- **Public docs:** a separate PR in `FinnaAI/matrix-os-site` under `content/docs/` describing the Get started wizard (what it asks, that every question is skippable, that answers can be changed later, and what "Make your AI yours" writes to SOUL). Opened once the wizard ships behind the flag.

## Build sections (GitHub native stack on ENG-366)

Each section is one layer, under the 3000-line limit, tests first.

1. **Contracts and gateway state (P0):** `GetStartedState` / `GetStartedAnswers` schemas and catalog in `@matrix-os/contracts`; `GET/PUT /api/settings/get-started`; `onboarding-complete.json` with `wx` on terminal transitions.
2. **Eligibility for new computers plus kill switch (P0):** seeded by the restore gate's first-installation branch (see Integration wiring); the platform env is on by default and only a kill switch; the PostHog flag gates who sees it (ENG-415).
   - Why not `ensureHome()`: cloud-init creates `/home/matrix/home` before the gateway starts, so its "home does not exist" branch never runs on a VPS. "No `system/` yet" is not safe either: a returning owner on a new machine gets home files back later through the sync agent.
   - Golden snapshots: `matrix-golden-snapshot-sanitize` removes `restore-complete`, `/var/lib/matrix` and the home, so snapshot-based computers still run the restore gate and its first-installation branch.
   - Accepted edge: if registration's `vps-meta` write failed and the owner had no backup yet, a re-provisioned computer looks new and is offered the wizard once.
   - Local dev: no restore gate; write `system/get-started.json` with `{"version":1,"status":"pending"}` by hand and set `MATRIX_GET_STARTED_ENABLED=true`.
3. **Wizard UI on all three desktop surfaces (P0):** shared reducer + `GetStartedWizard`; thin hosts in Web Desktop, Web Canvas, Electron Desktop; no close/minimize while running; draft saved each step; Getting started and widget auto-open suppressed while it runs.
4. **Connect your tools (P0):** picked tools (max 4) plus 2 suggestions, reusing `startConnect`, the external opener and bounded polling.
   - Only apps in the computer's own integration catalog get a Connect button; service ids come from a fixed map in contracts.
   - v1 scope cut: agent sign-ins (Claude Code, Codex, OpenCode) and messaging channels (Telegram, WhatsApp, Email) show as "Later" and stay in Getting started / Settings. Inline agent sign-in through the provider workflow client is a follow-up.
5. **Personalised arrival (P0):** Getting started and widget order by goal; greet by name. No new writes.
   - Getting started stays until done once the wizard ended (finished or skipped), reopening once per load.
   - Getting started adds a "Connect <tool>" row per picked tool the five steps don't already check (done when that integration is connected), a "Chat with <bot>" row per added bot (done once its direct chat has a message; opens that chat; dropped if the bot is removed), and an App Gallery link ("Build your <idea>" or "Build your first app") that is not counted, since building an app has no completion check.
   - The widget's tasks lead with what the picked tools and starter unlock (Google Calendar → Plan my week, GitHub → Work on my code, Ask anything → Research, Build something small → Build a website), then the goal order.
   - The gate publishes the saved answers through `GetStartedAnswersProvider` (mounted next to `GettingStartedVisibilityProvider`), so the popovers and the widget read them without another request.
   - v1 reorders only; opening the widget straight into "Work on my code" and its repo question moves to Section 6.
6. **First task and app building (P1):** "Work on my code" first with a "fix on a branch" follow-up; "Build an app for this" through the existing `[BUILD]` handoff.
   - The first code run clones and runs tests without changing anything. "Fix the top issue on a branch" and "Add a feature" carry fixed rules: new branch, tests, a pull request for review, never push to the default branch or merge, ask before touching anything outside the repo (such as issues).
   - The widget's first line speaks to the first goal and asks; it never starts work by itself.
   - A "Build a <idea>" starter sends App Gallery's own build request. `appGalleryBuildPrompt` now lives in the canonical gallery contract, so the gallery and the widget share one bounded prompt.
   - Deferred: opening App Gallery pre-filled, and chaining the clone result straight into the fix offer with the repo's real top issue.
7. **Make your AI yours (P2):** server-rendered managed SOUL section, `identity.md`, `user.md`; idempotent `matrix-bot` creation.
   - There is one SOUL: `system/soul.md`. The kernel, Matrix Bot (`identitySource: owner_soul`), managed chats and Settings all use it. The wizard owns only the marked section.
   - The section goes **first** in `soul.md`: the kernel reads only the first 2,000 characters (`MAX_SOUL_CHARS`), while bots read the whole file. The largest possible section stays under that limit (tested).
   - Writes reuse `readOwnerSoul` / `writeOwnerSoulAtomic` (16 KiB limit, control characters, no-follow, atomic). `identity.md` / `user.md` only get existing `- **Field:**` lines filled.
   - The Matrix Bot is created on the gateway after the state write and outside the file lock, with a fixed request id (`req_get-started-matrix-bot`), so retries replay instead of duplicating. A failure is logged and never blocks entering the desktop.
   - Still needs Hamed/Yuhan sign-off (spec 551 deferred creating the bot at onboarding). Avatar colour is deferred.
7b. **Bots for you (P2):** a "Meet your bots" screen between the AI step and the summary suggests up to three ready-made bots from the Matrix Bot recipe catalog for the owner's goals (e.g. Daily Brief, Jev Inbox Triage, Writing Bot). Each card shows the bot's gallery avatar, its job and Add; a bot needing an app that is not connected offers that app's sign-in (or "Needs Gmail") instead of Add. Three short notes explain how bots work (one job each, no app access until granted, found in Chat). Skip clears the picks; the summary lists "Your bots".
   - Only catalog recipe ids from a fixed map are accepted (max 3); `matrix-bot` is created only through the AI step.
   - Created on completion through the same instantiation service as the Matrix Bot, one fixed request id per recipe (`req_get-started-<recipeId>`), outside the file lock, best effort.
   - Creating a bot grants no app access; owners grant it per bot later. Needs the same Yuhan sign-off as Section 7.

8. **Start during provisioning (optional, later):** platform-stored draft handed to the gateway on first boot.

## Not breaking anything

- Existing users never see the wizard: eligibility needs the first-boot marker, and the flag is off by default.
- Nothing changes without answers: Getting started, the widget and SOUL behave as today when `get-started.json` is missing.
- Additive files only: new `system/get-started.json`; `onboarding-complete.json` written with `wx`; `soul.md` changed only inside its marked section (P2).
- Kill switch: flag off hides the wizard immediately and the gate reports nothing eligible, so saved answers stop personalising Getting started and the widget too. Anything already written to SOUL stays, as the owner's own text.
- Rollout: preview VPS (`preview-vps` label) → disposable test VM → flag on for new sign-ups.

## Acceptance checks

P0:

1. New account → computer ready → the wizard opens over the blurred wallpaper; it can't be closed or minimized until finished; each question can be skipped.
   - 1a. An existing owner with zero active Matrix agents is offered setup once; an owner with active agents is excluded. Completed/Skipped records stay terminal; flag off → nobody sees it.
2. Refresh mid-wizard, or open Electron Desktop mid-wizard → resumes with the saved draft. Finish → never shown again on any surface.
3. Skip everything → desktop opens; `get-started.json` has `status: "skipped"`; nothing else changed.
4. "Write code with agents" + GitHub + Claude Code, connect both → Getting started opens with coding steps first and those done; the widget greets by name with the clone question.
5. A write failure → retry message, answers kept, wizard not marked done.

P1:

6. "Clone it" → work runs only after the click; "Fix it on a branch" → pull request opened, nothing merged, Linear unchanged.
7. "Build an app for this" → App Gallery opens with the idea; Build hands off; the new app appears in the dock and opens.

P2:

8. Name "Atlas", Straight shooter, Short, No emoji, Match my language → `soul.md` has exactly one managed section; template intact; ≤ 16 KiB.
9. New Matrix Bot chat replies as Atlas, short, no emoji, in the message's language.

Evidence: live screenshots and a short recording for Web Desktop, Web Canvas and Electron Desktop, in the PR and #tech.

## Risks

- **Drop-off at connect.** Keep rows few, always skippable; measure connect vs skip.
- **Build time.** With golden snapshots the wait may be seconds, so the wizard must work as a first-login flow.
- **Two first-task owners.** ENG-141 covers the chat-first first task; agree who owns scenes 4 and 6.
- **SOUL edits.** Owners may hand-edit `soul.md`; only the marked section is ever replaced.

## Open questions

1. Hamed/Yuhan: OK to create the personal Matrix Bot at the end of the wizard? Does `instantiate` take a display name and `avatarSeed`?
2. Should the onboarding widget become the personal Matrix Bot's conversation, or keep its own chat and only show the bot's name?
3. Personality preset wording: product/design review.
4. ENG-141 overlap: who owns the first-task part.
