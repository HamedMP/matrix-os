# Implementation Plan: Organization-wide Project Access

**Branch**: `codex/eng-29-shared-codex-subscription` | **Date**: 2026-11-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2689-organization-project-access/spec.md`
**Linear**: ENG-29

## Summary

Make a shared project one organization-wide work boundary. Once its owner shares it, every current and future active member of that organization receives the complete non-administrative project capability set without invitations, activations, roles, or per-member grants. Shared AI requests resolve the owner's current global Provider Settings `active` route at request time, record the exact route used for the run, and fail closed if it is unavailable or changes. The owner alone retains share/unshare, whole-project deletion, AI/billing configuration, and organization membership administration.

The serving path will use the existing `collaboration_scopes.organization_id`, lifecycle, ownership, and fresh organization membership evidence. Project grant and execution-policy records will no longer be authorization inputs. They remain temporarily readable only where required for standalone-share compatibility, rollback, and audit; cleanup is a later migration after telemetry proves the new path.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict on Node.js 24+; React 19 / Next.js 16
**Primary Dependencies**: Hono, Kysely, PostgreSQL, Zod 4 (`zod/v4`), Clerk organization evidence, Matrix provider-settings V3
**Storage**: Existing owner-controlled PostgreSQL collaboration tables and owner Provider Settings; no new database or ORM
**Testing**: Vitest with `@vitest/coverage-v8`; gateway, contract, UI, and live surface verification
**Target Platform**: VPS-native Matrix gateway plus Web Desktop and Electron desktop shells
**Project Type**: Monorepo web/desktop application with shared contracts and gateway
**Performance Goals**: No additional network round trip beyond the existing fresh organization precondition; authorization and AI source resolution remain bounded by current request deadlines
**Constraints**: Fail closed; no credential disclosure; no provider fallback; membership and provider authority checked at request time; all mutations retain body limits and typed validation; affected live surfaces require captures
**Scale/Scope**: Shared project scopes, inherited chats/files/apps/terminals, project share UI, shared AI admission, existing projects, and standalone-share compatibility

## Constitution Check

*GATE: Passed before Phase 0 research and re-checked after Phase 1 design.*

| Principle | Design response | Result |
|---|---|---|
| Data belongs to its owner | Project data remains in the owner's Postgres/home boundary; organization membership grants use, not ownership or credential access. | Pass |
| AI is the kernel | Shared requests continue through the existing kernel/runtime brokers and use Provider Settings V3 as the canonical route. | Pass |
| Headless core, multi-shell | Authorization and AI resolution live in gateway services/contracts; UI only renders the result. | Pass |
| Defense in depth | Fresh membership, lifecycle, owner-only admin gates, request validation, bounded provider checks, revocation drains, and no fallback remain mandatory. | Pass |
| TDD | Contract and gateway regression tests are written failing first; UI tests follow before implementation. | Pass |
| PostgreSQL/Kysely | Existing PostgreSQL state remains canonical; no alternate persistence is introduced. | Pass |
| Compatibility | Standalone resource shares keep their current grant behavior while project scopes use the new organization access mode. | Pass |
| Operability | Authorization decisions remain auditable; legacy records are retained during rollout and ignored rather than destructively migrated. | Pass |

Post-design re-check: the design adds no trust boundary, persistence technology, wildcard access, or unbounded resource. "Full access" means the enumerated project work capabilities only; it never includes credentials, billing, membership administration, share administration, or whole-project deletion.

## Project Structure

### Documentation (this feature)

```text
specs/2689-organization-project-access/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── organization-project-access.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/contracts/src/
├── collaboration.ts
├── collaboration-capabilities.ts
└── collaboration-execution.ts

packages/gateway/src/collaboration/
├── capability-evaluator.ts
├── capability-routes.ts
├── shared-chat-authority.ts
├── project-sharing.ts
├── project-transition.ts
├── project-inheritance.ts
├── execution-policy-routes.ts
├── shared-run-owner-source.ts
├── run-account-binding.ts
├── shared-ai-runtime.ts
├── revocation-enforcer.ts
└── wiring.ts

packages/gateway/src/ai-providers/
├── service.ts
├── provider-settings-store.ts
└── provider-settings-projector.ts

packages/ui/src/collaboration/
├── ProjectSharingDialog.tsx
├── ProjectAccessManager.tsx
├── ContributorAiSettings.tsx
├── useProjectSharing.tsx
├── SharedProjectView.tsx
└── client.ts

shell/src/app/shared/project/[scopeId]/page.tsx
shell/src/lib/collaboration.ts

tests/contracts/
tests/gateway/
tests/ui/
tests/e2e/
```

**Structure Decision**: Keep the change inside the existing shared contracts, gateway collaboration/provider services, and shared UI package. Do not add a parallel authorization service or a second settings model. Electron consumes the same shell/UI implementation and must be verified separately as a runtime surface.

## Implementation Strategy

### 1. Freeze the new contract with failing tests

- Add contract tests for an organization-wide project access presentation with no role, grant, activation, model allowlist, or acknowledgment fields.
- Add gateway tests proving that an active organization member immediately receives the complete project work action set, including for inherited resources, while an outsider is denied.
- Add owner-boundary tests proving members cannot share/unshare, delete the whole project, configure owner AI/billing, or administer organization membership.
- Add AI admission tests proving the current Provider Settings V3 `active` tuple is resolved for each request, unavailable means fail closed, and no alternate source is selected.
- Add migration/compatibility tests for already-shared projects and legacy standalone shares.

### 2. Collapse project authorization onto organization membership

- Introduce one project-access decision in `capability-evaluator.ts`: a live `project` scope plus matching fresh organization membership yields the contributor action set; owner detection remains separate.
- Apply the same decision to inherited child scopes and transactional chat authorization so REST, WebSocket, terminal, files, apps, and Git brokers cannot diverge.
- Keep lifecycle, deleted-state, organization mismatch, stale evidence, archived read-only behavior, and revocation fences fail closed.
- Stop requiring grant activation for project discovery/opening. Current and future members see/open the project from organization inventory without accepting it.
- Reject project-specific grant/preset mutations as unsupported while leaving standalone resource grants intact.

### 3. Remove project-specific access configuration

- Replace the project access presentation with organization, owner, lifecycle, and `organization_full_access` mode.
- Simplify `ProjectSharingDialog` to one share/unshare decision and plain language that all active organization members can work in the project.
- Remove `ProjectAccessManager` and `ContributorAiSettings` from project flows. Retain components only if still required by standalone compatibility; otherwise delete them with their tests.
- Remove Editor/Viewer, people picker, general-access preset, activation, model choice, provider-terms checkbox, and per-project AI copy from the project UI.

### 4. Resolve shared AI from current global Settings

- Replace the mandatory project execution-policy lookup in `SharedRunOwnerSource` with a bounded read of the owner's Provider Settings V3 `active` tuple (`providerInstanceId`, `accessSourceId`, `modelId`).
- Verify that exact tuple is ready and belongs to the scope owner at admission and again at dispatch/credential resolution. Do not consult another provider or default when it fails.
- Preserve a per-run immutable binding of the exact provider instance, access source, model, owner generation, and settings revision/epoch used. This is audit/session continuity, not a reusable project policy.
- Fence queued and active member work when the owner disconnects, disables, replaces, or changes the active route; later requests use the new current route only after it verifies ready.
- Remove project execution-policy routes from project UI and serving paths. Keep or narrow the implementation only where a non-project compatibility path still depends on it, then deprecate it explicitly.

### 5. Roll out without a destructive data migration

- Use existing project scope organization/lifecycle fields; no new column is required.
- Treat existing project grants, activations, execution policies, and allowed-model rows as inert legacy records after cutover. Do not rewrite or delete them in this change.
- Ensure unshare/revocation advances the existing auth epoch, drains live sessions, and removes the project from organization inventory.
- Add structured, bounded telemetry for denied membership, unavailable current AI route, legacy project record ignored, and forbidden owner-admin action. Never log credentials or raw provider errors.

### 6. Verify behavior and surfaces

- Run focused contract/gateway/UI suites, then the collaboration regression suite and coverage for touched production modules.
- Run the Web Desktop and Electron desktop sharing flows against a live gateway: share, join as existing member, join as newly added member, edit/use AI, change owner AI settings, remove member, unshare.
- Capture each affected surface at the exact reviewed commit/build and attach evidence to the PR and Slack `#tech` with ENG-29 and PR links, per repository policy.

## Delivery Sequence

1. **Spec/contract PR**: land this specification, contract design, and authoritative collaboration/provider spec updates.
2. **Implementation PR**: TDD changes for gateway, shared contracts, UI, compatibility, and live evidence. If stacked, both PRs reuse ENG-29 and name/link the stack.
3. **Cleanup follow-up**: only after production telemetry and rollback window, remove legacy project grant/policy persistence and dead compatibility code under a separately reviewed task.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A role/grant check survives on one resource path | Centralize project membership decision; add route/broker matrix tests across chats, files, apps, terminal, Git, and WebSocket. |
| "Full access" accidentally grants admin authority | Keep owner-only actions outside the work capability set and test each one negatively. |
| Settings changes race queued runs | Resolve and verify at admission and dispatch; bind exact tuple per run; fence on generation/revision change. |
| Existing projects become inaccessible | Scope organization/lifecycle is canonical; add fixtures with historical grants/policies and prove they are ignored. |
| Standalone sharing regresses | Branch explicitly on project versus standalone scope and retain standalone grant tests. |
| Provider credentials leak to members | Keep broker-only resolution and generic client errors; never return access tokens, filesystem paths, or raw provider failures. |

## Complexity Tracking

No constitution violations require an exception. Retaining inert legacy records is a temporary rollback/audit measure, not a second serving policy.
