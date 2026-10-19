# 627: Chat-first onboarding widget (ENG-191)

Visual source: [Desktop app, Onboarding - chat widget 1164:9060](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1164-9060), Cover plus sections 1–9 (Archive ignored), read on October 9, 2026. Corner widget measurements come from node 1177:1324. Visual consistency target: page "💬 Chat-Agents-projects" (spec 544).

## Outcome

A new user lands on their desktop with the Matrix chat widget already open. It offers four starter tasks and reaches a real result in about two minutes, asking for an app only when a task needs one.

## Surfaces and slicing

| Slice | Scope |
| --- | --- |
| PR 1 (this) | Shared state machine and task catalog (`@matrix-os/contracts`), shared presentational widget (`@matrix-os/ui`), Electron Desktop host and controller |
| PR 2 | Web Desktop and Web Canvas host, using the same contracts and UI |
| Docs | Separate `FinnaAI/matrix-os-site` PR under `content/docs/`: a getting-started guide for the widget covering the starter tasks, connecting apps, changing the AI, and the "Show on every login" setting. Opened once the widget ships on Electron Desktop |
| Later | Server-persisted onboarding completion, "Save a task as an agent", day-2 return, mobile (Cover "Later iterations") |

Electron Desktop is the visual reference. Web Desktop and Web Canvas must reuse the same `reduceOnboardingWidget`, `deriveOnboardingRunView` and `OnboardingWidget` components. Only the surface adapter (chat client, integrations, provider workflow, window opening) differs.

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | PR 2 | PR 2 | PR 2 | shared reducer/UI tests | PR 2 |
| Web Desktop | PR 2 | PR 2 | PR 2 | shared reducer/UI tests | PR 2 |
| Electron Desktop | pass | pass | pass | pass | screenshot |
| Web Mobile | N/A: Cover lists mobile as a later iteration | N/A | N/A | N/A | N/A |
| Native Mobile | N/A: Cover lists mobile as a later iteration | N/A | N/A | N/A | N/A |

## Behavior

- **Sizes.** Bubble ⇄ corner widget ⇄ full chat (9.1). The full chat is the existing Chat app opened on the same canonical conversation. "Shrink to corner" in Chat is deferred; the widget reopens from the bubble.
- **Auto-open.** The widget opens on login until the first task completes. After that, the "Show on every login" toggle (9.2) decides. Preferences (`showOnLogin`, `firstTaskCompleted`, `size`, `position`) are stored per account and per computer.
- **Header.** Rabbit avatar, "Matrix", then more · minimize · expand. No "Online" label. A status line appears only for "Working…", "Starting your computer…" or "Connecting Claude…".
- **Placement.** Drag the header or the bubble anywhere on the viewport (Electron Desktop, Web Desktop and Web Canvas share this). The drop is saved as offsets from the nearest corner so a window resize keeps the widget put, and the card still grows away from that corner. It stays at least 8px from the edges. The More menu can still jump it to the left or right bottom corner, or back to its last corner after a free move. Saved left/right-only prefs become that bottom corner.
- **Task rhythm (3–6).** One question with chips → at most one connect card (Connect / Skip) → a work log with checks → a result summary with Open in Chats → exactly one follow-up offer.
- **Connect apps first (2).** Search, filter chips, Connect / Connected rows, Done. Back on the task list, the confirmation names the newly connected apps, and their task tags disappear.
- **Change the AI (7).** Matrix AI / Claude / ChatGPT · Codex / More in Settings. Claude → Claude account (Recommended) or API key → waiting for sign-in (Reopen tab / Cancel) or key entry ("Stored on your computer only.") → "Claude connected". Back on the task list, the footer shows the new AI. This uses the same provider workflow V2 client as Settings.
  - Matrix AI runs only on Hermes (`hermes_default`) or the managed Matrix route (`matrix_pi_default`), never on whatever else the catalog would default to. When neither can run, the menu marks Matrix AI "Not available on this computer" and tasks run on the first connected AI, which the footer, the follow-up "Using …" line and the connect flow's keep button name. The saved choice stays Matrix AI, so it comes back once Matrix AI can run. With no AI able to run, the footer says "Matrix AI isn't available here".
- **Not normal (8).**
  - Computer starting: tasks can still be picked; the run is queued and starts when ready.
  - Failed run: the failed step shows in red, with Try again / Try a simpler version.
  - Sign-in did not finish: a red line, with Try again / Skip.
  - Minimized while working: the bubble shows "Working…" plus the task.
  - Done while minimized: the bubble shows the ready line plus a count badge.
  - Free credits used: shown only after a result, with Add credits / Use my Claude or ChatGPT.
- **Keyboard.** Every control is a native button or input. Esc minimizes the widget to the bubble. Typing in the composer always works and starts a free-form task.

## Architecture

- `packages/contracts/src/onboarding-widget.ts`: a pure reducer with typed events (discriminated union), the starter-task catalog with exact Figma copy, prompt builders, and `deriveOnboardingRunView(detail, runId)`. That function projects canonical chat messages into a bounded work log, a result and a failure.
- `packages/ui/src/onboarding-widget/`: presentational components. They take `state`, a derived view model and callbacks, and do no network I/O. Logos come in from the adapter as React nodes. Placement is `position.ts` plus `use-widget-position.ts`; hosts pass the saved `prefs.position` through the shared session hook.
- Electron `features/onboarding-widget/`: the controller hook owns the reducer. Each task:
  1. Creates a new canonical chat named after the task (`onboardingChatTitle`, for example "Research: AI agent pricing" or "Plan my week"). Retries and follow-ups go back into that task's chat.
  2. Admits turns with the default composer selection derived from the provider catalog.
  3. Stays on the widget while the run works and shows a short summary of the result. Only **Open in Chats** on the result opens the main Chat on that chat and shrinks the widget to its bubble (`useOnboardingChatHandoff`, shared by Electron Desktop, Web Desktop and Web Canvas; [ENG-304](https://linear.app/matrix-os/issue/ENG-304/show-the-onboarding-result-in-the-widget-before-opening-chat)).
  4. Subscribes to the shared canonical chat event stream and reloads the chat detail on `chat.changed`.

  Integrations use `useIntegrations().startConnect` plus `shell:open-external`, with bounded polling through `syncNow`. AI changes use `createDesktopProviderWorkflowClient`.

### Security

- No new endpoints. Every call goes through existing authenticated gateway routes: `/api/chats*`, `/api/integrations*`, `/api/ai/provider-workflows*` and `/api/github/repos`, with their existing body limits, Zod validation and principal checks.
- Prompts are built only from catalog constants and user-chosen chip or composer text. Composer text is trimmed and capped at 2,000 characters before admission. Repo URLs must match `https://github.com/<owner>/<repo>`.
- API keys never enter reducer state, logs or chat history. The key input is uncontrolled, read once on submit, and cleared after submit.
- The UI shows only allowlisted copy. Server error strings are never rendered.

### Failure modes

| Failure | Behavior |
| --- | --- |
| Chat create or admit fails | Failure screen with "I couldn't start this one." plus Try again / Try a simpler version |
| Run fails | Failed step in red, with the same actions |
| Event stream drops | The shared event source reconnects; the detail is refetched on reconnect |
| Integration connect never completes (≤108 s poll) | "Sign-in didn't finish" with Try again / Skip |
| Provider workflow fails, expires or is cancelled | Inline red line; onboarding returns to the task list on Cancel |
| Computer unavailable | Task queued with "Starting your computer · ~1 min"; starts when the connection reports ready |
| Account or computer switch mid-flow | Controller resets; in-flight results from the old identity are ignored |

### Resource management

- Transcript capped at 40 items, work log at 6 steps, apps list at 50 rows, repos at 20.
- One event-stream subscription per mounted widget, disposed on unmount or identity change.
- Integration and provider polls use a single timer each with a hard deadline, cleared on unmount.

## Invariants

- **Source of truth:** canonical chat (owner Postgres) for conversation content. Local preferences only control presentation.
- **Lock/transaction scope:** none added. Chat admission idempotency comes from `clientRequestId`.
- **Acceptable orphan states:** if a task's chat is created but its first turn is not admitted, the empty chat stays visible in the Chat app and a retry starts the task in a new chat.
- **Auth source of truth:** the existing desktop trusted-core session (`useConnection().api`).
- **Deferred:** server-side onboarding completion, "Shrink to corner" control inside the Chat app, Web surfaces (PR 2), save-as-agent, mobile.
