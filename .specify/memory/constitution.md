<!--
Sync Impact Report
- Version change: 2.4.0 → 2.5.0
- Modified principles:
  - I. Data Belongs to Its Owner: added explicit revocable delegation without ownership transfer.
  - VII. Multi-Tenancy: clarified creator-hosted live app sharing for every current org member.
  - VIII. Defense in Depth: scoped org-admin control to org-owned apps and preserved live-share audit.
- Added sections: none.
- Removed sections: none.
- Templates reviewed:
  - ✅ .specify/templates/plan-template.md
  - ✅ .specify/templates/spec-template.md
  - ✅ .specify/templates/tasks-template.md
  - ✅ .specify/templates/constitution-template.md
  - ✅ .specify/templates/agent-file-template.md
  - ✅ .specify/templates/checklist-template.md
- Runtime guidance reviewed: ✅ AGENTS.md, ✅ README.md, ✅ docs/ (no conflicting wording found).
- Follow-up TODOs: none.
-->
# Matrix OS Constitution

## Core Principles

### I. Data Belongs to Its Owner (NON-NEGOTIABLE)

Every piece of data has a clear owner -- never the platform. Owners can inspect, export, delete, and take their data with them. No vendor lock-in, no opaque systems, no data that exists only in the platform's control.

**Ownership scopes**:
- **Personal**: belongs to the individual user. It is private by default and fully portable. The owner MAY explicitly delegate revocable use of a specific owner-controlled app and its data to an organization without transferring ownership, copying the data into organization storage, or creating a second app permission system.
- **Org**: belongs to the organization. Admins control access, members use it. Survives employee departure.
- **Shared**: co-owned by collaborators (e.g., a shared project board). All collaborators have access. Ownership transfers are explicit.
- **Published**: creator retains IP, installers own their instance data (e.g., app store apps).

**Identity and configuration are files** -- inspectable, version-controlled, copyable:
- Apps are files in `~/apps/` or codebases in `~/projects/`
- OS state is files in `~/system/`
- Agent identity is `~/system/soul.md`
- Agent definitions are markdown files in `~/agents/custom/`
- Skills are markdown files in `~/agents/skills/`
- Channel config is in `~/system/config.json`
- Cron jobs are in `~/system/cron.json`

**App data lives in the owner's database** -- queryable, relational, performant:
- Personal: user's own PostgreSQL database (isolated, exportable)
- Org: org-level database with schema-per-app isolation and RBAC
- Social posts, messages, todos, and app state live in Postgres for UX (feeds, search, cross-app queries)

**Ownership guarantees**:
- Export: full data dump at any time, any scope
- Delete: owner can erase everything in their scope
- Portability: no data lives outside the owner's control
- Delegated access: the owner remains the sole owner, may stop sharing without deleting records, and never delegates credentials, connected providers, AI spending authority, export rights, or deletion rights merely by sharing an app
- Separation: personal data never merges with org data -- explicit delegated use remains owner-controlled, and leaving an org ends delegated access without taking or deleting the owner's records

### II. AI Is the Kernel

AI is not a feature bolted onto the OS -- it IS the OS kernel. The kernel dispatches to the best available model for each task. Every user interaction flows through the kernel. The kernel makes routing decisions, spawns sub-agents, and manages all state. No separate "backend logic" -- the kernel's reasoning IS the logic.

- Model-agnostic: Claude today, any model tomorrow. The kernel abstracts the provider.
- Smart routing: simple requests go to fast/cheap models, complex work goes to frontier models
- Sub-agents are processes with isolated context windows
- Custom agents are markdown files the kernel discovers and spawns
- The agent pool is self-expanding (kernel creates new agents by writing files)
- Current implementation: Claude Agent SDK V1 `query()` with `resume`

### III. Headless Core, Multi-Shell

The core (kernel + database + agents) works without any UI. Shells are renderers that connect to the same kernel. Never couple core logic to a specific renderer. The shell discovers apps -- it doesn't know what exists ahead of time.

**First-class shells** (native experience, full feature parity):
- Desktop: web app (browser or PWA) -- the flagship visual experience
- Mobile: native or PWA -- the primary way most users interact daily

**Channel shells** (conversational access, subset of features):
- Telegram/WhatsApp/Discord/Slack: text-based interaction through messaging
- Voice: phone calls, voice assistants
- API: programmatic access for developers and integrations

**System shells**:
- Heartbeat: proactive interaction (OS reaches out on schedule)
- CLI: power-user and developer access

All shells route through the same gateway -> dispatcher -> kernel pipeline. Offline support is a goal: shells should degrade gracefully when connectivity is intermittent.

### IV. Self-Healing and Self-Expanding

The OS detects failures, diagnoses root causes, and patches itself. The OS creates new capabilities by writing new agent files, knowledge files, and tools. Safety nets are mandatory: git snapshots before mutations, backup before patching, rollback on test failure, protected files list, watchdog process.

### V. Quality Over Shortcuts

Build for the best possible user experience. No throwaway prototypes, no "good enough" HTML pages, no cutting corners on polish. Users deserve production-grade quality from day one.

- Apps are Vite + React -- no bare HTML/CDN hacks
- Every abstraction must justify its existence, but don't avoid complexity when it serves the user
- Ship fewer things, but ship them well

### VI. App Ecosystem

Matrix OS is a platform for building, sharing, and running apps. Users create apps with AI assistance. The app store is how the ecosystem grows.

- **App packaging**: apps are self-contained projects (Vite + React) with a manifest (`matrix.json`) declaring permissions, dependencies, and data schemas
- **App permissions**: installed apps declare what they need (file access, network, other apps' data, notifications). Users grant permissions explicitly. Untrusted apps are sandboxed -- they cannot access `~/system/`, `~/agents/`, or other apps' data without permission.
- **App trust levels**:
  - Self-built: full access (the user made it, they trust it)
  - From a contact: permissions prompt on install
  - App store: reviewed, signed, permissions enforced
  - Org-mandated: admin-installed, org-level permissions
- **App store**: users publish apps for others to discover and install. Creator retains IP. Installers own their instance data. Free and paid apps supported.
- **App sharing**: send an app to a friend, share a link, or publish to the store. Installing = copying the app into `~/apps/` and provisioning its database schema.

### VII. Multi-Tenancy: Personal and Org OS

Matrix OS serves individuals and organizations. An org is a group of users with shared apps, data, and administration.

- **Personal OS**: one user, their data, their apps, their agent. The default.
- **Org OS**: a company or team provisions Matrix OS for members. Shared apps, shared data, centralized admin.
- **RBAC**: orgs have roles (owner, admin, member, guest) with scoped permissions for organization-owned resources. Creator-hosted live app sharing is an explicit exception: any current organization member, including a guest, MAY share an app they own with that organization, and every current member receives the app's full declared functionality while the share is active. This uses current organization membership only; it MUST NOT create per-app roles, grants, invitations, acceptance records, or an additional permission system.
- **Shared workspaces**: org members collaborate on shared apps and data. Changes are visible to all members with access.
- **Org apps**: admins deploy organization-owned apps to all members. Members can't uninstall org-mandated apps but can add personal apps alongside them. A creator-hosted live share remains owner-owned and is not an org-mandated app.
- **Boundary**: personal data and org data are strictly separated. Leaving an org removes access to org data but personal data is untouched.

## Technology Constraints

- **Language**: TypeScript, strict mode, ES modules
- **Runtime**: Node.js 24+
- **AI Kernel**: Model-agnostic (current: Claude Agent SDK V1 `query()` with `resume` + Opus 4.6)
- **Frontend**: React + Nextjs
- **Database**: PostgreSQL via Kysely for platform, kernel durable state, per-user databases, app data, social data, and control-plane registries. SQLite, Drizzle ORM, and better-sqlite3 are not permitted for new Matrix OS persistence; migrate legacy references to Postgres/Kysely.
- **Web Server**: Hono (lightweight, WebSocket support, channel adapters)
- **Channels**: node-telegram-bot-api (Telegram), @whiskeysockets/baileys (WhatsApp), discord.js (Discord), @slack/bolt (Slack)
- **Scheduling**: node-cron (cron expressions), native timers (intervals, one-shot)
- **Bundler**: Nextjs (frontend) + tsx (backend dev)
- **Validation**: Zod 4 for schema validation
- **Testing**: Vitest for unit/integration tests, TDD workflow, 99-100% coverage target
- **Package Manager**: pnpm (install), bun (run scripts)
- **Context Window**: 200K standard, 1M beta (`betas: ["context-1m-2025-08-07"]`, tier 4+)
- **Prompt Caching**: `cache_control: {type: "ephemeral"}` on tools + system prompt for 90% input cost savings on subsequent turns
- **Compaction**: Server-side compaction API for long kernel sessions
- **User Apps**: Vite + React (generated apps are real projects, not HTML snippets)
- **Isolation**: Container-per-user (current implementation -- will evolve to shared infrastructure with tenant isolation at scale)
- No external dependencies when native Node.js APIs suffice

### VIII. Defense in Depth (NON-NEGOTIABLE)

Every new endpoint, WebSocket, and webhook requires explicit auth design before implementation. Security is not a follow-up -- it is part of the spec.

**Endpoint security**:
- **Auth matrix in specs**: every spec with endpoints must include a table of routes, their auth method, and which are public
- **Input validation at every boundary**: user input, webhook payloads, file paths, filenames, IPC tool params -- validate and sanitize at the point of entry
- **Never trust user-controlled headers** for security decisions (X-Forwarded-*, Host, etc.)
- **Never expose internal errors** to clients -- generic messages to users, detailed logs server-side
- **Atomic file writes** for persistent state (write to tmp, rename)
- **Resource limits on all buffers** and in-memory collections -- cap sizes, clean up on eviction
- **Timeouts on all external calls** -- fetch, dispatch, provider APIs. No unbounded waits.
- **Constant-time comparison** for all secret/token/signature checks (timingSafeEqual)
- **Integration wiring verification**: every spec must describe how components connect at runtime and include an integration test that exercises the full path end-to-end

**App sandboxing**:
- Installed apps run in restricted scope -- no access to system files, other apps' data, or kernel internals without explicit permission
- App permissions are declared in `matrix.json` and granted by the user or org admin
- Self-built apps get full access; app-store apps are sandboxed by default

**Org and access control**:
- RBAC for org-owned resources: owner > admin > member > guest
- Org admins control organization-owned apps and data. An owner-controlled live app share follows the explicit membership-derived exception in Principle VII: any current member may share their own app, and all current members receive full app use without a second permission system.
- Creator-hosted live share creation, stop, readiness, membership denial, and app mutations MUST remain auditable even though they do not use per-app grants.
- Audit logs for security-sensitive actions (permission changes, data exports, admin operations)

**Compliance**:
- Data residency: user/org data stays in the region they choose
- GDPR: right to export, right to delete, data processing transparency
- Content moderation: social features and app store require abuse prevention

## Development Workflow



### IX. Test-Driven Development (NON-NEGOTIABLE)

The OS is complex and self-modifying. TDD is mandatory to prevent regressions as the system evolves.

- **Tests first**: Write failing tests before implementation. Red -> Green -> Refactor.
- **Vitest** for all kernel and gateway tests (unit + integration)
- **Spike before spec**: When SDK behavior is undocumented, write a spike test against the real SDK before committing to an approach (as done for V1 vs V2 decision)
- **Test categories**:
  - **Unit tests**: Pure functions (prompt assembly, schema validation, frontmatter parsing)
  - **Integration tests**: SDK interactions (MCP tool calls, agent spawning, multi-turn resume, hooks)
  - **Contract tests**: IPC tool inputs/outputs match expected schemas
- **Test isolation**: Integration tests use haiku model to keep costs under $0.10 per suite run
- **Coverage target**: 99-100% for kernel and gateway packages. Measure with `vitest --coverage`.
- **No implementation without a failing test**: If a test can't be written for it, question whether it's needed
- **Effectiveness**: Follow `docs/dev/testing-effectiveness.md`. Tests must exercise production behavior and detect a named fault. Regression tests must fail with the original fault and pass with the fix; fixture/setup failures do not establish regression protection. Coverage and test counts alone do not establish a working user journey.
- **Boundary fidelity**: Keep the producer/consumer, database, runtime, or surface boundary responsible for a failure real. Required integration/E2E lanes must fail on missing prerequisites, empty collection, or skipped required assertions. Remove tests only with evidence of no production protection or equivalent retained coverage.

### X. Worktree, PR, and Greptile 5/5 (NON-NEGOTIABLE)

Every change to Matrix OS — code, docs, specs, configuration — ships via pull request from a **manual git worktree**. Direct commits to `main` are prohibited.

- **Manual worktree, always**: start with `git worktree add -b <kebab-branch> ../<dir-name> origin/main`. Do all work in the worktree. This is distinct from the banned Agent-tool `isolation: "worktree"` parameter, which discards uncommitted changes; manual worktrees are persistent and safe.
- **PR required**: open via `gh pr create` with a Conventional Commit title and the mandatory invariants section (source of truth, lock/transaction scope, acceptable orphan states, auth source of truth, deferred scope).
- **Greptile 5/5 before merge**: every finding must be fixed in the diff or explicitly deferred in the PR body with a linked follow-up issue. No exceptions, including docs-only PRs. The only acceptable bypass is when CI is itself broken in a way that prevents Greptile from running — in which case flag it to the human owner and do not merge.
- **Constitution re-read every session**: re-read this file at the start of every session and after compaction. The CLAUDE.md / AGENTS.md files point here as the source of truth; do not rely on memory.

This principle exists because PR review discipline plus an automated quality floor (Greptile) is the only scalable way to keep ~317-PR-review-comment defect classes from re-entering the codebase as the team scales. It also makes the same workflow available to every external developer using Matrix OS once we expose it.

### Other Workflow Rules

- Verify every SDK assumption against actual docs before implementing
- Test against real Agent SDK behavior, not just docs (docs may be incomplete)
- Commit working increments -- each phase should produce a demoable state
- Keep the system prompt under 7K tokens (3% of context budget)
- **Documentation-driven development**: every new feature, spec, or plan must include a step to update the public docs in the private `FinnaAI/matrix-os-site` repository under `content/docs/`. The docs site (matrix-os.com/docs, built with Fumadocs) is the canonical public reference. When planning a task or writing a spec, include a separate site-repository documentation PR as an explicit deliverable alongside tests and implementation.

## Governance

This constitution supersedes all other development practices for Matrix OS. Amendments require updating this file with rationale. If a principle conflicts with implementation reality (e.g., SDK limitation), document the deviation in SDK-VERIFICATION.md and propose the simplest workaround.

**Version**: 2.5.0 | **Ratified**: 2026-02-11 | **Last Amended**: 2026-11-05

### Amendment Log

- **2.5.0** (2026-11-05): Added explicit owner-retained delegated access for creator-hosted live apps. Personal app data remains in the owner's PostgreSQL database and never becomes organization-owned or platform-owned. Any current organization member, including a guest, may share an app they own with the organization; every current member receives full app functionality through existing organization membership, with no per-app roles, grants, invitations, acceptance flow, or second permission system. Sharing never delegates owner credentials, connected providers, AI spending authority, export rights, or deletion rights.

- **2.4.0** (2026-10-25): Added test-effectiveness and boundary-fidelity requirements to TDD. The suite audit found tests exercising local replicas and fixtures accepting invalid production messages; require named fault detection, regression red/green evidence, real failing boundaries, and non-skipping qualification. Existing coverage targets remain unchanged. Canonical guidance: `docs/dev/testing-effectiveness.md`.

- **1.1.0** (2026-02-11): Added TDD principle (VI). Changed AI Kernel from V2 to V1 `query()` with `resume` based on spike testing. Added Vitest, pnpm/bun to tech constraints.
- **1.2.0** (2026-02-11): Added prompt caching strategy (90% input cost savings), 1M context window beta, compaction API, 99-100% test coverage target.
- **1.3.0** (2026-02-12): Expanded vision to include personal AI assistant capabilities. Added: SOUL identity (`soul.md`), skills system (`agents/skills/`), multi-channel messaging (Telegram, WhatsApp, Discord, Slack), cron scheduling, proactive heartbeat, cloud deployment. Expanded Principle III with channel shells. Added channel/scheduling tech constraints. Inspired by OpenClaw/Moltbot and Nanobot (both MIT, open source). Matrix OS is now both a visual OS and a personal AI assistant.
- **1.4.0** (2026-02-25): Added documentation-driven development rule. Every feature, spec, and plan must include public docs updates at `www/content/docs/` (Fumadocs site at matrix-os.com/docs) as an explicit deliverable.
- **1.5.0** (2026-03-24): Added Defense in Depth principle (VII). Renumbered TDD to VIII. Every spec with endpoints must include auth matrix, input validation plan, resource limits, timeout policies, and integration wiring verification. Motivated by PR #17 (voice system) where 55+ review findings traced back to missing security architecture and integration wiring in the spec. Also added: atomic file writes, constant-time secret comparison, never expose internal errors, never trust forwarded headers.
- **2.0.0** (2026-04-03): Platform-scale rewrite. Vision: Matrix OS as the default OS for personal and professional use, with app store and org support. Changes:
  - **Principle I**: "Everything Is a File" -> "Data Belongs to Its Owner" with ownership scopes (personal, org, shared, published). Postgres is primary, files for config/identity only.
  - **Principle II**: "Agent Is the Kernel" -> "AI Is the Kernel" -- model-agnostic, smart routing across providers.
  - **Principle III**: Mobile and desktop elevated to first-class shells with full feature parity. Added offline support goal.
  - **Principle V**: "Simplicity Over Sophistication" -> "Quality Over Shortcuts" -- Vite+React apps, no bare HTML, production-grade from day one.
  - **NEW Principle VI**: App Ecosystem -- app packaging, permissions, trust levels, app store, sharing.
  - **NEW Principle VII**: Multi-Tenancy -- personal OS, org OS, RBAC, shared workspaces, strict personal/org boundary.
  - **Principle VIII** (was VII): Defense in Depth expanded with app sandboxing, org access control (RBAC, audit logs), and compliance (GDPR, data residency, content moderation).
  - **Principle IX** (was VIII): TDD renumbered.
  - **Tech constraints**: AI kernel marked model-agnostic, container-per-user flagged as current implementation (not principle), Postgres selected as the standard persistence layer.
- **2.1.0** (2026-04-27): Database standard hardened. PostgreSQL via Kysely is the required persistence layer for platform, kernel durable state, per-user, app, social, and control-plane data. SQLite, Drizzle ORM, and better-sqlite3 are no longer accepted for new Matrix OS persistence.
- **2.3.0** (2026-07-19): Moved the public website and Fumadocs source of truth from the monorepo's `www/` workspace to the private `FinnaAI/matrix-os-site` repository. Documentation-driven development now requires a separate PR in that repository instead of recreating or editing a local `www/` tree.
- **2.2.0** (2026-05-27): Added Principle X — Worktree, PR, and Greptile 5/5 (NON-NEGOTIABLE). Codifies the canonical compound-engineering loop: manual `git worktree` + PR + Greptile 5/5 gate. Constitution must be re-read at the start of every session. Distinguished required manual `git worktree` from the banned Agent-tool `isolation: "worktree"` parameter. Motivated by positioning developers as the first ICP and the need for a scalable review discipline as the team and external developer community grow.
