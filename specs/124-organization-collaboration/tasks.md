# Sol implementation tasks

**Input:** [plan.md](plan.md), [data-model.md](data-model.md), [contracts](contracts/organization-api.md), [research.md](research.md).
**Executor:** `gpt-5.6-sol`, high reasoning. These are future implementation tasks; none has been implemented by the planning run. Proposed new paths are intentional. Existing anchors were inspected at `94985f02e`.

Every S-packet is one bounded agent assignment with prerequisites from the plan. Tests are written and observed failing before implementation. Record red/green, exact head, changed paths and limits in `specs/124-organization-collaboration/implementation-log.md`. All shared composition/export edits go through the coordinator. The final receipt/test step is mandatory for every packet even when not repeated as a checkbox.

## Setup — S00: provider and boundary proofs

**Owner:** coordinator/Sol. **Exit:** testable provider contracts and explicit rollout gates, without changing production.

- [ ] T001 Record fetched main SHA, dirty-worktree protection, available tools/Graphite auth and baseline relevant test failures in `specs/124-organization-collaboration/implementation-log.md`; re-read `.specify/memory/constitution.md`.
- [ ] T002 [P] Add and run a sandbox-only Clerk probe in `scripts/spikes/organizations/clerk-membership-probe.ts`: verify installed SDK webhook raw-body API, role mapping, paging/rate limits and membership deletion/role read behavior; record sanitized results in `specs/124-organization-collaboration/provider-evidence.md`.
- [ ] T003 [P] Add and run a service-only Matrix room probe in `scripts/spikes/organizations/matrix-room-boundary-probe.ts`: human/AI tokens cannot join/read/send/state/invite; platform-mediated text closes on expired membership under dropped webhook, Clerk outage and Synapse partition; record evidence in `specs/124-organization-collaboration/matrix-evidence.md`.
- [ ] T004 Freeze freshness timing, actor/owner/payer separation, admin content policy, fixed role mapping, text-only Matrix boundary and missing-price disabled behavior in `specs/124-organization-collaboration/contracts/organization-api.md`; block only affected rollout if a probe cannot prove its requirement.
- [ ] T005 Create the execution receipt and surface evidence templates in `specs/124-organization-collaboration/implementation-log.md` and `specs/124-organization-collaboration/evidence/README.md`; map every S-packet to a Graphite layer before coding.

## Foundation — S01: platform mechanical extraction

**Owner:** Platform Sol. **Exit:** identical existing behavior; huge files split before additions. Separate layers for each family; never one bulk 5,000-line move.

- [ ] T006 Add characterization coverage for existing migration/query exports, personal owner routing and webhook outcomes in `tests/platform/platform-db-compatibility.test.ts`, retaining `tests/platform/billing-db.test.ts` and `tests/platform/customer-vps.test.ts`.
- [ ] T007 Extract all schema/query families from `packages/platform/src/db.ts` into focused modules under `packages/platform/src/database/` (schema-core, users, runtimes, billing, funded-ai, matrix, onboarding and remaining domain modules); preserve facade exports and `runPlatformMigration` locking. Split each mechanical layer below review limits and leave the facade below 500 lines.
- [ ] T008 Extract provisioning identity/locks, environment assembly and lifecycle orchestration from `packages/platform/src/customer-vps.ts` into focused `packages/platform/src/customer-vps/` modules; preserve current exports and personal provision/recovery tests before adding typed org owners.
- [ ] T009 Extract Stripe projection/webhook/checkout helpers from `packages/platform/src/billing-routes.ts` into `packages/platform/src/billing/` modules; retain exact existing route paths and signed webhook behavior.
- [ ] T010 Extract reserve/settle/credential-resolution logic from `packages/platform/src/ai-funded-metering-repository.ts` into `packages/platform/src/funded-ai/` modules; keep transaction ownership and personal ledger results unchanged, each responsibility below 500 lines.

## Foundation — S02: gateway mechanical extraction

**Owner:** Resource Sol. **Exit:** current collaboration routes and member transactions unchanged.

- [ ] T011 Add exact registered-route/dependency characterization in `tests/gateway/collaboration-route-registration.test.ts`, alongside existing route/wiring/repository regressions.
- [ ] T012 Extract existing routes from `packages/gateway/src/collaboration/routes.ts` into `routes-scope.ts`, `routes-members.ts`, `routes-chat.ts`, `routes-terminal.ts` and `routes-project.ts`; keep a small registration entrypoint and identical auth/body-limit/error mapping.
- [ ] T013 Extract member mutation, lifecycle and migration helpers from `packages/gateway/src/collaboration/repository.ts` and `database.ts` into focused `member-repository.ts`, `lifecycle-repository.ts` and `database-migrations.ts`; preserve compatibility exports and current transaction scopes.

## Foundation — S03: typed contracts

**Owner:** Contracts Sol/coordinator. **Exit:** strict additive contracts; old personal clients continue working.

- [ ] T014 Add failing owner/audience/resource/proof/payer/role-ceiling validation and V1 compatibility tests in `tests/contracts/organizations.test.ts`, `tests/contracts/collaboration-grants.test.ts` and `tests/contracts/organization-billing.test.ts`.
- [ ] T015 Add `packages/contracts/src/ownership.ts`, `organizations.ts` and `collaboration-grants.ts`: immutable ActorId, OwnerRef, billing-account reference, six resource kinds, audience grants, capability explanations, guest generation and migration action ceilings.
- [ ] T016 Add `packages/contracts/src/organization-billing.ts` and `organization-matrix.ts`: sponsorship/checkout/usage and text-room operations; extend proof V2 without broadening V1 parsing in `packages/contracts/src/collaboration.ts`.
- [ ] T017 Register bounded strict exports/imports in `packages/contracts/src/index.ts` and `packages/contracts/package.json`; define every proposed request/action/response from the auth matrix and keep org IDs out of actor-only fields.

## US1 — S04: Clerk lifecycle and authoritative freshness

**Owner:** Platform Sol. **Exit:** missing/reordered events and provider outages cannot extend evidence.

- [ ] T018 [US1] Add failing signed-webhook, replay/reorder, unknown-role, deleted-org, timeout and request-start-anchored TTL tests in `tests/platform/organization-clerk.test.ts` and `tests/platform/organization-membership-evidence.test.ts`.
- [ ] T019 [US1] Add org/membership/inbox/outbox schema and repository in `packages/platform/src/organizations/database.ts` and `repository.ts`, using receipt+projection+epoch+audit/outbox transactions, CAS and idempotent migrations through the extracted platform schema registration.
- [ ] T020 [US1] Implement platform user/profile upsert for org members without personal runtimes and bounded `clerk-client.ts`, `webhook.ts` and `reconciler.ts` under `packages/platform/src/organizations/`; verified events invalidate immediately and authoritative reads restore evidence, never stale event payloads.
- [ ] T021 [US1] Implement `membership-evidence.ts` with fixed 20-second deadline, five-second authorization timeout, durable access-permit issuance/completion/revocation records, coalesced bounded cache and no TTL chaining; add active-identity refresh and unavailable state.
- [ ] T022 [US1] Add `organizations/wiring.ts`, startup/shutdown registration patches for `packages/platform/src/platform-startup.ts` and `main.ts`, and a real-Postgres `tests/platform/organization-lifecycle-postgres.test.ts` for duplicate/reordered events, epoch races and worker shutdown.

## US1 — S05: organization, group and guest management

**Owner:** Platform Sol. **Exit:** admin manages Clerk-backed membership/local groups without a second org authority.

- [ ] T023 [US1] Add failing org admin/member/outsider/last-admin tests, duplicate remote-command and ambiguous-outcome tests in `tests/platform/organization-commands.test.ts` and `tests/platform/organization-routes.test.ts`.
- [ ] T024 [US1] Implement Clerk-backed create/update/delete/invite/cancel/role/remove/leave commands in `packages/platform/src/organizations/commands.ts`: pre-fence removals, call Clerk outside transactions, reconcile unknown outcomes before retries and never claim queued commands succeeded.
- [ ] T025 [US1] Implement group and group-member records/actions in `packages/platform/src/organizations/groups.ts`; active Clerk membership is required in the committing operation, with revision predicates, epoch updates and outbox events.
- [ ] T026 [US1] Implement explicit guest invitation/acceptance/revocation and generation checks in `packages/platform/src/organizations/guests.ts`; former member grants never become guest admission implicitly.
- [ ] T027 [US1] Mount exact management/internal access-resolution routes from the auth matrix in `packages/platform/src/organizations/routes.ts` and `internal-routes.ts`; enforce raw webhook/session/runtime boundaries, body limits, Origin/CSRF and safe errors.

## US2 — S06: unified principal grants and direct-user migration

**Owner:** Resource Sol. **Exit:** one transaction-aware evaluator with exact legacy direct behavior.

- [ ] T028 [US2] Add failing pure tests for user/org/group matching, overlapping action ceilings, admin management versus content, inherited scopes, expiry and explanations in `tests/gateway/collaboration-grants.test.ts`.
- [ ] T029 [US2] Add grant/version schema and idempotent shadow backfill from member rows in `packages/gateway/src/collaboration/grant-migrations.ts`; preserve acceptance, invitation IDs, timestamps, expiry and seven-direct-invite capacity without org member expansion.
- [ ] T030 [US2] Implement `grant-repository.ts` and `grant-evaluator.ts` under `packages/gateway/src/collaboration/`: optional transaction executor, lock root scope first, grant CAS, audit/outbox/replay records, capabilities and matching-source explanations.
- [ ] T031 [US2] Implement compatible direct-invitation writes and grant/access routes in `packages/gateway/src/collaboration/routes-grants.ts`; dual-write only within the owner transaction during shadow comparison, then deploy/prove the minimum-runtime compatibility barrier and per-scope checkpoint before flipping `authority_version`; update direct-user member projections transactionally afterward but prohibit fallback authorization reads.
- [ ] T032 [US2] Add real-Postgres grant/revoke/accept/role/migration races in `tests/gateway/collaboration-grants-postgres.test.ts`; prove restart-safe backfill, mismatch fail-closed, old binaries refusing V2 scopes before activation, and V1 snapshot independence.

## US2 — S07: proofs, current action checks and revocation

**Owner:** Integration Sol. **Exit:** all current action paths enforce V2; quiet streams and queued work lose access on time.

- [ ] T033 [US2] Add failing typed-owner/evidence-clamp/replay/cohort tests in `tests/platform/collaboration-organization-proof.test.ts` and gateway `tests/gateway/collaboration-organization-revocation.test.ts` with fake clocks plus real race coverage for app/file publish versus platform org denial fences and expiring permits; long operations must restage/reacquire authority before publication.
- [ ] T034 [US2] Extend platform `collaboration/proof.ts`, `proxy.ts`, `websocket.ts` and `bootstrap.ts` with scope-candidate audience resolution, typed owner and fresh evidence; V1 remains personal-only, and sync JWTs are actor identity only.
- [ ] T035 [US2] Replace direct member lookups with transaction-aware evaluation in gateway `collaboration/authority.ts`, `chat-adapter.ts`, `discussion-adapter.ts`, `project-layout-adapter.ts`, `chat/queue-repository.ts` and `chat/collaboration-commands.ts`; extract before growing oversized files, and inventory every remaining `collaboration_members` authorization read to prevent compatibility fallback bypasses.
- [ ] T036 [US2] Generalize `collaboration/chat-execution-adapter.ts` owner resolution and cohort checks; refresh authority at AI dispatch/tool effects/approval/cancel/retry and every terminal control action, never treating the org ID as a user.
- [ ] T037 [US2] Implement immediate post-commit invalidation, bounded evidence renewal and five-second quiet-connection sweeps in `collaboration/events.ts`, `terminal-events.ts`, both WebSocket route modules and platform WS proxy; drain both ends on shutdown and record revocation acknowledgement/expiry before completion.
- [ ] T038 [US2] Add dropped-webhook, replayed stale proof, offline runtime, delayed mutation, queued AI and reconnect tests in `tests/e2e/organization-revocation.spec.ts`; require real Postgres and prove no fallback to direct owner routes.

## US4 — S08: discovery and organization sharing inventory

**Owner:** Platform Sol. **Exit:** dynamic audiences discover shares without per-member fanout; admin metadata does not grant content.

- [ ] T039 [US4] Add failing discovery/join/leave/group/overlap/pagination/privacy tests in `tests/platform/organization-sharing-directory.test.ts` and `organization-sharing-inventory.test.ts`.
- [ ] T040 [US4] Extend platform `collaboration/database.ts` and `repository.ts` with audience indexes/typed owners, and gateway `collaboration/directory-outbox.ts` with audience/generation projections; retain actor indexes only for direct invitations.
- [ ] T041 [US4] Implement dynamic discovery and safe current-grant hydration in platform `collaboration/routes.ts` and `organizations/shared-resources.ts`; never enumerate the org into the eight-person member index or return stale revoked titles.
- [ ] T042 [US4] Implement inbound-org grant denial fences and async owner removal in `organizations/inbound-grants.ts`, plus audit/operation routes; an offline personal owner yields pending cleanup but immediate authoritative denial, not a false removed result.

## US2 — S09: common sharing UI for existing sessions

**Owner:** UI Sol. **Exit:** eligible Chat/terminal org sharing works across Web Canvas/Web Desktop/Electron; project unavailable states remain truthful until S12.

- [ ] T043 [US2] Add failing audience/role/inheritance/overlap/loading/error/direct-acceptance tests in `tests/ui/organization-sharing-controls.test.tsx` and `shared-resource-directory.test.tsx`.
- [ ] T044 [US2] Extract discovery from `packages/ui/src/collaboration/ChatCollaboration.tsx`; build `ResourceShareDialog.tsx`, `AudiencePicker.tsx`, `EffectiveAccessList.tsx`, `SharedResourceDirectory.tsx` and pure `resource-share-presentation.ts` with shared brand primitives.
- [ ] T045 [US2] Extend `packages/ui/src/collaboration/client.ts` through a focused `organization-client.ts`; wire `SessionAccessControl.tsx`, `ChatCollaboratorsDialog.tsx`, `ProjectSharingDialog.tsx` and `TerminalSharingButton.tsx` to common grants without changing snapshot consent.
- [ ] T046 [US2] Wire thin shell adapters in `shell/src/components/chat/ChatSharing.tsx`, `SharedWithMeNav.tsx`, `projects/ProjectSharing.tsx` and `terminal/TerminalSharing.tsx`; add corresponding tests in `tests/shell/organization-sharing.test.tsx`.
- [ ] T047 [US2] Wire Electron adapters in `desktop/src/renderer/src/features/chat/DesktopChatCollaboration.tsx`, `features/project/DesktopProjectSharing.tsx`, `features/terminal/DesktopTerminalSharing.tsx` and `features/work/WorkRail.tsx`; test in `tests/desktop/organization-sharing.test.tsx`.

## US3 — S10: exact file/folder identities and reads

**Owner:** Resource Sol. **Exit:** exact file versus recursive folder reads, with no sibling/path/symlink leak.

- [ ] T048 [US3] Add failing file/folder, delete/recreate incarnation, private-project containment, symlink/TOCTOU and streamed-revoke tests in `tests/gateway/collaboration-file-boundary.test.ts` and `collaboration-file-read.test.ts`.
- [ ] T049 [US3] Add `resource-catalog.ts` and its migration under `packages/gateway/src/collaboration/`, with non-reused UUIDs/incarnations, unique live owner+normalized-path, parent FK, scope binding, collision rejection, separate containment versus authority-parent relations and permanent grant tombstones as defined in data-model.md.
- [ ] T050 [US3] Implement `file-adapter.ts` and `routes-files.ts` for scope creation/preflight, filtered list/search/metadata/content, using real filesystem drivers with lstat/realpath/no-follow protection and evidence-renewed bounded streams; never expose shared GET presigns.
- [ ] T051 [US3] Extend exact platform proxy/CLI allowlists and registration-time gateway dependencies for file reads in `packages/platform/src/collaboration/proxy.ts`, `packages/gateway/src/collaboration/wiring.ts` and `tests/gateway/collaboration-file-wiring.test.ts`.

## US3 — S11: writes, moves and inherited boundaries

**Owner:** Resource Sol. **Exit:** writes and access-impact transitions are safe under crashes, conflicting edits and revocation.

- [ ] T052 [US3] Add failing upload/revoke, move-preview revision, overwrite, inherited grant writer-fence races, crash-at-every-publication-phase and revocation between staging and publish in `tests/gateway/collaboration-file-write-postgres.test.ts` and `collaboration-file-move.test.ts`.
- [ ] T053 [US3] Implement `file-mutations.ts` and `file-upload-staging.ts`: exclusive/atomic writes, bounded inert uploads, durable prepared/staged/publishing/committed byte-publication journal, fresh final permits/epoch CAS, recovering read fences, hash-verified crash reconciliation and recurring symlink-safe orphan cleanup; never claim SQL commits filesystem bytes atomically.
- [ ] T054 [US3] Implement `resource-move.ts` and generalize `project-membership-transition.ts` for all audience/resource kinds; lock roots in sorted order, show gained/lost access, reconcile child grants, and prevent unconfirmed watcher-inferred moves.
- [ ] T055 [US3] Wire every relevant file writer, agent broker and ordinary file/sync route through the same `project-fence.ts`/catalog admission in `packages/gateway/src/collaboration/project-path-admission.ts` and its production callers; add an explicit bypass inventory test in `tests/gateway/collaboration-writer-fences.test.ts`.

## US3 — S12: app instances and complete production project wiring

**Owner:** Resource Sol. **Exit:** a real mixed project and standalone app work through production routes, not fake adapters.

- [ ] T056 [US3] Add failing instance-isolation, viewer bridge bypass and production route dependency tests in `tests/gateway/collaboration-app-instance.test.ts` and `collaboration-project-production.test.ts`, including existing-install adoption/collisions/reinstall and failed-DDL restart recovery.
- [ ] T057 [US3] Add `app-instances.ts` and its migration under `packages/gateway/src/collaboration/`: stable instance/artifact/version/owner/namespace/readiness, idempotent source-install mapping, reinstall incarnation, DDL-failure recovery and instance-scoped export/delete; stage DDL outside transactions through `packages/gateway/src/app-db-registry.ts` and activate grants only after storage readiness; fence/adopt existing slug-backed data and update its original readers so no second writable personal schema survives sharing.
- [ ] T058 [US3] Implement standalone `app-adapter.ts`/`routes-apps.ts` and actor-aware real bridge integration with `packages/gateway/src/app-db.ts`, scoped view bootstrap/assets and the existing sandbox renderer; deny private slug schemas, generic `/api/bridge/query` bypass and unsupported app capabilities.
- [ ] T059 [US3] Mount existing project file/Git/app/layout/child-Chat/child-Terminal/export routes in extracted gateway `collaboration/routes-project.ts` and instantiate real `project-adapters.ts`, `project-app-adapter.ts` and `project-layout-adapter.ts` drivers in `collaboration/wiring.ts`; keep M4 disabled if any dependency is absent; split instance catalog, standalone bridge and project wiring into sequential small PR layers.
- [ ] T060 [US3] Supply a coordinator-owned production composition patch in `packages/gateway/src/server.ts` and extracted server registration modules: pass real `appRegistry`/`queryEngine`, project/file/Git/agent/canvas/export drivers into `enableSharedProject` and the standalone adapters; test every route through the actual composed server before S12 exits.
- [ ] T061 [US3] Add `tests/gateway/collaboration-project-app-postgres.test.ts` and production-bundle filesystem/agent integration in `tests/e2e/organization-project.spec.ts`; prove app mutation and ACL recheck share the actual transaction and future children inherit org/group access.

## US6 — S13: managed Matrix-backed group communication

**Owner:** Matrix Sol. **Exit:** service-only private rooms; no direct human-token bypass.

- [ ] T062 [US6] Add failing idempotent Space/room creation, service power-level, hierarchy, org-scoped service credential rotation/revocation and partition tests in `tests/platform/organization-matrix-room-client.test.ts` and `organization-matrix-revocation.test.ts`.
- [ ] T063 [US6] Implement `packages/platform/src/organization-matrix/service-identity.ts` and its migration with one service MXID per org, secret-manager references, versioned rotation, old-session revocation and disabled-on-unknown outcome; prove no reuse of `matrix_users` human/AI credentials.
- [ ] T064 [US6] Implement `packages/platform/src/organization-matrix/room-client.ts` and `repository.ts` with private non-federated joined-history rooms, service-only membership/state/invite powers, bounded timeouts and secret references; never reuse trusted-private DM provisioning.
- [ ] T065 [US6] Implement `reconciler.ts` and `outbox-worker.ts` in that module, using unique org/group bindings, generation-aware retries, archive/retention/leave-forget decommissioning and secret cleanup; missing ready enforcement leaves communication unavailable.
- [ ] T066 [US6] Implement authenticated text-only `routes.ts` and stream delivery through current org/group evidence; server-derive actor attribution, paginate history, dedupe sends, filter event types and expose no Matrix tokens/room/media capabilities; add `tests/platform/organization-matrix-routes.test.ts` for attribution spoofing, idempotent sends, pagination, m.text-only filtering, quiet expiry, reconnect and Synapse failures.
- [ ] T067 [US6] Register startup/shutdown and rerun the S00 live boundary probe against the produced service in `scripts/spikes/organizations/matrix-room-boundary-probe.ts`; record that direct Matrix-client membership remains unsupported.

## US3 — S14: legacy sync grant reconciliation

**Owner:** Sync Sol. **Exit:** legacy metadata imports without creating unintended prefix access.

- [ ] T068 [US3] Add failing legacy viewer/editor/admin ceilings, handle ambiguity, absent path and restart migration tests in `tests/gateway/sync/share-migration-postgres.test.ts`.
- [ ] T069 [US3] Implement `packages/gateway/src/sync/share-migration.ts` and source-ID idempotent mapping: resolve immutable owner/grantee, exact file/folder incarnation and scope, preserve acceptance/expiry, and keep imports dormant until the shared data plane is ready.
- [ ] T070 [US3] Convert `sync/sharing.ts` and `sharing-db.ts` into compatibility adapters to the unified grants; block ambiguous conflicts with an owner-visible migration report and never maintain a second allow path after cutover.
- [ ] T071 [US3] Update `specs/066-file-sync/spec.md` and `follow-ups.md` with the actual get/put/delete legacy semantics and the new staged activation/rollback plan, preserving honest F19 status until S16 passes.

## US3 — S15: shared sync gateway data plane

**Owner:** Sync Sol. **Exit:** scoped manifests/read/write/realtime across distinct accounts under real database races.

- [ ] T072 [US3] Add real-Postgres manifest/revoke/commit/multipart/action-ceiling tests in `tests/gateway/sync/shared-data-plane-postgres.test.ts`; include expired long-lived upload URLs and viewer delete attempts.
- [ ] T073 [US3] Extract focused shared handlers from `packages/gateway/src/sync/routes.ts` into `shared-routes.ts`; server-resolve owner/catalog ancestry for manifest and mediated read operations, leaving existing personal namespace behavior intact.
- [ ] T074 [US3] Implement inert shared upload/multipart staging and commit-time grant/resource/manifest/epoch checks in `packages/gateway/src/sync/shared-commit.ts`; no presigned PUT may overwrite a currently authoritative key.
- [ ] T075 [US3] Extend `packages/gateway/src/sync/ws-events.ts` with scope/grant-indexed subscriptions, current-evidence batch checks, failed-send eviction, stale sweeps, revoke close and shutdown drain; test in `tests/gateway/sync/shared-events.test.ts`.

## US3 — S16: daemon mounts and file CLI

**Owner:** Sync Sol. **Exit:** invite/org discovery→mount→edit→revoke preserves local bytes and stops future sync.

- [ ] T076 [US3] Add failing scoped-mount/event/reconnect/revoked-queued-write tests in `packages/sync-client/tests/unit/shared-mounts.test.ts` and `tests/cli/collaboration-files.test.ts`.
- [ ] T077 [US3] Add `packages/sync-client/src/daemon/shared-mounts.ts`, wire its transport/event/scan callers, and persist owner/scope/resource incarnation; prohibit cross-share path traversal and silent parent mounting.
- [ ] T078 [US3] Add explicit shared read/staged upload/commit transport to the daemon; cancel retries/watchers on revoke, retain already-local copies with revoked status, and require fresh authorization after reconnect in `packages/sync-client/src/daemon/shared-transfer.ts`.
- [ ] T079 [US3] Add file/folder share/mount/unmount commands in `packages/sync-client/src/cli/commands/resource-sharing.ts`, exact route allowlists and safe errors; complete `tests/e2e/organization-sync.spec.ts` before activating dormant imported grants.

## US4 — S17: typed runtime ownership and routing

**Owner:** Platform Sol. **Exit:** an org is a durable owner, never a fake user or preview invite list.

- [ ] T080 [US4] Add failing owner backfill/collision/slot uniqueness/member routing and creator-removal tests in `tests/platform/organization-runtime-ownership-postgres.test.ts` and `organization-runtime-routing.test.ts`.
- [ ] T081 [US4] Extend the extracted runtime schema/queries under `packages/platform/src/database/` with owner_type/id, created_by_actor_id and unique owner+slot; additive personal backfill and nullable legacy Clerk user compatibility only.
- [ ] T082 [US4] Add `packages/platform/src/organizations/runtime-access.ts` and route selected org context through `session-routing-identity.ts`, `app-session-routes.ts`, `computer-routes.ts` and WS/session middleware; members receive only permitted resource access, admins receive audited org administration.
- [ ] T083 [US4] Update `packages/platform/src/collaboration/bootstrap.ts` runtime authentication/routing and gateway typed owner configuration without exposing owner tokens; test expired org evidence with an otherwise valid 24-hour sync JWT, members without personal runtimes, and explicit denial of generic owner-home/files/terminal/bridge routes. Admin shell access requires a separate expiring audited capability.

## US4 — S18: org provisioning, backups and recovery

**Owner:** Platform Sol. **Exit:** typed provisioning/storage/recovery works with injected test entitlements; production admission remains unavailable until the S19 billing join.

- [ ] T084 [US4] Add failing concurrent provision, billing-unavailable, Cloud-init identity, V1/V2 backup metadata and recovery tests in `tests/platform/organization-vps-provision.test.ts` and `organization-vps-recovery.test.ts`.
- [ ] T085 [US4] Generalize extracted `customer-vps/` provision locks, labels, schema and runtime env to typed owner; add admin org runtime create/status APIs without a fake clerkUserId in `organizations/runtime-routes.ts` and `customer-vps-schema.ts`.
- [ ] T086 [US4] Version owner metadata and backup prefixes in `packages/platform/src/customer-vps-r2.ts` and recovery consumers; preserve V1 personal reads and ensure org namespaces derive only from immutable org ownership.
- [ ] T087 [US4] Add export/recovery access during suspended billing and staged org deletion in `organizations/runtime-lifecycle.ts`; preserve `$MATRIX_HOME`, prevent automatic deletion from Clerk events, and test restart cleanup/shutdown through the real provision wiring.

## US5 — S19: Stripe payer accounts and org billing administration

**Owner:** Billing Sol. **Exit:** personal billing unchanged; org admin controls an independent payer through sandbox-tested flows.

- [ ] T088 [US5] Add failing personal backfill/admin replacement/forged payer/concurrent checkout/duplicate and reordered webhook tests in `tests/platform/organization-billing-postgres.test.ts` and `organization-billing-routes.test.ts`.
- [ ] T089 [US5] Add payer accounts, sponsorship/checkout claims and subscription/entitlement bindings under extracted `packages/platform/src/database/` and `billing/`; backfill every table/consumer in data-model.md’s billing migration inventory (including prebilling/trial/override/status/runtime-action/credit paths), without changing personal Stripe customers or granting orgs an admin’s trial/override.
- [ ] T090 [US5] Implement org status/checkout/portal/invoice/usage handlers in `packages/platform/src/organizations/billing-routes.ts`; server-resolve org customer and catalog, require fresh admin billing capability, and keep checkout unavailable without approved org price configuration.
- [ ] T091 [US5] Extend `packages/platform/src/stripe-billing.ts` and extracted webhook projection with immutable payer/owner/actor metadata, receipt transaction and monotonic cursor; unknown mappings remain recoverable and cannot charge a default personal customer.
- [ ] T092 [US5] Update `billing-entitlement-resolver.ts` and `billing-runtime-actions.ts` to target the correct sponsor; test payment/grace/cancel/refund scope, export access and no auto-adoption of existing personal subscriptions; join with S18 only after both land to prove paid org provisioning requires its own current entitlement.

## US4 — S20: explicit ownership transfer and lifecycle

**Owner:** Resource Sol. **Exit:** each supported resource moves once to org authority, with no credentials or dual writers.

- [ ] T093 [US4] Add crash-at-every-phase, changing inventory, revoked target admin, payer-unchanged and creator-departure tests in `tests/gateway/collaboration-owner-transfer-postgres.test.ts`.
- [ ] T094 [US4] Implement `packages/gateway/src/collaboration/owner-transfer.ts` and exact transfer routes using existing `project-transition.ts`/`project-fence.ts` journals: target admin consent, staged data, final generation/CAS and labeled inaccessible source backup.
- [ ] T095 [US4] Supply Chat/app/file/folder/project transfer and export drivers; update `project-membership-transition.ts` for every grant audience and instance/catalog binding, preserving private drafts and immutable harness binding while rejecting unsupported execution migration.
- [ ] T096 [US4] Wire platform directory cutover/operation hydration and recover/delete/archive paths; add `tests/e2e/organization-owner-departure.spec.ts` proving only the durable org runtime stays authoritative after the creator leaves.

## US5 — S21: sponsored AI, add-on credits and attribution

**Owner:** Billing Sol. **Exit:** a collaborator's run names actor/resource owner/runtime owner/payer and reserves only the approved budget.

- [ ] T097 [US5] Add failing spoofed sponsorship, removed actor, expired proof, competing reserve/settle/refund and no-fallback tests in `tests/platform/organization-funded-ai-postgres.test.ts` and `tests/gateway/organization-shared-ai.test.ts`.
- [ ] T098 [US5] Version `packages/contracts/src/funded-ai.ts` identity/proof and extracted funded tables/queries to include typed runtime owner, payer account, actor/resource scope and immutable sponsorship revision; preserve personal credential compatibility.
- [ ] T099 [US5] Implement sponsorship consent/revoke and signed execution claims in `packages/platform/src/organizations/sponsorships.ts`; validate membership, a signed owner-gateway consent receipt (not admin/client assertion), admin budget policy and exact machine/request binding before atomic reservation.
- [ ] T100 [US5] Wire `ai-funded-policy-repository.ts`, `ai-funded-policy-routes.ts`, extracted funded metering, `ai-credit-checkout-store.ts`, gateway `funded-ai-credential-manager.ts` and collaboration execution/broker paths; sharing alone never selects the org payer.
- [ ] T101 [US5] Extend Stripe add-on/refund/dispute projection for org balances and add a sandbox end-to-end ledger test in `tests/e2e/organization-billing.spec.ts`, proving single attribution across retries, settlement against the originally captured payer after sponsorship changes, and no personal-key/payment fallback.

## US3/US4/US5/US6 — S22: app/file sharing and org administration surfaces

**Owner:** UI Sol. **Exit:** equivalent Web Canvas/Web Desktop/Electron controls and state semantics using shared components.

- [ ] T102 [US4] Add failing privacy/admin actions/unknown-error/unavailable-payer/Matrix-group UI tests in `tests/ui/organization-settings.test.tsx`, `tests/shell/organization-resources.test.tsx` and `tests/desktop/organization-resources.test.tsx`; extend existing `tests/shell/file-browser-privacy.test.tsx`, `tests/desktop/files-workspace.test.tsx`, `app-launcher.test.tsx` and settings entrypoint tests for selection/protected paths/instance resolution.
- [ ] T103 [US4] Add shared `packages/ui/src/organizations/OrganizationSettings.tsx`, `GroupSettings.tsx`, `SharedResources.tsx` and `OrganizationBilling.tsx` with stable selectors, server capability flags, pagination, safe errors and explicit owner/payer/transfer states.
- [ ] T104 [US3] Add single-selection Share entrypoints in `shell/src/components/file-browser/FileContextMenu.tsx` and `AppTile.tsx`, plus Electron `features/files/ComputerFileBrowser.tsx` and `features/embeds/AppLauncher.tsx`; resolve app instance IDs, never slugs as shared authority.
- [ ] T105 [US4] Mount shared org settings/inventory/transfer controls in `shell/src/components/Settings.tsx` and `desktop/src/renderer/src/features/settings/SettingsView.tsx`, with ordinary shared resource opening/deep links for app/file/folder; retain parent-project boundaries.
- [ ] T106 [US6] Add text group conversation rendering/client under `packages/ui/src/organizations/` using S13 routes; show unavailable/reconnecting explicitly, and never expose direct Matrix room credentials/links or duplicate canonical AI Chat history.
- [ ] T107 [US5] Integrate admin billing/usage/sponsorship views with existing billing components and brand primitives; capture grant/remove/transfer/failed-payment/remaining-access states in `specs/124-organization-collaboration/evidence/web-electron/README.md`.

## Cross-surface — S23: Native Mobile and CLI parity

**Owner:** Surfaces Sol. **Exit:** applicable native/CLI capabilities match the same contracts and rights.

- [ ] T108 [US2] Add failing share/discovery/app/file/admin transport tests in `apps/mobile/__tests__/organization-sharing.test.tsx` and `requests-organizations.test.ts`, retaining current shared-screen/terminal/project coverage.
- [ ] T109 [US2] Extract discovery/session orchestration from `apps/mobile/app/(drawer)/shared.tsx` into focused components; extend `apps/mobile/lib/requests/collaboration.ts` with `requests/organizations.ts` and common presentation derivations without importing DOM components.
- [ ] T110 [US3] Add native share sheets/file/app actions and resource opening in `apps/mobile/components/collaboration/ResourceShareSheet.tsx`, `apps/mobile/app/(drawer)/files.tsx`, `apps/mobile/app/(drawer)/apps.tsx`, `apps/mobile/app/app-preview/[app].tsx`, `apps/mobile/app/file-browser/file.tsx` and stable-ID shared-resource routes; scope invitations/deep links safely after account/org switches.
- [ ] T111 [US4] Add native org/group/inventory/billing controls in `apps/mobile/components/settings/OrganizationSettings.tsx` and the existing `SettingsSurface.tsx`, `apps/mobile/app/(drawer)/_layout.tsx` and `apps/mobile/components/shell/DrawerContent.tsx`; hosted Clerk/Stripe flows return to a freshly revalidated org context.
- [ ] T112 [US2] Extract org/grant/inventory commands into `packages/sync-client/src/cli/commands/organizations.ts`, register them as subcommands of the existing collaboration command in `packages/sync-client/src/cli/index.ts` (no new top-level command), preserve strict endpoint allowlists and add `tests/cli/collaboration-organization.test.ts`.
- [ ] T113 [US6] Implement `apps/mobile/components/organizations/GroupConversationScreen.tsx` and `apps/mobile/__tests__/organization-group.test.tsx` using the same mediated text/expiry contracts; record Web Mobile and Expo dev-client evidence in `specs/124-organization-collaboration/evidence/mobile-cli/README.md`.

- [ ] T114 [US6] Add CLI group send/history/watch in `packages/sync-client/src/cli/commands/organization-groups.ts` and `tests/cli/organization-groups.test.ts`: exact group messages/events allowlist, one-use WS ticket, expiry/reconnect/current-role checks and safe output.

## Final — S24: release acceptance, migration, documentation

**Owner:** Integration Sol/coordinator. **Exit:** every enabled capability has current-head evidence; full product claim only after all stories pass.

- [ ] T115 Add a shared admin/two-members/outsider/guest fixture and complete all five requested resource journeys plus terminal regression in `tests/e2e/fixtures/organizations.ts` and `tests/e2e/organization-collaboration.spec.ts`; include more than eight org members without direct-invite fanout.
- [ ] T116 Run real-Postgres race/migration/restart suites and mixed-version binary rejection, plus the provider/Matrix probes, using `specs/124-organization-collaboration/quickstart.md`; record exact commands/head/results and no skipped required tests in `implementation-log.md`.
- [ ] T117 Wire documented capability flags, readiness/health metrics, secret references and worker drains into `packages/platform/src/platform-startup.ts`, gateway registration and relevant VPS env templates; test registration-time dependencies and production bundle config in `tests/platform/organization-deployment.test.ts`.
- [ ] T118 Record per-surface acceptance for Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile and CLI in `specs/124-organization-collaboration/evidence/README.md`; production-like validation uses disposable VPS-native hosts, exact bundles and scoped reviewed handles.
- [ ] T119 Reconcile scope/authority/billing statements in `specs/058-app-gallery/spec.md`, `specs/066-file-sync/spec.md`, `specs/084-stripe-runtime-plans/spec.md`, `specs/118-ai-gateway-provider-auth/spec.md`, `specs/121-collaboration-session-sharing/spec.md` and `specs/525-collaboration-ux-redesign/spec.md`; do not mark unfinished legacy tasks complete without evidence.
- [ ] T120 Create a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` describing sharing boundaries, org ownership/admin billing, revocation limitations and managed Matrix groups; record its URL in `specs/124-organization-collaboration/implementation-log.md`.
- [ ] T121 Complete the three-pass review, current-head Greptile 5/5, proactive `ready-for-ci`, required CI and release/rollback evidence for each stack layer; record approved activation and cleanup outcomes in `specs/124-organization-collaboration/implementation-log.md` without merging or deploying merely because tests pass.

## Dependencies and parallel work

Use the plan's S-packet DAG as the source of truth. Within a packet, tests precede their implementation and later checkboxes depend on earlier contracts. `[P]` is limited to genuinely independent probes; other parallelism is at packet boundaries with disjoint file ownership.

- First wave: S01 Platform extraction, S02 Gateway extraction, S03 Contracts after S00. The coordinator owns common exports/composition patches.
- After S03: S04 and S06 can proceed on separate packages. S05 follows S04. S07 joins all three.
- After S07: S08 discovery, S10 resource reads, S17 runtime ownership can proceed concurrently. S13 Matrix can replace a completed lane; it does not edit collaboration grant internals.
- S09 UI may use finalized S08 APIs while S10/S11 progress. S12, S14 and S20 share catalog/transition seams and are serialized when their write sets intersect.
- Billing S19/S21 follows runtime ownership; UI S22 waits for actual endpoints. Native S23 follows stable shared behavior. S24 joins all lanes.

## Graphite Stack Plan

Use manual persistent worktrees, Graphite for stacked branch operations, Conventional Commit titles and the mandatory invariants section. Initialize/authenticate Graphite before stack operations; do not flatten layers. Prefer under 1,000 additions/20 files; split before 3,000/50. Each extraction family in S01 and each gateway/app/sync sublayer that exceeds limits gets its own layer with the same task receipt, not an oversized PR.

| Stack | Layers / proposed title scope | Join points |
| --- | --- | --- |
| Foundation | S00 `test(organizations)`; S01 `refactor(platform)` in bounded domain slices; S02 `refactor(collaboration)`; S03 `feat(contracts)` | S04 and S06 branch from their required merged/stacked dependencies |
| Org access | S04 Clerk → S05 management → S06 grants join → S07 revocation → S08 discovery → S09 UI | S07 is the access gate for every resource/runtime/Matrix path |
| Resources | S10 reads → S11 writes → S12 apps/project → S14 sync migration → S15 gateway sync → S16 daemon | S20 joins S12 with durable runtime S18 and entitlement S19 |
| Org runtime/billing | S17 owner/routing → parallel S18 provision groundwork + S19 Stripe → S20 transfer join → S21 funded AI | S19 may prepare schema/tests in parallel, but activation waits for sponsor/runtime authority |
| Matrix | S13 room primitives → mediated text/revocation evidence | Depends S05/S07; no direct-member fallback |
| Surfaces/release | S22 shared UI → S23 native/CLI → S24 acceptance/ops; separate site-docs PR | All backend lanes required for full release |

Graphite has one parent per branch: wait for prerequisite joins to merge or have the coordinator restack/cherry-pick the reviewed prerequisite commits in order. A worker must never pretend a multi-parent task DAG is already present in its checkout. Every packet receipt names exact prerequisite SHAs.
