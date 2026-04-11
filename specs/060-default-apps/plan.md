# Default Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to orchestrate the parallel waves below. Individual app builds follow the standard playbook in the Per-App Build Playbook section.

**Goal:** Ship 17 high-quality apps as default (8 upgraded existing + 9 new connected) against the spec 063 React runtime, so first-session users see real data from their digital life within 60 seconds of signup and every default app looks polished, consistent, and connected.

**Architecture:** Each app is a self-contained project under `home/apps/{slug}/` owned end-to-end by a single agent. Existing `static` apps stay unchanged; quality-pass apps become `runtime: "vite"`; new connected apps split between `vite` (SPA) and `node` (Next.js for server-backed work like Mail/Inbox/Reader). All apps share the `matrix-os/client` design system and hooks package shipped as part of spec 063.

**Tech Stack:** React 19, TypeScript 5.5 strict, Vite 6 (SPA apps), Next.js 16 (server apps), Tailwind CSS v4, `@tanstack/react-query` 5, Zod 4, Pipedream Connect (spec 049), per-app Postgres schemas (spec 050), Playwright for screenshot tests.

**Constitution gates:** Everything Is a File (each app is a normal project directory), TDD (bridge + Postgres tests before implementation), Defense in Depth (Pipedream OAuth per user, response validation, generic client errors).

---

## Dependency Chain

```
Spec 063 Phase 1 (Vite runtime)           -- BLOCKS every Vite app
  |
  +--> Wave 1: Template + Mail (reference) -- sets quality bar
        |
        +--> Wave 2: Parallel Vite app fanout (6-8 agents)
              |
              +--> Spec 063 Phase 2 (Node runtime)
                    |
                    +--> Wave 3: Server apps (Inbox, Reader) + migrations
```

**Parallelization note:** The 8 existing-app migrations in Wave 3 are Vite-only — they can start as soon as Phase 1 lands. They do NOT need Phase 2. Only the server apps (Inbox, Reader) are gated on Phase 2. Scheduling should fan these 8 migrations out in parallel with new-app Wave 2 if agent capacity allows.

---

## Wave Structure Overview

| Wave | Length | Concurrency | Outputs |
|---|---|---|---|
| **W1 Foundation** | ~4 days serial | 1 agent | `_template-vite/` validated, Mail reference app shipped, onboarding flow updated |
| **W2 Parallel Vite fanout** | ~7 days elapsed | 6-8 agents | Calendar, Music, Files, Maps, Camera, Dashboard + existing-app migrations |
| **W3 Server apps + finish** | ~5-7 days | 2-4 agents | Inbox (Next.js), Reader (Next.js), remaining migrations, onboarding E2E |

Each agent works on main. No feature branches. Commit per completed sub-task. Use Agent Teams (TeamCreate) — never regular subagents, never worktree isolation (per stored user preferences).

---

## Wave 1 — Foundation

### W1-T1: Validate `_template-vite/` + Bridge SDK (spec 063 handoff)

**Prereq:** Spec 063 Phase 1 Task 8 complete.

- [ ] **Step 1: Spin up a fresh copy of `_template-vite/` in a scratch dir**
  ```bash
  cp -r home/apps/_template-vite /tmp/test-app
  cd /tmp/test-app && pnpm install && pnpm build
  ls dist/  # expect index.html + assets
  ```
- [ ] **Step 2: Verify bridge hooks work end-to-end**
  - Open the built template in AppViewer (local dev)
  - Call `useKernel().sendMessage("hello")` → verify message lands in chat
  - Call `useData("test", "key")` → verify Postgres round-trip
  - Toggle theme → verify `useTheme()` value updates without reload
- [ ] **Step 3: Document any friction** in a scratch note. File issues against spec 063 if any hook is broken; block Wave 1 until fixed.
- [ ] **Step 4: Approve template for fanout** — mark the commit hash in this plan as the "template baseline" the Wave 2 agents will fork from.

---

### W1-T2: Build Mail (Reference Vite + Next.js App)

Mail is the quality bar. Every Wave 2 agent studies Mail before starting their own app. Mail is `runtime: "node"` (Next.js) because it needs server-side Pipedream OAuth callbacks and background sync workers. Prereq: 063 Phase 2 AND Phase 1 complete. If Phase 2 isn't ready yet, start with a Vite v0 (local fixture data) and upgrade to Next.js once Phase 2 lands.

**Files created:**
```
home/apps/mail/
  package.json             # Next.js 16 + @tanstack/react-query + react-markdown + dompurify
  next.config.ts           # basePath from MATRIX_APP_SLUG
  tsconfig.json
  matrix.json              # runtime: node, scope: personal, storage schema declared
  app/layout.tsx
  app/page.tsx             # inbox list
  app/message/[id]/page.tsx
  app/compose/page.tsx
  app/api/health/route.ts
  app/api/sync/route.ts    # triggers Pipedream sync
  app/api/oauth/callback/route.ts
  app/api/messages/route.ts
  lib/gmail-client.ts      # Pipedream wrapper with Zod validation
  lib/db.ts                # drizzle/kysely client for mail schema
  components/InboxList.tsx
  components/MessageView.tsx
  components/Composer.tsx
  components/EmptyInbox.tsx
```

**TDD order:**

- [ ] **Step 1: Write failing schema test** — `tests/apps/mail/db-schema.test.ts` — mail messages table has expected columns (from_address, subject, body_html, body_text, thread_id, labels[], received_at, is_read, is_starred), drizzle migration runs cleanly

- [ ] **Step 2: Implement schema** in matrix.json `storage.tables` + drizzle migration

- [ ] **Step 3: Write failing Pipedream wrapper test** — `tests/apps/mail/gmail-client.test.ts` — mock Pipedream API, validate response with Zod, reject malformed, `AbortSignal.timeout(10000)` set per CLAUDE.md

- [ ] **Step 4: Implement `lib/gmail-client.ts`**

- [ ] **Step 5: Write failing API route tests** — `tests/apps/mail/api-messages.test.ts` — list messages with pagination, mark read, archive, search; all writes in a transaction (multi-step writes per CLAUDE.md)

- [ ] **Step 6: Implement API routes**

- [ ] **Step 7: Write failing component tests** (Vitest + Testing Library) — InboxList renders messages, empty state shows "Connect Gmail" CTA, loading skeleton

- [ ] **Step 8: Implement UI** with react-query data fetching

- [ ] **Step 9: Write Playwright screenshot tests** — `tests/e2e/apps/mail.spec.ts` — 4 snapshots: loading, empty state, connected with fixtures, error state

- [ ] **Step 10: Manual smoke test**
  - Sign in locally
  - Connect Gmail via onboarding
  - Verify real messages load
  - Reply to a message
  - Confirm reply arrives in Gmail
- [ ] **Step 11: Design review with user** — Mail is the reference; user must approve the visual style, spacing, typography, empty states before Wave 2 agents start
- [ ] **Step 12: Commit per sub-step + final tag**
  ```
  git commit -m "feat(apps/mail): gmail client + zod validation"
  git commit -m "feat(apps/mail): api routes with transactions"
  git commit -m "feat(apps/mail): inbox list + message view"
  git commit -m "feat(apps/mail): compose + reply"
  git commit -m "test(apps/mail): screenshot suite"
  git tag mail-v1
  ```

**Acceptance criteria:**
- [ ] User connects Gmail, sees messages within 10s
- [ ] Reply round-trip verified against real Gmail
- [ ] Search returns results from local cache (no network hop)
- [ ] Inbox list uses react-virtuoso for >500 messages
- [ ] Error states: OAuth revoked → re-prompt, quota hit → toast, rate-limited → queued retry
- [ ] 4 Playwright snapshots approved
- [ ] Build time <10s warm, <60s cold
- [ ] Bundle size <500KB gzipped (excluding Next.js runtime)

---

### W1-T3: Onboarding Flow Update (spec 053 integration)

**Files touched:**
- `shell/src/components/onboarding/ConnectYourLife.tsx` — new component
- `shell/src/components/onboarding/OnboardingWindow.tsx` — add "Connect Your Life" step
- `shell/src/lib/pipedream-connect.ts` — thin wrapper around the existing integration
- `tests/shell/onboarding-connect.test.ts`
- `tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Write failing test** — onboarding window shows 3 cards (Gmail / GCal / Spotify), each has an OAuth button
- [ ] **Step 2: Red**
- [ ] **Step 3: Implement component** — 3-card layout, spinner on OAuth click, toast on success
- [ ] **Step 4: Wire up Pipedream Connect** using spec 049 primitives
- [ ] **Step 5: Write Playwright E2E test** — signup → connect Gmail → Mail shows messages (requires Mail to be installed and fixture OAuth server)
- [ ] **Step 6: Manual test end-to-end**
- [ ] **Step 7: Commit**
  ```
  git commit -m "feat(onboarding): add connect-your-life step with 3 integrations"
  git commit -m "test(e2e): onboarding to mail first-session flow"
  ```

**Acceptance criteria:**
- [ ] Onboarding completes within 60s from signup
- [ ] Each card shows its connected state after OAuth
- [ ] AI greets in chat within 5s of first connection ("I see you have N unread emails...")
- [ ] Skip button dismisses without state corruption
- [ ] Escape key dismisses (per ux-guide.md)

---

## Wave 2 — Parallel Vite App Fanout

This wave is embarrassingly parallel. 6-8 agents each own one app. Each follows the Per-App Build Playbook below. Agents do NOT share state and do NOT block on each other.

### Agent Team Dispatch

Use `TeamCreate` to spawn 6-8 agent teams, one per app. Each team brief:

```
You are building the {APP_NAME} default app for Matrix OS. Read:
- specs/060-default-apps/spec.md (section "{APP_NAME}")
- specs/060-default-apps/plan.md (Per-App Build Playbook)
- home/apps/mail/ (reference app — copy patterns)
- home/apps/_template-vite/ (scaffold starting point)

Your work directory is home/apps/{slug}/. You own everything in there.
Do NOT touch any other apps. Do NOT touch gateway/shell/packages code.
Commit after each logical step. Follow TDD.

Acceptance criteria are in the spec. Run the playbook.
```

### Wave 2 Assignments

| Agent Team | App | Runtime | Est. Days |
|---|---|---|---|
| `team-calendar` | Calendar | vite | 4 |
| `team-music` | Music | vite | 3 |
| `team-files` | Files | vite | 5 |
| `team-maps` | Maps | vite | 4 |
| `team-camera` | Camera | vite | 3 |
| `team-dashboard` | Dashboard | vite | 3 |
| `team-notes-migration` | Notes (migrate) | vite | 2 |
| `team-todo-migration` | Todo (migrate) | vite | 2 |

Additional migration agents if capacity allows: `team-expense`, `team-pomodoro`, `team-taskman`, `team-social`, `team-profile`, `team-weather`.

### Wave 2 Synchronization Points

- **Daily pulse** (automated, no user action): each agent commits progress at end of its working session; main collects all commits. No merge conflicts expected since each agent owns a distinct `home/apps/{slug}/` folder.
- **Mid-wave review** (day 4): user spot-checks 2-3 apps visually. If any diverges from Mail's quality bar, that agent gets a correction brief.
- **Wave 2 complete signal**: all 6-8 primary assignments passing Playwright screenshot tests and accepted by user.

---

## Wave 3 — Server Apps + Remaining Migrations

### W3-T1: Spec 063 Phase 2 Dependency

- [ ] **Block on**: spec 063 Phase 2 completion (node runtime)

### W3-T2: Inbox (Next.js)

Follow the same TDD structure as Mail (see W1-T2).

**Key additions beyond Mail:**
- Aggregates from multiple sources (Mail schema, Matrix DM events, kernel notifications)
- Background job via Next.js instrumentation API to poll sources
- Filter chips by source
- Virtualized list via `react-virtuoso`

- [ ] Scaffold from `_template-next`
- [ ] Write schema test + implement unified `inbox_items` table
- [ ] Write aggregator test + implement (reads from mail schema, Matrix events, kernel notifications)
- [ ] Write API route tests + implement
- [ ] Write UI component tests + implement
- [ ] Write Playwright screenshot tests
- [ ] Manual smoke test
- [ ] Commit per step

### W3-T3: Reader (Next.js)

- [ ] Scaffold from `_template-next`
- [ ] Schema: `feeds`, `items`, `bookmarks`, `sync_state`
- [ ] Implement RSS parser wrapper (`rss-parser` with Zod validation)
- [ ] Implement background polling via Next.js instrumentation (every 30 min per feed)
- [ ] Implement full-text search (Postgres `tsvector`)
- [ ] Implement Readability extraction for article view
- [ ] UI: feed list, article view with pagination
- [ ] Playwright screenshots
- [ ] Commit per step

### W3-T4: Remaining Migrations

If any of the 8 existing-app migrations weren't done in Wave 2, catch them up here. Each follows the Per-App Build Playbook in migration mode (import existing data from the Postgres app data schema instead of seeding fresh).

### W3-T5: Playwright Visual Regression Baseline

- [ ] Run full screenshot suite against all 17 apps
- [ ] Commit baselines to `tests/e2e/apps/__screenshots__/`
- [ ] Wire into CI: `bun run test:e2e:apps` fails on diff

### W3-T6: Quality Gate Review

- [ ] User reviews all 17 apps in Docker (not local dev)
- [ ] Any app that feels off quality bar gets a polish PR
- [ ] Accept or reject per app with feedback

### W3-T7: Waitlist Launch Readiness

- [ ] All apps show up in the App Launcher sidebar
- [ ] Onboarding flow exercises Gmail + GCal + Spotify
- [ ] First-session PostHog event fires with app connect count
- [ ] Day-1 return event wired
- [ ] Announce waitlist launch

---

## Per-App Build Playbook

Every Wave 2 / Wave 3 agent follows this playbook for their assigned app. This is the standard process.

### Step 0: Prep

- [ ] Read `specs/060-default-apps/spec.md` — find your app's section
- [ ] Read `home/apps/mail/` — study patterns: react-query usage, error states, design tokens, bridge hooks
- [ ] Read `specs/ux-guide.md` — layout-shift rules, toggle consistency, progressive disclosure

### Step 1: Scaffold

- [ ] `cp -r home/apps/_template-vite home/apps/{slug}` (or `_template-next` for node runtime)
- [ ] Edit `matrix.json`: set name, slug, description, icon, category, runtimeVersion, declare `storage.tables` if app needs Postgres, set `scope: "personal"`
- [ ] `cd home/apps/{slug} && pnpm install && pnpm build` — verify template still builds cleanly
- [ ] Commit: `chore(apps/{slug}): scaffold from template`

### Step 2: Data Layer (TDD)

- [ ] Write failing test: `tests/apps/{slug}/schema.test.ts` — declared tables exist, columns match spec, migrations run
- [ ] Run (red)
- [ ] Implement schema in `matrix.json` + drizzle/kysely migration
- [ ] Run (green)
- [ ] Commit: `feat(apps/{slug}): add db schema`

### Step 3: External Integration (if applicable)

- [ ] Write failing test: `tests/apps/{slug}/{provider}-client.test.ts` — Pipedream wrapper validates responses with Zod, rejects malformed, applies `AbortSignal.timeout(10000)`, returns typed `Result<T, IntegrationError>`
- [ ] Run (red)
- [ ] Implement `lib/{provider}-client.ts`
- [ ] Run (green)
- [ ] Commit: `feat(apps/{slug}): add {provider} integration`

### Step 4: API Routes / Background Jobs (Next.js apps only)

- [ ] Write failing test: `tests/apps/{slug}/api-*.test.ts` — each route covers happy path + auth rejection + validation rejection + transaction atomicity (multi-step writes per CLAUDE.md)
- [ ] Run (red)
- [ ] Implement routes
- [ ] Run (green)
- [ ] Commit: `feat(apps/{slug}): api routes`

### Step 5: UI Components (TDD)

- [ ] Write failing component tests (Vitest + Testing Library)
  - Default state renders
  - Empty state shows CTA
  - Loading skeleton
  - Error state shows user-friendly message
- [ ] Run (red)
- [ ] Implement components using `matrix-os/client` design system
- [ ] Run (green)
- [ ] Commit: `feat(apps/{slug}): ui components`

### Step 6: State Management

- [ ] Use `@tanstack/react-query` for server state
- [ ] Use local `useState` or Zustand for ephemeral UI state
- [ ] Wire `useData` hook from `matrix-os/client` for Postgres reads
- [ ] Wire `useKernel` hook for AI interactions
- [ ] Commit: `feat(apps/{slug}): state management`

### Step 7: Screenshot Tests

- [ ] Write `tests/e2e/apps/{slug}.spec.ts` with 4 snapshots:
  1. Default/connected state with fixture data
  2. Empty state (no data yet)
  3. Loading state
  4. Error state (integration failure)
- [ ] Run once to create baselines
- [ ] Commit: `test(apps/{slug}): screenshot suite`

### Step 8: Manual Smoke Test

- [ ] Run the app in the shell (Docker, not just local dev per CLAUDE.md)
- [ ] Test golden path end-to-end
- [ ] Test each acceptance criterion from the spec
- [ ] Verify performance budget: build <10s warm, bundle <500KB gzipped
- [ ] Commit any fixes

### Step 9: Final Commit + Handoff

- [ ] Update app registry / launcher if needed
- [ ] Verify the app appears in the launcher in Docker
- [ ] Final commit: `feat(apps/{slug}): v1 ready for review`
- [ ] Notify user for design review

---

## Shared Component Library Tasks

These are prerequisites for Wave 2 and owned by the spec 063 runtime work, but listed here for visibility. They must land BEFORE Wave 2 agents start.

### SCL-1: Design Tokens in `matrix-os/client`

- [ ] Export CSS variables: `--color-terracotta`, `--color-parchment`, `--color-lavender`, `--color-card`, `--font-sans`, `--font-mono`, spacing scale
- [ ] Tailwind config snippet importable by apps
- [ ] Dark mode tokens

### SCL-2: Core Components

- [ ] `<Button variant="primary|secondary|ghost" size="sm|md|lg">`
- [ ] `<Card>`, `<CardHeader>`, `<CardBody>`, `<CardFooter>`
- [ ] `<Input>`, `<Textarea>`, `<Select>`, `<Checkbox>`, `<Switch>`
- [ ] `<Dialog>`, `<Sheet>` (Radix UI under the hood)
- [ ] `<Toast>` with context provider
- [ ] `<List>`, `<ListItem>`, `<Avatar>`, `<Badge>`, `<Tabs>`
- [ ] `<EmptyState>` (icon + headline + description + CTA pattern)
- [ ] `<Skeleton>` loading shimmer

### SCL-3: Hooks

- [ ] `useKernel()` — send messages, receive AI responses
- [ ] `useData(appSlug, key)` — Postgres CRUD via bridge
- [ ] `useFile(path)` — filesystem read/write via bridge
- [ ] `useTheme()` — current theme vars, live updates
- [ ] `usePipedream(integration)` — OAuth state + API calls
- [ ] `useAppOpen()` — open another app by slug
- [ ] `useNotification()` — kernel notification dispatch

### SCL-4: TypeScript Types

- [ ] `src/matrix-os.d.ts` declares all hooks + components for autocomplete in apps
- [ ] Published as `matrix-os/client` via import map in Vite template

### SCL-5: Documentation

- [ ] `home/agents/skills/matrix-os-client.md` — reference docs for AI agents building apps

---

## Testing Strategy

### Per-app tests (each agent owns)

- **Unit**: schema validation, client libraries (Pipedream wrappers), pure utility functions
- **Component**: Vitest + Testing Library, covers default/loading/empty/error states
- **Integration**: API routes (for Next.js apps) with an in-memory Postgres fixture

### Cross-app tests (shared, live in `tests/e2e/apps/`)

- **Screenshot regression**: 68 baseline snapshots (17 apps × 4 states)
- **Onboarding flow**: signup → connect Gmail → Mail shows messages
- **Bridge integration**: each app's `useKernel`/`useData`/`useTheme` verified against a stub shell

### Performance budgets (enforced in CI)

| Metric | Budget | Failure mode |
|---|---|---|
| Vite bundle size (gzipped) | <500 KB | CI fails |
| Vite cold build | <60 s | CI warns, fails at 120 s |
| Vite warm build | <10 s | CI warns |
| Next.js build | <120 s | CI warns, fails at 240 s |
| Next.js cold start | <3 s | CI warns |
| First-session onboarding E2E | <60 s from signup to Mail visible | CI fails |

---

## Onboarding Flow Detailed Tasks

### OF-1: UI Component

- [ ] `shell/src/components/onboarding/ConnectYourLife.tsx` — three-card layout, one per integration
- [ ] Each card: icon, name, description, OAuth button, status pill (Not connected / Connecting... / Connected)
- [ ] Skip button
- [ ] Success toast on connect

### OF-2: OAuth Flow Integration

- [ ] Use spec 049 Pipedream Connect primitives
- [ ] Handle OAuth popup/redirect dance
- [ ] On success: fire PostHog event `onboarding_integration_connected`
- [ ] On failure: show inline error with "Try again" button

### OF-3: Post-Connect Data Preview

- [ ] On Gmail connect: kick off first sync of last 50 messages
- [ ] Show "Loading your emails..." spinner in Mail app tile
- [ ] When sync completes (within 10s target): bounce Mail icon, show toast "You have N unread emails"

### OF-4: AI Greeting

- [ ] On first connect: send a kernel message
  ```
  User just connected {integration}. They have {N} {items}.
  Greet them and offer 2-3 actions they can take.
  ```
- [ ] AI response streams into chat automatically

### OF-5: PostHog Events

- [ ] `onboarding_started`
- [ ] `onboarding_integration_connected` (per integration)
- [ ] `onboarding_skipped`
- [ ] `first_app_opened` (per app)
- [ ] `first_session_complete` (after 5 min active)

### OF-6: Acceptance Test

- [ ] Playwright E2E: signup → connect Gmail (with mocked Pipedream fixture) → verify Mail app loads with messages
- [ ] Timer assertion: entire flow under 60s

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Spec 063 Phase 1 slips | Wave 2 blocks entirely | Start Mail as Vite v0 with local fixtures; upgrade to Next.js when Phase 2 lands |
| Mail quality bar too high, other agents can't match | Inconsistent UX | User-led design review of Mail before fanout; agents must show their Mail-equivalent screenshots before proceeding |
| Pipedream quota / rate limits during testing | Dev friction | Mock Pipedream responses in tests; use dedicated test account for manual smoke |
| Multiple agents commit conflicting `home/apps/index.ts` registry | Merge conflicts | Auto-register apps by directory scan, not static registry |
| Screenshot tests flaky due to font loading | False CI failures | Wait for `document.fonts.ready` before capture |
| Agents drift from design tokens | Visual inconsistency | Ban hardcoded colors/spacings in apps; enforce via lint rule |
| OAuth popup blocked in iframe | Onboarding broken | Open OAuth in top-level window, not iframe; handle postMessage back |
| First build of 17 apps kills CI | CI timeout | Run builds in parallel workers; cache pnpm store across runs |
| Next.js `basePath` breaks asset loading | Broken app | Template generates `next.config.ts` wrapper; covered in 063 Phase 2 |
| Background sync jobs run forever | Resource leak | Cap sync duration, idle shutdown via spec 063 process manager |

---

## Done Criteria

- [ ] 17 apps shipped: 8 migrated + 9 new, all committed to main
- [ ] Mail, Calendar, Music connected to Pipedream and verified against real provider accounts
- [ ] Onboarding flow E2E passing in CI
- [ ] 68 screenshot baselines committed to repo
- [ ] All apps pass performance budget in CI
- [ ] User design review: all 17 apps accepted
- [ ] PostHog events firing for onboarding + first-session
- [ ] Waitlist invite template drafted
- [ ] CLAUDE.md Active Technologies section updated
- [ ] `/update-docs` run
- [ ] Spec 060 marked "ready for launch" in `specs/` index

---

## Orchestration Commands

### Start Wave 2 (example)

```bash
# After spec 063 Phase 1 lands on main:
# User opens a new Claude Code session and runs:
/brainstorm Start Wave 2 of spec 060. Use TeamCreate to spawn 6 agent
teams in parallel, one per app: team-calendar, team-music, team-files,
team-maps, team-camera, team-dashboard. Each team gets the brief in
specs/060-default-apps/plan.md (Agent Team Dispatch section) and
follows the Per-App Build Playbook. Agents work on main, commit after
each step, never use worktree isolation, never call TeamDelete.
```

### Monitor Wave 2 progress

```bash
git log --oneline --since="1 day" home/apps/  # see recent commits per app
git status home/apps/  # any uncommitted work?
```

### Wave 2 acceptance checkpoint

For each app:
```bash
cd home/apps/{slug}
pnpm install && pnpm build
# open shell in Docker, verify the app visually
bun run test tests/apps/{slug}
bun run test:e2e tests/e2e/apps/{slug}.spec.ts
```

---

## Related Specs

- **063** React App Runtime — foundation
- **049** Platform Integrations — Pipedream Connect
- **050** App Data Layer — per-app Postgres
- **053** Onboarding — needs the Connect Your Life step
- **062** Shared Apps — future; `scope: "personal"` declared now for forward compat
- **038** App Platform — originating context
