# Feature Specification: Codebase Domain Structure & Documentation Discipline

**Feature Branch**: `093-codebase-domain-structure`
**Created**: 2026-06-15
**Verified against**: `origin/main` @ `c6efa3f8` on 2026-06-16 (post-094-desktop merges)
**Status**: Draft — verified against latest main, ready for cloud-agent pickup. No code moves until the migration waves below.
**Input**: "Look at how reference agents structure their monorepos (Clara-style domains, opencode's domain folders). Can/should Matrix adopt something similar?"

## Why This Exists

Two Matrix packages have grown into **god-modules** that are hard to understand "at altitude" and expensive for both humans and AI agents to navigate:

- `packages/gateway/src` — **86 `.ts` files flat at the top level** plus 19 sub-folders (verified on `origin/main` @ `c6efa3f8`). The filenames already encode latent domains (`app-*`×12, `workspace-*`×5, `file-*`×5, `session-*`×4, `review-*`×3, `git-*`×3, `agent-*`×3) — a poor-man's grouping done with filename prefixes instead of folders.
- `shell/src/components` — **29 components loose at the top level** (130 `.tsx` across the package), no feature grouping.

This is the exact failure mode the "Clara philosophy" names: a system you cannot reason about at every zoom level, where retrieval is imperfect and context windows blow out. Three production AI-agent codebases independently converged on a fix; this spec adapts the parts that fit Matrix.

This spec is **structure + documentation discipline only**. It does not change runtime behavior, dependencies, or the public/HTTP surface.

## Prior Art Reviewed

| Reference | Model | What we take | What we skip |
|-----------|-------|--------------|--------------|
| **opencode** (`anomalyco/opencode`, cloned at `../opencode`, tracking `dev`) | One core package (`packages/opencode/src`) with ~35 **domain folders** (`session/`, `provider/`, `agent/`, `git/`, `worktree/`, `permission/`, `mcp/`, `lsp/`…), each a self-exported namespace module. | Domain-folders-inside-one-package; namespace-export modules; `CONTEXT.md` as ubiquitous-language glossary; terse style guide (happy-path-first, minimal helpers); flat topic-named specs. | Effect runtime; Bun-only APIs; Go TUI split. |
| **"Clara philosophy"** (domain-driven desktop agent, private reference) | `packages/{apps,domains,shared}` — one package **per domain**, each with `src/{shared,client,main}` subpath exports. | The "zoom property"; nested `ARCHITECTURE.md → DOMAIN.md` docs; **decision logs** in every doc; directional dependency rules; boundary lint scripts. | Package-per-domain explosion; TS project refs everywhere; Electron client/main split. |
| **Superset** (layer-driven monorepo, private reference) | Flat `packages/*` (libraries) + `apps/*` (runnables) + feature-folder co-location inside apps (`Feature/{Feature.tsx, Feature.test.tsx, index.ts}`). | Co-located tests; `index.ts` barrels per unit; root-level Biome. | Turbo-specific wiring. |

**Convergence:** the two domain-organized references both keep a capability's **contract/types next to its implementation**, and opencode proves "folders, not packages" scales to ~35 domains in production. That is the model Matrix adopts.

## Decisions Locked (from brainstorming)

1. **Unit of organization = folders inside existing packages**, not new workspace packages. No `package.json`/`tsconfig` churn, fully reversible, zero build-wiring risk. (Validated by opencode running its entire core this way.)
2. **Gateway first; convention documented for all.** This spec fully maps `gateway/src`; `shell/` and other packages adopt the same convention later via their own specs.
3. **Enforcement = docs + one `check:patterns` boundary rule**, not a heavyweight dependency-graph linter (yet). The `check:patterns` suite already exists (`scripts/review/check-patterns.sh`, wired as `bun run check:patterns` and `check:patterns:diff main`).

## User Scenarios & Testing

The "users" here are **developers and AI agents** working in the codebase.

### User Story 1 — Understand a subsystem at altitude (Priority: P1)

A developer or agent needs to change session handling. Today they must grep across `agent-launcher.ts`, `agent-session-manager.ts`, `session-registry.ts`, `session-store.ts`, `session-runtime-bridge.ts`, `session-transcript.ts`, `conversation-*.ts`, `dispatcher.ts` scattered among 86 siblings, with no map of how they relate.

**Why P1**: This is the core pain. It directly drives token cost, onboarding time, and defect rate.

**Independent Test**: After migration, `gateway/src/domains/sessions/` contains exactly those files plus a `DOMAIN.md` that states the source of truth, the public surface, and dependencies. A reader understands the subsystem without opening sibling domains.

**Acceptance Scenarios**:
1. **Given** the migrated tree, **When** a developer opens `gateway/src/domains/sessions/`, **Then** every session-related module and its `DOMAIN.md` are co-located, and nothing session-related lives outside that folder.
2. **Given** `ARCHITECTURE.md` for gateway, **When** read top-to-bottom (~1 page), **Then** it lists every domain with a one-line purpose and the allowed dependency arrows — complete at that altitude without zooming into code.

### User Story 2 — Add a feature without crossing hidden boundaries (Priority: P1)

A developer adds a capability to the `apps` domain that needs to read git state. The rules tell them git is a separate domain they may depend on (directional), and the linter catches it if they instead reach into `files` internals.

**Why P1**: Explicit, enforced boundaries are what prevent the structure from rotting back into a flat pile.

**Independent Test**: `bun run check:patterns` fails on a deliberately introduced cross-domain deep import or an import cycle, and passes on a legal directional dependency.

**Acceptance Scenarios**:
1. **Given** a PR that imports `../files/file-ops` internals from the `apps` domain, **When** `check:patterns` runs, **Then** it reports a boundary violation with the offending file and line.
2. **Given** a PR that imports another domain's **public** entry (`domains/git`), **When** `check:patterns` runs, **Then** it passes.
3. **Given** a circular dependency between two domains, **When** `check:patterns` runs, **Then** it fails.

### User Story 3 — Docs stay honest over time (Priority: P2)

Each domain's `DOMAIN.md` carries a decision log. When a contract changes, the log records why, so future readers (and agents) don't re-litigate settled decisions.

**Why P2**: Valuable, but the structure delivers most of the benefit even before doc discipline is perfect.

**Independent Test**: A `verify-docs` check (or review-checklist item) flags a `DOMAIN.md` whose declared dependencies no longer match the folder's actual imports.

**Acceptance Scenarios**:
1. **Given** a domain that adds a dependency on a new domain, **When** `DOMAIN.md` is not updated, **Then** the docs-drift check reports the mismatch.

### Edge Cases
- **Ambiguous files** (e.g. `worktree-manager.ts`, `preview-manager.ts`, `canvas/`) — placement is decided at migration time and recorded in the relevant `DOMAIN.md` decision log. The map in `gateway-domain-map.md` marks these provisional.
- **Shared/cross-cutting code** (`logger.ts`, `http-body.ts`, `ring-buffer.ts`, `path-security.ts`, `ws-message-schema.ts`) — lives in a `gateway/src/_shared/` (or `lib/`) folder that domains may import but which may **never** import a domain.
- **Bootstrap/entry** (`index.ts`, `main.ts`, `server.ts`, `routes/`) — stays at the package root as the "app" layer that composes domains. No business logic.

## Requirements

### Functional (the convention — full text in `domain-convention.md`)

- **FR-1**: Each package over a size threshold organizes business logic into `src/domains/<domain>/` folders. Pure infrastructure goes in `src/_shared/`. Entry/composition stays at `src/` root.
- **FR-2**: Every domain folder has a single public entry (`index.ts`) and a `DOMAIN.md`. Cross-domain imports go **only** through the public entry — no deep imports into another domain's internals.
- **FR-3**: Dependencies between domains must be **directional and acyclic**, declared in `DOMAIN.md`, and enforced by `check:patterns`.
- **FR-4**: `_shared`/`lib` never imports a domain. The "app" root composes domains and contains no business rules.
- **FR-5**: Each package has a ~1-page `ARCHITECTURE.md` (domain list, dependency graph, golden path). Each domain has a 1–2 page `DOMAIN.md` (purpose, public surface, dependencies, decision log).
- **FR-6**: Code-style conventions for new/moved domain code are documented (namespace-or-barrel export per domain, happy-path-first, minimal single-use helpers, no star/alias imports) — synthesized from opencode's style guide and adapted to Matrix's existing rules.
- **FR-7**: This spec changes **no** behavior. Migration PRs are pure moves + import-path updates; tests pass unchanged.

### Non-Functional / Constraints
- **NFR-1**: Migrations are **mechanical and reversible** (git `mv` + import rewrites). No logic edits in the same PR.
- **NFR-2**: Each migration PR stays within Matrix PR limits (≤3000 additions / ≤50 files) — split per domain or per domain-group.
- **NFR-3**: No new runtime dependencies. The boundary check reuses the existing `scripts/review/` shell-script approach.
- **NFR-4**: Honors all existing CLAUDE.md hard rules (worktree+PR, no direct commits to main, Greptile 5/5, react-doctor for any `.tsx` touched).

## Success Criteria

- **SC-1**: `gateway/src` has **0 business-logic files** loose at the top level (only entry/composition + `_shared`).
- **SC-2**: A new contributor (or fresh agent) can name every gateway domain and its dependencies from `ARCHITECTURE.md` alone, in under 5 minutes, without reading code.
- **SC-3**: `bun run check:patterns` includes a boundary rule that fails on cross-domain deep imports and cycles; CI runs it.
- **SC-4**: Every gateway domain folder has a `DOMAIN.md` with a populated decision log.
- **SC-5**: Test suite, typecheck, and behavior are **identical** before and after each migration PR (diff is moves + imports only).

## Out of Scope (explicit)
- Splitting any domain into its own workspace package (deferred; criteria for graduation documented in `domain-convention.md`).
- `shell/src` and other packages' migrations (separate future specs; they adopt this convention).
- Any dependency-graph linter beyond the `check:patterns` script (revisit if the script proves too weak).
- Renaming the top-level `packages/*` layout — it already matches the layer-driven model and is fine.
- Behavior, API, schema, or transport changes of any kind.

## For the Implementing (cloud) Agent — start here

1. **Read** `domain-convention.md` (the rulebook) and `gateway-domain-map.md` (the worked file→domain map).
2. **Resolve the 5 open placement questions** at the bottom of `gateway-domain-map.md` first — they block clean wave boundaries. If the human owner hasn't answered, pick the recommended default, record it in the target `DOMAIN.md` decision log, and proceed.
3. **PR 1 (docs + lint, conflict-free)**: add the gateway `ARCHITECTURE.md`, the `check:patterns` boundary rule (deep-import + cycle detection over `src/domains/*`), and CI wiring. No file moves yet. This PR makes later PRs self-policing.
4. **PRs 2..N (migration waves)**: one domain-group per PR, lowest-coupling first (Wave 1 → 3 below). Each PR = `git mv` + import-path fixes + that domain's `DOMAIN.md`. **No logic edits.** `bun run typecheck` + `bun run test` must be green and behavior identical. Keep each PR ≤50 files / ≤3000 additions.
5. **Verify per PR**: `bun run typecheck`, `bun run test`, `bun run check:patterns`. Confirm the diff is moves+imports only (`git diff --stat` should show renames). Greptile 5/5 before merge.

## Rollout (sequencing)

1. **Done**: spec + convention + map written and verified against `origin/main` @ `c6efa3f8`; pushed to branch `093-codebase-domain-structure` for cloud-agent pickup.
2. **PR 1**: docs + `check:patterns` boundary rule (cheap, conflict-free).
3. **Waves 2–4**: migrate gateway one domain-group per PR, lowest-coupling first (`review`, `voice`, `social`, `git`, `scheduling`, `observability` → `files`, `identity`, `apps/db` → `apps`, `sessions`, `workspace`). See `gateway-domain-map.md` for the per-wave file lists.
4. **Later (own specs)**: `shell/src` feature-foldering; evaluate graduating any domain to a package.

## Spec Quality Gate Notes
Per `specs/quality-gates.md`: this change has **no** endpoints/WebSockets/IPC/file-I/O behavior changes — it is a structural refactor. The relevant gate is **migration safety**: mechanical-only diffs, identical tests, reversible. Auth/validation/error/resource policies are unchanged because no code logic moves.

## Decision Log
- **2026-06-15**: Folders-inside-packages chosen over package-per-domain — opencode proves it scales; avoids build churn; reversible.
- **2026-06-15**: Gateway chosen as first target — worst offender (86 flat files), highest ROI.
- **2026-06-15**: `check:patterns` boundary rule chosen over dependency-cruiser/eslint-boundaries — matches existing Matrix enforcement style, no new deps.
- **2026-06-15**: Spec/docs-only deliverable first; migration deferred until open PRs merge (user constraint).
- **2026-06-16**: Re-verified inventory against `origin/main` @ `c6efa3f8` after the 094-desktop merges (71 commits): gateway grew by one file (`icon-routes.ts`) to 86 flat files; structural story unchanged. Corrected the shell figure (29 loose components at the top of `shell/src/components`, 130 `.tsx` total). Pushed to branch for cloud-agent handoff.
