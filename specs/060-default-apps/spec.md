# Spec 060: Default Apps — Connected Life

**Status**: Draft
**Created**: 2026-04-12
**Depends on**: 063 (React App Runtime — REQUIRED), 049 (Platform Integrations — shipped), 050 (App Data Layer — shipped), 053 (Onboarding — needs update)
**Constitution alignment**: I (Everything Is a File), VI (App ecosystem), VIII (Defense in depth)

## Problem

Matrix OS ships 11 local-only utility apps in `home/apps/{calculator, clock, expense-tracker, games, notes, pomodoro, profile, social, task-manager, todo, weather}`. None connect to external services. None pull real user data. All are hand-written inline HTML/CSS/JS (~12K lines total). The quality ceiling is capped by this authoring style — every app reinvents layout, state, and design primitives.

For waitlist users arriving at matrix-os.com from OpenClaw, Lovable, v0, or similar AI-native tools, the first session is underwhelming. They see generic local apps, not an OS that knows their life. The #1 OpenClaw use case is email/inbox management. The #1 consumer category is communication + productivity. Spec 049 shipped Pipedream Connect (3,000+ integrations) and spec 063 (proposed) gives us a real React runtime. The combination unlocks a **Connected Life** default experience: on first session, the user connects Gmail + Calendar + Spotify, and three default apps immediately populate with their real data.

## Target User

Waitlist signups from matrix-os.com. Technical-curious builders who have used OpenClaw, Lovable, v0, or similar AI-native desktop tools. They expect:
- Working output within 5 minutes of signup
- Real data from real services, not demo data
- A modern UI that doesn't feel like a 2014 jQuery demo
- The feeling of having a personal assistant, not a generic desktop

## Success Criteria

- New user connects 1+ service within the first 5 minutes (PostHog event)
- At least 3 default apps opened in the first session
- User sees their own real email / calendar / music data inside Matrix OS within 60 seconds of connecting the first service
- Day-1 retention (first-time return) above 40%
- Qualitative: users describe the OS as "mine" or "personal" in feedback surveys

## Scope — Existing 11 Apps

| App | Current | Decision | Reason |
|---|---|---|---|
| calculator | static HTML | **Keep `static`** | It works. Simple utility. No upgrade warranted. |
| clock | static HTML | **Keep `static`** | Same — timezone fixes inline if needed. |
| games | static HTML | **Keep `static`** | Each subgame is a self-contained canvas app; migration buys nothing. |
| weather | static HTML | **Migrate to `vite`** | Currently fake/static; needs real geolocation + API call. |
| notes | static HTML | **Migrate to `vite`** | Major quality upgrade: markdown rendering, search, tags, keyboard shortcuts. |
| todo | static HTML | **Migrate to `vite`** | Natural-language date parsing, subtasks, recurring. |
| expense-tracker | static HTML | **Migrate to `vite`** | Charts via recharts, CSV import, multi-currency. |
| pomodoro | static HTML | **Migrate to `vite`** | Stats dashboard, streak tracking, sound packs. |
| task-manager | static HTML | **Migrate to `vite`** | Kanban with drag-drop (@dnd-kit). |
| profile | static HTML | **Migrate to `vite`** | Modernize; actually serve at `{handle}.matrix-os.com`. |
| social | static HTML | **Migrate to `vite`** | Major: feed with infinite scroll, comments, media, virtualized list. |

Calculator, clock, and games stay as-is. Everything else gets a React rewrite against the spec 063 Vite runtime.

## Scope — New Connected Apps

Each app below is a discrete, parallel-assignable work item. Unless noted, all new apps declare `scope: "personal"` in matrix.json (forward-compat for spec 062 shared apps — changing the scope later is a one-field edit).

---

### Mail — Connected inbox (reference implementation, top priority)

- **Runtime**: `node` (Next.js) — needs server-side Pipedream OAuth callback and background sync
- **Data**: Pipedream Gmail integration (spec 049)
- **Schema** (spec 050): `messages`, `threads`, `labels`, `sync_cursor`, `drafts`
- **v1 features**: inbox, threaded view, mark read/unread, archive, search, star, reply (sent via Gmail API), compose new
- **v2 features**: AI triage via kernel skill, draft suggestions, smart labels, snooze
- **Libraries**: `@tanstack/react-query`, `react-markdown`, `dompurify`, `date-fns`, `lucide-react`, `@radix-ui/react-dialog`
- **Scope**: personal
- **Effort**: L (5–7 days for v1)
- **Why first**: highest emotional payoff (everyone has a messy inbox), sets the quality bar for every other agent to reference

### Calendar — Connected calendar

- **Runtime**: `vite` (SPA) — reads GCal via Pipedream, writes via kernel
- **Data**: Pipedream Google Calendar integration
- **Schema**: events cache (per-app Postgres), sync cursor
- **Features**: day/week/month views, create/edit events, free/busy, meeting details, natural-language event creation
- **Libraries**: `date-fns`, `@tanstack/react-query`, `framer-motion`, `@dnd-kit/core` (drag events to move)
- **Scope**: personal
- **Effort**: M (3–5 days)

### Music — Now playing + library

- **Runtime**: `vite` (SPA)
- **Data**: Pipedream Spotify integration
- **Features**: now playing, play/pause/skip, top artists (1w/1m/1y), playlists, search, play queue, recently played
- **Libraries**: `@tanstack/react-query`, `framer-motion`, `wavesurfer.js` (waveform art for now playing)
- **Scope**: personal
- **Effort**: M (3–4 days)

### Files — Drive-backed file browser

- **Runtime**: `vite` (SPA)
- **Data**: Pipedream Google Drive integration
- **Features**: browse folders, upload, download, preview (images, PDFs, text), share links, search
- **Libraries**: `@tanstack/react-query`, `react-pdf`, `react-dropzone`, `lucide-react`
- **Scope**: personal
- **Effort**: M (4–5 days)

### Inbox — Unified messages (mail + notifications + DMs)

- **Runtime**: `node` (Next.js) — needs background aggregation job
- **Data**: aggregates Mail + Matrix DMs + kernel notifications + future channels
- **Features**: unified feed, mark all read, filter by source, AI triage integration, bulk actions
- **Libraries**: `@tanstack/react-query`, `react-virtuoso` (virtualized infinite scroll)
- **Scope**: personal
- **Effort**: L (5–6 days)
- **Depends on**: Mail (reads from Mail's Postgres schema)

### Maps — Browse + save locations

- **Runtime**: `vite` (SPA)
- **Data**: OpenStreetMap tiles (no auth), optional Google Places via Pipedream for enrichment
- **Features**: map view, search, saved locations, directions, satellite layer, per-app Postgres for saved places
- **Libraries**: `maplibre-gl`, `@tanstack/react-query`
- **Scope**: personal
- **Effort**: M (3–4 days)

### Reader — RSS + bookmarks + read-later

- **Runtime**: `node` (Next.js) — needs background RSS polling via cron
- **Data**: `feeds`, `items`, `bookmarks` (per-app Postgres)
- **Features**: add feed, feed list, article view, mark read, star, full-text search, bookmarklet for read-later
- **Libraries**: `rss-parser`, `@tanstack/react-query`, `react-markdown`, `@mozilla/readability`
- **Scope**: personal
- **Effort**: M (4 days)

### Camera — Photo + video capture

- **Runtime**: `vite` (SPA)
- **Data**: saves to local filesystem under `~/data/camera/` (spec 050 blob storage)
- **Features**: capture photo/video, filters (CSS), share to Mail/Social, gallery view, delete
- **Libraries**: native MediaDevices API, `browser-image-compression`
- **Scope**: personal
- **Effort**: S (2–3 days)

### Dashboard — System + container stats

- **Runtime**: `vite` (SPA)
- **Data**: gateway `/api/system/stats` endpoint (new — small Hono handler, not a new spec)
- **Features**: CPU/memory graph, disk usage, running apps, recent kernel activity, quick actions (restart, clear cache)
- **Libraries**: `recharts`, `@tanstack/react-query`, `framer-motion`
- **Scope**: personal
- **Effort**: S (2–3 days)

## First-Session Onboarding Flow

Updates spec 053 onboarding:

1. User signs in at matrix-os.com → lands on desktop (existing)
2. Onboarding window opens: **"Make Matrix OS yours — connect your life in 60 seconds"**
3. Three cards, one-click OAuth each (via Pipedream Connect):
   - **Gmail** → unlocks Mail + Inbox
   - **Google Calendar** → unlocks Calendar
   - **Spotify** → unlocks Music
4. On each connect: show spinner "Pulling your data..." → within ~5 seconds the corresponding app icon bounces on the desktop and a toast says "Mail has 12 unread"
5. After 0+ connections the user can dismiss onboarding with "Skip for now"
6. AI greets in chat: "I see you have 12 unread emails, 3 meetings today, and Radiohead is your top artist this week. Want me to set up a morning briefing?"

Design rules (per `specs/ux-guide.md`):
- No layout shift — onboarding is a transient overlay, not a route
- Escape dismisses
- Progressive disclosure — three cards now, more integrations in a secondary panel
- Empty states — before OAuth, each app icon shows a subtle "Connect to activate" overlay

## Total Effort

| Batch | Apps | Sequential | Parallel |
|---|---|---|---|
| Existing quality upgrades | 8 apps (weather, notes, todo, expense, pomodoro, task-manager, profile, social) | ~20–25 days | ~5 days (8 agents) |
| New connected apps | 9 apps (mail, calendar, music, files, inbox, maps, reader, camera, dashboard) | ~35–45 days | ~7 days (6–8 agents) |
| **Total elapsed** | 17 apps | ~60 days | **~12–15 days** |

## Parallelization Plan

Spec 063 Phase 1 (Vite runtime) must land first. Once it is in, app work is embarrassingly parallel — each agent owns one `~/apps/{slug}/` folder end-to-end, zero merge conflicts.

**Wave 1 — Runtime + reference app (serial, ~3–4 days)**
1. Spec 063 Phase 1 — static + Vite runtime (1 agent, main branch)
2. Build Mail as the reference Vite app while Phase 1 lands (1 agent)
3. Build `_template-vite/` skeleton with bridge hooks, design tokens, react-query setup (part of 063)

**Wave 2 — Parallel app fanout (~7–10 days with 6–8 concurrent agents)**
- Agent team assignments (one app each):
  - Calendar (Vite)
  - Music (Vite)
  - Files (Vite)
  - Maps (Vite)
  - Camera (Vite)
  - Dashboard (Vite)
- Each agent: scaffold from `_template-vite`, implement, add Playwright screenshot tests, commit per app

**Wave 3 — Server apps + quality upgrades (~5–7 days)**
- Spec 063 Phase 2 (Node runtime) — 1 agent
- After Phase 2 lands: Inbox (Next.js), Reader (Next.js) — 2 agents
- In parallel with Phase 2 (since the Vite runtime is enough): migrate notes, todo, expense-tracker, pomodoro, task-manager, social, profile, weather — 8 agents, one per app

**Agent rules** (per project guidelines in CLAUDE.md and stored user preferences):
- Use Agent Teams (TeamCreate), not regular subagents
- Work on main branch (no feature branches per swarm rule)
- Never use worktree isolation
- Never call TeamDelete
- Commit progress after each completed app
- Each agent owns one `~/apps/{slug}/` folder end-to-end

## Shared Component Library

All new Vite apps import from a shared design system package to keep look-and-feel consistent:

- **Package**: `shell/src/app-sdk/` exported as `matrix-os/client` via import map
- **Surface**:
  - Components: `Button`, `Card`, `Input`, `Textarea`, `Sheet`, `Dialog`, `List`, `ListItem`, `EmptyState`, `Toast`, `Avatar`, `Badge`, `Tabs`
  - Hooks: `useKernel()`, `useData(app, key)`, `useFile(path)`, `useTheme()`, `usePipedream(integration)`
  - Utilities: `sendToKernel(text)`, `openApp(slug)`, `notify(msg)`
- **Styling**: Tailwind tokens matching shell design tokens (terracotta primary, parchment background)
- **Types**: ships `.d.ts` so TSX apps get autocomplete + type safety

This package is versioned and declared in matrix.json as `"runtimeVersion": "^1.0.0"`. Breaking changes bump major; new hooks bump minor.

## Testing Strategy

**Per-app screenshot tests** (Playwright): capture default state, connected state (with fixture data), empty state, error state. Four screenshots × 17 apps = 68 baseline snapshots. Per stored user preference, screenshot tests are mandatory for all user-facing features.

**Bridge integration tests**: each app's `useKernel`, `useData`, and theme subscriptions verified against a stub shell in isolation.

**Visual regression**: image diff in CI; new spec branch creates a new baseline.

**Data layer tests**: per-app Postgres schema validated, migrations run, CRUD round-trip verified.

**Onboarding E2E** (Playwright): signup → connect Gmail → Mail app shows messages. One end-to-end test covering the critical path.

**Performance budgets**: each Vite app bundle must be under 500 KB gzipped (fails CI otherwise). Server apps (Next.js) must boot within `startTimeout` (default 10s).

## Quality Gates Checklist

- [x] **Security**: Clerk session + Pipedream OAuth per user, matrix.json Zod-validated, Pipedream response validation before DB write, generic error responses client-side with detailed server logs, no provider name leakage
- [x] **Integration wiring**: each app declares its Pipedream integration in matrix.json, bridge hooks are typed, Postgres schemas declared per app and migrated by the app data layer
- [x] **Failure modes**: OAuth revoked (re-prompt), Pipedream quota hit (warn and disable sync), API rate limit (exponential backoff with jitter), offline (serve cached data from local Postgres), stale data indicator in UI
- [x] **Resource management**: per-app sync cursors in Postgres, background sync debounced, local cache TTLs, server apps respect `idleShutdown` to free processes

## Open Questions

1. **Which 3 integrations for onboarding?** Gmail + GCal + Spotify is the current pick — highest emotional payoff, all supported by Pipedream. Alternatives worth considering: Notion, Slack, Linear.
2. **Installable / removable or always-present?** Lean: installed by default, removable via an App Store view, reinstallable at any time.
3. **Data ownership forward-compat for spec 062**: all apps declare `scope: "personal"` in matrix.json now, so migration to `scope: "shared"` later is a one-field change.
4. **Reference quality bar**: Mail is the reference. Before fanning out, all agents should study Mail's patterns (bridge usage, react-query conventions, design tokens, error states). Mail gets a design review from the user before other agents start.
5. **AI-built apps**: future spec — user asks "build me a chess puzzle app" and an agent scaffolds it against the same runtime. Out of scope here.

## Non-Goals

- Plugin / extension system for third-party default apps (future)
- Offline-first sync with conflict resolution (covered by spec 062 shared apps eventually)
- Mobile variants of these apps (covered by spec 027 Expo app, future)
- Paid / premium apps tier
- AI-generated custom apps per user (separate spec)
- Replacing the existing calculator / clock / games (explicit keep decision)

## Related Specs

- **063 React App Runtime** — foundation; must land first
- **049 Platform Integrations** — Pipedream Connect; shipped
- **050 App Data Layer** — per-app Postgres; shipped
- **053 Onboarding** — needs the "connect your life" step
- **062 Shared Apps** — future; `scope` field declared now for forward compat
- **038 App Platform** — originating spec for the `runtime: "node"` concept
