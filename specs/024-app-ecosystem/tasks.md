# Tasks: App Ecosystem (AI Button, App Store, Desktop Modes)

**Task range**: T760-T779
**Parallel**: PARTIAL -- these are lower-priority, incremental features. Each sub-section is independent. Schedule after higher-priority specs.
**Deps**: T710 (matrix.md convention) for app store metadata. T661 (image gen) for AI-generated icons.

## User Stories

- **US-AE1**: "I can customize any app or component by clicking an AI button and describing what I want"
- **US-AE2**: "I can browse and install pre-made apps and prompts from a store"
- **US-AE3**: "I can switch desktop modes (ambient, dev, conversational) to match my current activity"

## Part A: AI Customization Button

- [ ] T760 [US-AE1] AI button component in shell:
  - `shell/src/components/AIButton.tsx`: small sparkle/wand icon button
  - Positioned at top-right of every app window (alongside traffic lights)
  - Click opens a mini prompt input: "How should I change this app?"
  - Sends: `{ type: "customize_app", app: appName, instruction: userText }`
  - Kernel receives, reads app source, applies modification, reloads iframe

- [ ] T760a [P] Write test for customize dispatch:
  - `tests/gateway/customize.test.ts`: customize message dispatches to kernel with app context
  - Kernel receives app source path and modification instruction

- [ ] T761 [US-AE1] Kernel customization flow:
  - New dispatch type: `customize_app`
  - Kernel reads app file, user instruction, modifies file in place
  - Uses builder agent with additional context: "Modify this existing app, don't rewrite from scratch"
  - After save: gateway detects file change, notifies shell, iframe reloads

- [ ] T762 [US-AE1] Component-level selection (stretch):
  - User can shift+click on an element in an app to select it
  - Sends element's HTML/CSS to kernel as context
  - "Make this button bigger" or "Change the color scheme of this section"
  - Implementation: inject selection script into app iframe, PostMessage to shell

## Part B: App Store Basics

- [ ] T763 [US-AE2] App store data model:
  - `home/system/app-store.json`: catalog of available apps
  - Each entry: `{ id, name, description, category, author, source, matrix_md, downloads?, rating? }`
  - Source types: `bundled` (shipped with OS), `url` (download from URL), `prompt` (generate from prompt)

- [ ] T764 [US-AE2] Prompt library:
  - Collection of proven prompts that generate useful apps
  - Stored in `home/agents/knowledge/app-prompts.md` or `home/system/app-store.json`
  - Categories: productivity, games, dev tools, data visualization
  - User can "install" by clicking, which sends the prompt to kernel

- [ ] T765 [US-AE2] App store shell component:
  - `shell/src/components/AppStore.tsx`: grid view of available apps
  - Filter by category, search by name/description
  - "Install" button: copies app file to ~/apps/ (or generates from prompt)
  - "Preview" button: shows screenshot/description
  - Accessible from dock or Cmd+K palette

- [ ] T766 [US-AE2] Leaderboard concept (stretch):
  - Track app installs/usage across platform instances
  - Platform endpoint: `GET /api/store/popular`
  - Display: "Most popular apps this week"
  - Requires platform service (008B) to aggregate

## Part C: Desktop Modes

- [ ] T767 [US-AE3] Mode system:
  - `shell/src/hooks/useDesktopMode.ts`: mode state management (Zustand)
  - Modes:
    - **Desktop** (default): full OS with dock, windows, Mission Control
    - **Ambient**: minimal, clock/weather widget only, dark background, notification feed
    - **Dev**: code editor prominent, terminal visible, file browser, dark theme
    - **Conversational**: full-screen chat, no windows, InputBar centered (like current minimal state)
  - Mode switch: Cmd+K palette action, or dedicated mode button in corner

- [ ] T768 [US-AE3] Mode layouts:
  - Each mode defines: visible components, layout positions, theme overrides
  - `Desktop`: all components visible, standard layout
  - `Ambient`: hide dock, hide windows, show floating widget (time + weather + next cron job)
  - `Dev`: terminal expanded to bottom half, code editor maximized, dock minimal
  - `Conversational`: ResponseOverlay centered and expanded, no desktop background apps

- [ ] T769 [US-AE3] Mode persistence:
  - Save active mode to `~/system/layout.json` (extend existing layout persistence)
  - Restore mode on page load

## Part D: Task Manager as Prebuilt App

- [ ] T770 [US-AE2] Task Manager prebuilt app:
  - `home/apps/task-manager.html`: standalone task manager (not the shell MissionControl)
  - Reads from `GET /api/tasks` (existing endpoint)
  - Features: kanban view, list view, create/edit/delete tasks, filter by status/assignee
  - Uses OS bridge for API calls
  - matrix.md: name "Task Manager", category "productivity", icon clipboard emoji
  - Demonstrates dogfooding: an OS app that manages the OS's own tasks

## Implications

- **AI Button (T760-T762)**: most impactful demo feature. "Click a button, describe the change, app updates live." This is the killer feature.
- **App Store (T763-T766)**: starts simple (JSON catalog + prompts). Don't over-engineer. Platform-level store (with user uploads, ratings) is 009 P2 scope.
- **Desktop Modes (T767-T769)**: polish feature. Shows the OS is adaptable. Dev mode is most useful for hackathon demo.
- **Task Manager (T770)**: simple but demonstrates the OS using its own APIs. Built as a prebuilt app, not a shell component.
- **Iframe security**: AI button needs to communicate with apps in iframes. PostMessage API with origin verification. Don't expose full OS context to app iframes.
- **Future**: app store becomes marketplace (009 P2). Desktop modes become user-creatable. AI button becomes universal customization interface.

## Checkpoint

- [ ] Click AI button on expense tracker, say "add dark mode" -- app updates in place.
- [ ] Open app store from Cmd+K, browse apps, install a new one.
- [ ] Switch to "Dev" mode -- layout changes to dev-focused.
- [ ] Task Manager app opens and shows kernel tasks.
- [ ] `bun run test` passes.
