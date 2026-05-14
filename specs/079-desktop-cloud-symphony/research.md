# Research: Desktop Cloud Symphony

## Decision: Use a thin Electron desktop shell around Matrix shell

**Rationale**: Matrix already has a first-class web shell, app launcher, Canvas/Desktop mode, built-in apps, and workspace views. A thin native shell gets native distribution, windowing, deep links, and secure external navigation without creating a second UI platform.

**Alternatives considered**:

- Copy Slay Zone's Electron renderer wholesale: rejected because it would fork product state and duplicate a local app database.
- Build a new desktop UI separate from shell: rejected because it would violate headless-core/multi-shell reuse and slow parity.
- PWA only: rejected because the request is specifically for a desktop app and Slay-like native command-center workflows.

## Decision: Workflow parity, not storage/runtime parity, with Slay Zone

**Rationale**: The desired experience should feel like Slay Zone for tasks, tabs, agent status, artifacts, previews, automations, and settings. Matrix must still use owner-controlled Postgres, Matrix shell, and cloud runtime instead of Slay Zone's local SQLite/local PTY/local agent assumptions.

**Alternatives considered**:

- Import Slay Zone persistence model: rejected by Matrix's Postgres/Kysely rule.
- Reuse only Slay Zone UI ideas manually: accepted as product reference, with implementation adapted to Matrix boundaries.

## Decision: Cloud-only coding-agent execution is enforced in desktop and gateway

**Rationale**: The user explicitly wants coding agents only in the cloud. Enforcing this only in UI would be insufficient; the preload bridge must not expose local start APIs and gateway routes must reject local runtime modes.

**Alternatives considered**:

- Allow local fallback when cloud unavailable: rejected because it violates cloud-only policy and changes trust/resource boundaries.
- Hide local mode only in UI: rejected because routes/IPC could still be called directly.

## Decision: Matrix-native tickets share one tracked-ticket model with Linear tickets

**Rationale**: Users need one Slay-like board/workbench for Linear and internal work. A shared model with source attribution gives deduplication, unified assignment, and consistent artifacts/history without losing external sync identity.

**Alternatives considered**:

- Separate Linear board and internal board: rejected because assignment and agent status would fragment.
- Store only external IDs and fetch live every time: rejected because offline/restart/reconciliation and Matrix ownership require durable local state.

## Decision: Symphony remains the single assignment runner

**Rationale**: Matrix Symphony already owns the ticket-to-worktree-to-agent loop. Extending it to accept normalized internal tickets avoids a second automation engine and keeps duplicate claim prevention in one place.

**Alternatives considered**:

- Desktop directly starts agents from ticket actions: rejected because it violates cloud-only and headless-core principles.
- Build a separate Slay-style dispatcher: rejected because Matrix already has Symphony and workspace/session primitives.

## Decision: Use realtime events with polling fallback

**Rationale**: Agent/ticket status must feel live in desktop, but desktop connectivity is less reliable than an in-browser local app. A bounded event stream plus revision-based polling fallback handles reconnects and restart recovery.

**Alternatives considered**:

- Polling only: rejected because Symphony/agent status would feel stale.
- WebSocket only: rejected because transient desktop sleep/reconnect behavior needs robust fallback.

## Decision: Add repository workflow and Codex readiness as first-class setup

**Rationale**: Symphony needs enough project context to set up a worktree, run live/dev commands, validate work, expose previews, and know whether Codex can run in the cloud runtime. Treating workflow setup and Codex readiness as explicit setup avoids silent agent loops and makes per-project dispatch predictable.

**Alternatives considered**:

- Let every ticket prompt rediscover setup from scratch: rejected because repeated discovery is slow and unreliable.
- Store Codex auth in the desktop app: rejected because agents run in cloud and secrets must stay server-side.

## Decision: Plan shared boards as a later stack layer

**Rationale**: The user wants future team workflows where shared Linear or Matrix boards can assign tickets to different users and their own Symphony runners. This requires authorization, membership, and per-runner claim policy, so it belongs after the personal desktop/Symphony foundation.

**Alternatives considered**:

- Make every board shared from day one: rejected because it would increase MVP scope and risk.
- Leave team boards out of the spec: rejected because it changes data model and route authorization decisions now.

## Decision: Adapt Slay Zone's desktop release workflow

**Rationale**: Slay Zone already has a mature pattern for Electron release: dry-run/publish modes, multi-platform builds, signing/notarization, release manifests/checksums, GitHub releases, Homebrew cask updates, and notifications. Matrix Desktop should copy the release shape while replacing brand, package, secrets, and Matrix-specific release channels.

**Alternatives considered**:

- Manual local packaging: rejected because signing/notarization and repeatable releases need CI.
- Defer release automation: rejected because desktop distribution decisions affect package metadata and signing entitlements early.
