# S20 receipt — org-only precondition and release-gate removal (T098–T102)

**Packet:** S20. **Tasks:** T098, T099, T100, T101, T102. **Date:** 2026-09-20 (re-cut after review on the same day).
**Base:** `124/s01-gateway` tip `ec3c25343` (S01 four-layer stack on main).
**Result:** six implementation layers plus one evidence child, each under the 3,000-addition / 50-file limit and coherent on its own head. The lower five layers through #1791 have merged; #1795 UI and #1817 evidence are in review. No release flag, rollout cohort or person-to-person audience remains; the organization precondition on the home is the only gate and denies every request until the S03 membership projection registers a source.

## Layers

| Layer | Branch / head | Tasks | Files | Contents |
| --- | --- | --- | --- | --- |
| 1 | `124/s20` `e5293d80c` | T098, T099 | 22 | Flag removal; gateway `collaboration/config.ts`, `fail-closed.ts` (bodyLimit on every mutating verb, DELETE included) and `construct.ts` (runtime construction failure mounts fail-closed routes instead of terminating the gateway); platform `collaboration/fail-closed.ts`; system info reports configuration health |
| 2 | `124/s20-organization` `6cf90b4b7` | T101 (persistence) | 25 | Gateway migration 7 (`organization_id` on scopes and grants); `organizationId` required on scope preflight/create; every creation path persists it (inherited scopes copy the parent's, grants derive from the scope); the confirmation token binds it; an existing scope in another organization is a conflict; pre-organization scopes cannot be widened. Cohort logic untouched in this layer |
| 3 | `124/s20-cohort` `d3422bbc6` | T100 (home) | 32 | `organization-precondition.ts`; the authority evaluator takes one precondition and consults it before any allow; proof-only owner operations (scope creation, project inventory/confirm, lifecycle, operations, exports, invitation reads/decisions) require current membership; gateway policy client, milestone/mode/cohort branches and the policy header removed from every route, socket, queue and terminal path |
| 4 | `124/s20-cohort-platform` `1edc71d26` | T100 (platform) | 17 | `collaboration_rollout_policy` dropped, `CollaborationPolicy` contract and header removed, `/internal/collaboration/policy` gone, proxy and WebSocket bridge make no policy decision, tickets carry no policy revision |
| 5 | `124/s20-audience` #1791 merged | T101 (resolution), T102 | 21 | Invitation identifiers resolve only to current members of the scope's organization and to nothing without a projection; person-to-person inventories (all grant statuses, revoked index rows) plus `scripts/collaboration/inventory-person-to-person.ts`; research.md procedure and local zero result |
| 6 | `124/s20-audience-ui` #1795 `79e3cee33` | T101 (surfaces) | 48 | Organization-member copy and `organizationId` on share dialogs/buttons; shell and Electron organization gates; UI/desktop tests and Clerk fixture repairs; representative five-surface captures and safe Electron capture harness |
| 7 | `124/s20-audience-evidence` #1817, child of #1795 | T101 (evidence) | 9 | Remaining Web Canvas/Web Mobile captures and this receipt |

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


## 2026-09-21 CI repair and evidence-layer recut

The dispatched full S20 stack CI run `35584963094` on `e5f2fca10` failed 19 shell cases in `chat-agent-mentions`/`chat-app-provider-state`, five `chat-agents-page` cases, and one gateway project-lifecycle case. The 24 shell RED cases threw `useOrganization can only be used within ClerkProvider`; the shell fixture tests in UI commit `ff0d94493` now provide Clerk organization state. The gateway lifecycle fixture was repaired in #1791, whose supplemental `S20-audience-core-receipt.md` records 1/6 RED and 6/6 GREEN. The three shell suites passed **35/35** on the original combined local top head `7c3100fcb` and again on the recut combined tree.

The original top layer was 53 files (+763/−49) against its original audience parent `40179567a`, over the 50-file review limit. Backup ref `refs/backup/124-s20-audience-ui-before-codex-20260921-1238` retains that head; binary patches were saved as `/tmp/s20-audience-{full,evidence}-before-recut.patch` (SHA256 `087494414c3673f58d26030cd730ea25ea732de39be91a600216a0097eb9f65e` and `de309a0887930702a644115f86f438c56cacb0f2265b542a08b6fc3d966bacb9`). The recut UI commit `ff0d94493` is 26 files (+261/−49); evidence child `8c2beb0bd` was 27 files (+502). Their combined tree was byte-identical to the backed-up head before the evidence-script fix. The child then added `2dc9602e1` for safe renderer restoration. No Graphite restack, submit, push, or merge has run for the recut heads.

| Validation on the recut combined tree | Result |
| --- | --- |
| Full `bun run typecheck` with worktree-local frozen pnpm links | Exit 0, including gateway, platform, shell dependencies and Electron Desktop. |
| Focused shell, Electron, shared UI and capture-restoration suite (`--maxWorkers=2`) | 10 files, **75/75 passed**. The three previously failing shell suites account for 35 of those tests. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` set to a non-secret test-format key; `bun run build:shell:production` | Exit 0: Next compilation, TypeScript and all static pages completed. |
| `bun run check:patterns` | Exit 0: 0 violations, 5 existing warnings. |
| `npx react-doctor@latest shell` | Exit 1 from 240 repository-wide diagnostics; no S20-specific finding established. |
| `npx react-doctor@latest --verbose --scope changed` | Exit 0, score 88/100; one inherited gateway `owner-database-fallback.ts` sequential-await warning, no S20 UI finding. |
| RED `tests/desktop/s20-renderer-asset.test.ts` before helper | Suite failed because `renderer-asset.js` did not exist; a partial built-renderer write had no tested restoration path. |
| GREEN same focused helper test | 2/2 passed. A fault-injected write truncates then throws; the helper restores the exact original bytes. The second test covers ordinary post-capture restoration. |

Greptile's #1794 review singled out a changed `deriveChatPermissions().aiExplanation` string for lacking visual evidence. Inspection found this field is unused by rendered shared Chat controls: `ChatCollaboration` reads only `.canDiscuss`, while `SharedChatControls` derives visible capability status independently. #1794 removes that unused change. This UI layer does not claim a screenshot for it or introduce misleading owner-computer wording into unrelated provider-unavailable states. The existing Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile evidence/limitations remain in `evidence/S20-audience/README.md` and the five-surface PR body; no new interactive capture was run after the capture-helper fix.

Historical open gates above were superseded by the current review state below. Web Desktop share-control reachability and Electron project share reachability remain tracked under #1798/S15 T078. No production Clerk, owner VPS, provider, deployment or external publication was exercised here.

## 2026-09-21 current UI and evidence review state

#1791 merged after current-head Greptile 5/5 and full label-triggered CI success (run `35607650164`). #1795 UI was rebased onto the merged main and split from #1817 evidence. The UI head `79e3cee33` is 48 files and under 3,000 additions; the evidence child is nine files and 70 additions. Their combined tree preserves the prior captures, with the tested Electron harness fixes described here.

The first #1795 current-head review and #1817 child review found that the Electron capture runner swallowed Terminal and Chat selector failures, and that teardown could leave a built renderer patched if gateway/profile cleanup failed. The fixed runner propagates failures from required Terminal and Chat flows, records only the known optional Project failure, and restores the renderer in `finally`. The diagnostic Set retains the newest 50 unmatched requests. Reproduction instructions copy all three runner/helper files. The 10 Electron PNGs and representative Web Canvas, Web Desktop and Web Mobile PNGs are directly in #1795; the remaining captures are in #1817. These are existing captures, not new captures from the fixed runner.

| Current validation | Result |
| --- | --- |
| Diagnostic bound RED | `tests/desktop/s20-capture-safety.test.ts` failed 1/4 before `recordBoundedDiagnostic` existed: missing function at the 51st-entry test. |
| Focused GREEN | `pnpm exec vitest run tests/desktop/s20-capture-safety.test.ts tests/desktop/s20-renderer-asset.test.ts`: 2 files, 6/6 passed at UI head `79e3cee33`. The required-failure, optional-project, cleanup-finally, and 50-entry tests cover the review findings. |
| Full typecheck | `bun run typecheck` exit 0 at UI head `79e3cee33`. |
| Pattern scan | `bun run check:patterns` exit 0: 0 violations, 5 existing warnings. |
| Visual capture rerun after harness fix | Unrun: the current worktree has no built `desktop/out/main/index.js`; the committed screenshots predate the harness fix. |

The prior direct capture restoration test was already GREEN before the review fix. No RED run was recorded for the new failure-propagation or cleanup tests before their helper implementation; the review established the prior runner behavior from source. #1795 and #1817 need new-head Greptile 5/5 and #1795 main-base full CI before merge. The child will be restacked onto main after #1795 merges.
