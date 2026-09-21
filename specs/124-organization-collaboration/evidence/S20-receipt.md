# S20 receipt — org-only precondition and release-gate removal (T098–T102)

**Packet:** S20. **Tasks:** T098, T099, T100, T101, T102. **Date:** 2026-09-20 (re-cut after review on the same day).
**Base:** `124/s01-gateway` tip `ec3c25343` (S01 four-layer stack on main).
**Result:** six stacked Graphite layers, each under the 3,000-addition / 50-file limit and coherent on its own head. No release flag, rollout cohort or person-to-person audience remains; the organization precondition on the home is the only gate and denies every request until the S03 membership projection registers a source.

## Layers

| Layer | Branch / head | Tasks | Files | Contents |
| --- | --- | --- | --- | --- |
| 1 | `124/s20` `e5293d80c` | T098, T099 | 22 | Flag removal; gateway `collaboration/config.ts`, `fail-closed.ts` (bodyLimit on every mutating verb, DELETE included) and `construct.ts` (runtime construction failure mounts fail-closed routes instead of terminating the gateway); platform `collaboration/fail-closed.ts`; system info reports configuration health |
| 2 | `124/s20-organization` `6cf90b4b7` | T101 (persistence) | 25 | Gateway migration 7 (`organization_id` on scopes and grants); `organizationId` required on scope preflight/create; every creation path persists it (inherited scopes copy the parent's, grants derive from the scope); the confirmation token binds it; an existing scope in another organization is a conflict; pre-organization scopes cannot be widened. Cohort logic untouched in this layer |
| 3 | `124/s20-cohort` `d3422bbc6` | T100 (home) | 32 | `organization-precondition.ts`; the authority evaluator takes one precondition and consults it before any allow; proof-only owner operations (scope creation, project inventory/confirm, lifecycle, operations, exports, invitation reads/decisions) require current membership; gateway policy client, milestone/mode/cohort branches and the policy header removed from every route, socket, queue and terminal path |
| 4 | `124/s20-cohort-platform` `1edc71d26` | T100 (platform) | 17 | `collaboration_rollout_policy` dropped, `CollaborationPolicy` contract and header removed, `/internal/collaboration/policy` gone, proxy and WebSocket bridge make no policy decision, tickets carry no policy revision |
| 5 | `124/s20-audience` `e933fb54c` | T101 (resolution), T102 | 21 | Invitation identifiers resolve only to current members of the scope's organization and to nothing without a projection; person-to-person inventories (all grant statuses, revoked index rows) plus `scripts/collaboration/inventory-person-to-person.ts`; research.md procedure and local zero result |
| 6 | `124/s20-audience-ui` (this commit) | T101 (surfaces) | 19 + evidence | Organization-member copy and `organizationId` on the share dialogs/buttons; shell `CollaborationOrganization` gate (Clerk, bypass-safe); Electron Desktop `DesktopCollaborationOrganization` gate over the connection state; UI/desktop tests; screenshot evidence under `evidence/S20-audience/` |

## RED → GREEN and gates

Every layer head: `tsc --noEmit` clean for `@matrix-os/contracts`, `@matrix-os/gateway`, `@matrix-os/platform`, `@matrix-os/ui`, `shell` and `desktop`; `bun run check:patterns` 0 violations (5 pre-existing warnings). Focused suites per head (`--maxWorkers=2`/3): layer 1 10 files / 148 tests; layer 2 26 files / 231 tests (1 real-Postgres suite skipped); layers 3–6 recorded in each PR body. RED for the review fixes was observed on the pre-fix tree: bodyLimit tests returned 503 instead of 413, the revoked-owner denial tests returned 200/201 on lifecycle, operations, exports, inventory, confirm, preflight, create, invitation read/accept/decline, the foreign-organization preflight returned 200, and the share-again test reused the other organization's scope.

The full `bun run test` and `bun run typecheck` runs were killed by the host for memory pressure on the worker box during the first cut; CI provides both for every layer head.

## Pre-existing failure (not S20)

`tests/gateway/collaboration-chat-scope-postgres.test.ts › "does not strand a scope when activation races capability reconciliation and startup repeats it"` fails against real Postgres on `origin/main` at `fb8b21346` with an `execution_eligibility` shape mismatch. S20 only added the required `organizationId` to that test's preflight call; the assertion mismatch is unchanged from main.

## Migration and rollback

- Gateway migration 7 adds nullable `organization_id` to `collaboration_scopes` and `collaboration_members` plus a partial index; nullable so homes with pre-organization rows (expected zero) boot, those rows are denied, inventoried and dispositioned at S18, which then tightens to `NOT NULL` (migration ≥ 8). Additive; older code ignores the columns.
- Platform bootstrap drops `collaboration_rollout_policy` inside one locked `runPlatformMigration` transaction and relaxes the `policy_revision` ticket column to nullable instead of dropping it, so a pre-S20 build stays a rollback target (it recreates the rollout table empty with every milestone `off`, i.e. still closed). **S18 step:** drop `policy_revision` once pre-S20 builds are no longer rollback targets.
- `MATRIX_COLLABORATION_ENABLED` values already in `host.env` are inert.

## Review fixes folded into the layers (2026-09-21)

- Layer 1: fail-closed handlers apply `bodyLimit` to every mutating verb; runtime construction failure mounts fail-closed routes instead of terminating the gateway; the owner-database fallback now releases the Chat repository, execution guard, canvas repository and pool so the gateway runs wholly in file storage. The mixed state pre-dated S20 on the non-collaboration path (main threw for the collaboration path); a startup-level regression test needs a gateway startup harness that does not exist yet (follow-up).
- Layer 2: a parent project without an organization cannot stage inherited resources; contracts keep closed-capability and bounded-policy assertions; the real-Postgres Chat scope suite compiles again.
- Layer 3: proof-only owner operations call the precondition; scope creation proves membership in the requested organization before any write.
- Layer 4: atomic bootstrap; `policy_revision` retained nullable (S18 drops it).
- Layer 5: inventories count revoked/expired grants and revoked index rows.
- Layer 6: `organizationId` is required on `ChatSharingButton` and the Electron Chat wrapper passes it through the desktop gate; both gates remount their subtree keyed by organization so a preflight token or open scope cannot cross organizations (shell and desktop tests).

## Deferred / open gates

- The S03 membership projection registers itself through `OrganizationPrecondition.registerSource` and `PlatformCollaborationIdentifierResolver.membershipProjection`; until then every collaboration request and identifier resolution is denied by design.
- The S15 audience picker supplies `organizationId`; today the shell passes the active Clerk organization and Electron Desktop reads `organizationId` from the connection state, which the trusted-core auth status does not populate yet, so Electron share controls stay disabled until S06/S15 surface the organization there.
- Web Desktop cannot reach the project and terminal share controls on this branch (TerminalApp renders the sharing chrome only in the mobile layout and DesktopTerminalSidebar has no project rows); pre-existing and out of S20 scope, see `evidence/S20-audience/README.md`.
