# Sol implementation tasks — revised direct architecture

**Status:** all implementation tasks pending. This ledger replaces the previous 121-task S00–S24 ledger; old IDs must not be used to dispatch work. No agents were dispatched by this spec revision.

Use `gpt-5.6-sol` with high reasoning, one coordinator and at most three workers. Each packet owns the files named below; coordinator owns shared composition/exports/package manifests. Paths not present at baseline are proposed new focused modules; integrate with equivalent existing seams rather than duplicate them. Before code changes read constitution/applicable instructions and write failing behavioral tests. Do not revert other workers; do not parallelize overlapping files. All packets join one coordinated release, not independent partial product launches.

## S00 — Baseline and live boundary probes

**Owner:** Coordinator. **Depends on:** None. **Exit:** Versioned evidence establishes the allowed execution/auth modes and direct host eligibility.

- [ ] T001 Inspect current main and record baseline SHA plus changed seams in research.md. Confirm canonical Chat roots, shared adapter limitations, endpoint wiring, provider V3 and connector custody; do not infer that source presence means deployed support.
- [ ] T002 Add failing probe harnesses in tests/integration/collaboration-provider-boundaries.test.ts for Codex/Claude API execution, native owner subscription eligibility (owner-only versus delegated requests), owner source/root change resume, tool/approval/cancel semantics and worktree isolation. Record exact versions/auth modes and real outcomes in evidence/providers.md; never store tokens.
- [ ] T003 Add tests/integration/collaboration-authority-boundaries.test.ts for Clerk direct role changes, lost webhooks, API consistency, clock skew and partition expiry. Freeze supported custom permission mapping and measured removal bound in contracts/organization-api.md.
- [ ] T004 Add direct TLS/Origin/WS reachability and sandbox mount/Git-object/credential escape probes in tests/integration/collaboration-direct-boundaries.test.ts. Record browser/Electron/native endpoints and required supervisor facilities in evidence/direct.md.
- [ ] T005 Inventory existing connection providers: credential storage, execution host, OAuth migration eligibility and vendor-hosted exceptions. Record per-mode supported/unavailable/reconnect-needed decisions in research.md; missing live evidence is an open gate, not a pass.

## S01 — Extract large composition seams

**Owner:** Foundation Sol. **Depends on:** S00. **Exit:** Behavior preserved and focused seams exist before new behavior.

- [ ] T006 Add characterization tests for platform DB migration exports, collaboration route registration, personal billing and shared queue behavior in tests/platform/collaboration-foundation.test.ts and tests/gateway/collaboration-foundation.test.ts.
- [ ] T007 Extract affected platform schema/query registration from packages/platform/src/db.ts into focused database/ modules and billing route handlers from billing-routes.ts into billing/ modules. Preserve runtime behavior and current migrations; no new ACL behavior here.
- [ ] T008 Extract packages/gateway/src/collaboration/routes.ts, repository.ts and database.ts into resource-route, grant/lifecycle repository and migration modules before adding capabilities. Preserve transaction scopes and tested exports.
- [ ] T009 Supply coordinator-only registration/export patches; run existing collaboration, customer-VPS and billing characterization suites. Record file ownership and refactor evidence before dependent branches.

## S02 — Freeze shared wire contracts

**Owner:** Contracts Sol. **Depends on:** S00,S01,S20. **Exit:** All consumers use one versioned direct/policy/funding protocol.

- [ ] T010 Add failing strict-schema and serialization tests in tests/contracts/collaboration-direct.test.ts, collaboration-capabilities.test.ts and collaboration-execution.test.ts, covering forged owners/endpoints/payers, selectors, unknown actions and replay fields.
- [ ] T011 Create packages/contracts/src/collaboration-direct.ts, collaboration-capabilities.ts and collaboration-peer.ts for tickets/sessions/control epochs, exact peer operations, selectors/presets/ceilings/denies and safe readiness/errors. Expand combined route-table rows into exact method/path schemas.
- [ ] T012 Create packages/contracts/src/organization-billing.ts and collaboration-execution.ts for quotes/assignments, immutable run account-payer bindings, task profiles and connection delegation. Extend canonical Chat/root and V3 types without introducing competing stores.
- [ ] T013 Freeze Clerk custom permissions and resource capability vocabulary with identity/runtime/billing owners. Define role preset expansion and old-role migration matrix with exact action ceilings. Freeze the default group Chat, owner-selected source and owner-only Git approval rules. Audiences are organization, group, or a current member/guest of the resource's organization only; there is no personal audience, departure-surviving grant, milestone or cohort field. Participant account routing and copy-and-continue are deferred.
- [ ] T014 Give coordinator index.ts exports and package dependency changes; verify package consumers and schemas compile. Update contracts/organization-api.md with final concrete payload unions and version negotiation.

## S03 — Clerk roles and control authority

**Owner:** Identity Sol. **Depends on:** S02. **Exit:** Current membership/permissions reach enrolled homes within tested fixed leases.

- [ ] T015 Write failing real-Postgres tests in tests/platform/organization-authority-postgres.test.ts for duplicate/reordered webhook, last-owner, unknown-role, remove/rejoin, guests, group membership, concurrent command and outage cases.
- [ ] T016 Implement packages/platform/src/organizations/{database,repository,commands,clerk-resolver,roles}.ts with configured custom permissions, verified inbox/outbox, tombstones, fixed-deadline upstream evidence and reconciliation. Clerk remains membership source of truth.
- [ ] T017 Implement control generations/denial fences and batched active-actor assertions in packages/platform/src/collaboration/control-authority.ts. Never renew evidence from receipt time or trust selected org as membership.
- [ ] T018 Implement org/group/guest/member routes from the contract with per-action permission checks, body limits, Origin checks, safe errors and audited idempotency. Keep membership mutations separate from billing effects.
- [ ] T019 Prove platform revocation completes only after home acknowledgement or lease expiration. Add bounded caches, coalescing, recurring reconciliation, outbox retry/dead-letter and shutdown drains; record provider freshness evidence.

## S04 — Local granular authority

**Owner:** Authority Sol. **Depends on:** S02. **Exit:** The same deny-wins policy controls all resource and execution paths.

- [ ] T020 Write failing tests/gateway/collaboration-capabilities-postgres.test.ts covering conflicting user/org/group grants, parent ceilings, narrow children, moves, direct-grant departure, legacy ceilings and races.
- [ ] T021 Implement collaboration/{capability-repository,capability-evaluator,policy-migrations}.ts and extend authority.ts. Support action/resource selectors, presets, restrictions, expiry and explicit management; no implicit editor funding or admin content privilege.
- [ ] T022 Implement collaboration/{chat-audience-policy,artifact-publication-policy}.ts: audience data ceiling, historical Chat share preflight, policy-narrowing session invalidation and explicit restricted-to-broad publication. Test hidden tool results/history/search/attachments and output laundering.
- [ ] T023 Implement collaboration/access-requests.ts and readiness evaluator for exact missing capabilities and designated approvers. Approval grants only reviewed scoped actions and revision, never broad role escalation.
- [ ] T024 Wire evaluator into resource grant mutations and local epoch fences; prove conditional writes, audit/outbox atomicity, safe effective-access reasons and no permissive fallback on policy lookup failure.

## S05 — Direct endpoints, tickets and revocation

**Owner:** Transport Sol. **Depends on:** S03,S04. **Exit:** Enrolled homes authenticate direct clients/peers without platform content proxying.

- [ ] T025 Write tests/platform/collaboration-tickets.test.ts and tests/gateway/collaboration-direct-sessions.test.ts for audience/key/nonce tampering, ticket reuse, Origin, stale generation, endpoint forgery, unknown signing key and old protocol rejection.
- [ ] T026 Implement platform collaboration/{runtime-endpoints,ticket-issuer,control-stream}.ts with asymmetric enrollment, exact registered TLS origin verification, SSRF-safe endpoint probes, signed actor/device/purpose binding and rotation. Metadata only.
- [ ] T027 Implement gateway collaboration/{direct-auth,direct-sessions,control-client,direct-websocket}.ts with proof-of-possession, single-use ticket exchange, scoped HTTP/WS authorization and fixed-expiry control snapshots. Reuse local authority, not owner cookie authentication.
- [ ] T028 Integrate expiry/fence checks before input/output batches, queue claims and publication; terminate denied isolated processes/control leases. Add replay limits, slow-reader bounds, quotas and shutdown drains.
- [ ] T029 Run two-home + partition wiring tests in tests/e2e/collaboration-direct-transport.spec.ts. Prove no per-frame/chunk platform authorization call, no lease extension on reconnect and no generic owner endpoint reachable by collaborator.

## S06 — Direct clients and resource discovery

**Owner:** Client Sol. **Depends on:** S05. **Exit:** Every client request reaches the discovered resource home with scoped auth.

- [ ] T030 Add tests for resource-home versus selected-computer routing, endpoint generation changes, offline states, refresh failure and safe errors in tests/ui/collaboration-direct-client.test.ts.
- [ ] T031 Implement shared transport in packages/ui/src/collaboration/direct-client.ts with ticket exchange, signed requests, WS ticket handshake, session renewal and reconnection. Native/CLI transport adapters consume the same protocol and derivations.
- [ ] T032 Change platform collaboration discovery to metadata-only projections and safe org inventory. Clients hydrate content from the home; do not make platform hydration fetch full resource data.
- [ ] T033 Wire shell and desktop collaboration clients, event streams, terminal attach, download/upload and sandboxed app origins through direct transport. Coordinator applies CSP/query-ticket allowlist/composition patches.
- [ ] T034 Run browser and Electron cross-origin/session/logout tests; verify no reusable token leaks in referrers/logs, no fallback to platform forwarding and no stale resource content on computer switch.

## S07 — Execution sandbox and task policies

**Owner:** Runtime Sol. **Depends on:** S04,S05. **Exit:** Commands/tools cannot escape the granted data, network or credential boundary.

- [ ] T035 Write tests/scope-runtime/collaboration-policy-boundary.test.ts and disposable-host tests for symlink/hardlink escape, Git object/history leakage, subprocess/interpreter escape, proc/environment secrets, broker forgery and denied network.
- [ ] T036 Extend packages/scope-runtime/ supervisor/profile/protocol seams and gateway collaboration/scope-runtime-client.ts with actor/scope/worktree mount manifests, isolated UID/process namespaces, resource caps and restricted network. No changes based only on prompt instructions.
- [ ] T037 Implement gateway collaboration/{task-profiles,filtered-workspace,publication-broker}.ts for typed task commands, bounded arguments/cwd/env, restricted Git mediation and staged patch publication with ref/revision/visibility fences.
- [ ] T038 Extend terminal adapter/control/dispatcher for sandbox-only terminal sessions and exact task profile capability. Arbitrary sandbox shell is explicit and cannot imply unrestricted host shell or connection secrets.
- [ ] T039 Prove revocation stops new tools/terminal input and terminates isolated processes on lease loss. Expose unsupported profiles through readiness, with dependency/access requests rather than silent wider mounts.

## S08 — Single owner source and run funding

**Owner:** AI Source Sol. **Depends on:** S02,S04. **Exit:** All permitted participants use one explicitly configured eligible owner source; no participant account onboarding required.

- [ ] T040 Write tests/gateway/collaboration-owner-source.test.ts for multiple actors/one source, owner-only subscription mode, eligible delegated API mode, unsupported delegation, exhausted source, source change while queued and attempted participant account override.
- [ ] T041 Implement collaboration/{execution-policy,run-account-binding,account-eligibility}.ts using AiProviderSnapshotV3. Store one selected project owner binding and pin requesting actor, executing owner, source/model/payer/policy/audience/root per run; validate stale policy before dispatch.
- [ ] T042 Reuse existing owner provider/account setup and native sign-in only for verified modes. Expose owner setup/readiness and explicit owner-only versus delegated submission state. Do not create participant profile stores, login flows, automatic account routing or copy OAuth tokens.
- [ ] T043 Implement explicit owner-funded eligible API/business/Matrix AI source and optional org sponsorship with configured models/budget. Owner consent cannot waive provider eligibility. A participant proposal is discussion, not a hidden execution request in subscription owner-only mode; no silent source/card fallback.
- [ ] T044 Bind one project/Chat provider session to owner source/harness/root/audience generation, never the owner's private session. Owner source changes start fresh authorized continuation unless proven safe. Account selection in existing owner settings is reused; participant multi-account support stays in future scope.

## S09 — Shared Codex and Claude execution

**Owner:** AI Execution Sol. **Depends on:** S07,S08. **Exit:** Both harnesses execute shared authorized work with attributable queues and tool events.

- [ ] T045 Write tests/gateway/shared-coding-execution.test.ts against canonical Chat queue/run state for concurrent humans, cancellation, approvals, resume isolation, unsupported modes, edits after revoke and partial provider failures.
- [ ] T046 Replace the standalone-text-only implementation in collaboration/scope-runtime-chat-adapter.ts with focused shared-codex-adapter.ts and shared-claude-adapter.ts behind the canonical provider contract. Reuse chat/coding-provider-adapter.ts seams where safe; preserve immutable harness binding.
- [ ] T047 Extend shared-ai-runtime.ts, shared-ai-runtime-registry.ts and shared-execution-coordinator.ts for account/root/policy-bound execution, authorized history materialization and sandbox tool events. Never import the owner’s private provider state into the shared session.
- [ ] T048 Wire queue claims and broker side effects through current authority/F bindings; serialize one active run per Chat, retain independent Chat concurrency with host/account limits. Persist initiating actor and exact approval/cancel actor. Shared discussion never implicitly invokes AI; enforce owner-only subscription versus eligible delegated submission mode.
- [ ] T049 Run versioned real Codex/Claude API-backed shared run probes with approved test credentials and costs; record unsupported native-source modes explicitly. Capability flags become true only for observed supported paths.

## S10 — Chat worktrees and Git concurrency

**Owner:** Worktree Sol. **Depends on:** S09. **Exit:** Multiple shared Chats use distinct roots safely with visible state and recoverable leases.

- [ ] T050 Write tests/gateway/shared-chat-worktrees-postgres.test.ts for two Chats/two worktrees, shared Chat viewers, same-root competing writers, stale fingerprint, merge conflict, restart lease recovery and deletion during active run.
- [ ] T051 Extend chat/execution-root.ts, worktree-manager.ts and focused collaboration/worktree-leases.ts with project capability-aware resolution, durable fencing tokens, safe explicit reuse and protected main. Use canonical executionRoot fields.
- [ ] T052 Implement direct worktree routes and collaboration/{project-git-operations,project-git-broker}.ts for contributor proposals and owner-approved exact commit/merge/push/PR operations. Pin tree/ref/remote digest, configured owner Git identity, one-use expiry and requestor/approver audit. Forge credentials stay in broker; deny git/gh/MCP/shell bypass and reconcile ambiguous PR creation before retry. Filtered workers never get raw .git.
- [ ] T053 Add shared Chat worktree/branch/status/restore controls under packages/ui/src/collaboration/. Default project group Chat/root creation is idempotent; joining reuses it without a new worktree. Additional coding Chats may create worktrees. Show owner Git setup/approval, missing-root/offline/lease-conflict states.
- [ ] T054 Prove cleanup retains dirty worktrees and checks active runs/terminals plus merge state; no Chat-delete cascade removes uncommitted work. Validate concurrent Codex and Claude Chats under the same owner source and source-change continuation on pinned roots. Test non-owner commit/push/PR rejection and preserve imported Git authorship.

## S11 — Local and peer integration delegation

**Owner:** Integration Sol. **Depends on:** S07,S08. **Exit:** Exact connection actions run with scoped credentials outside the platform content path.

- [ ] T055 Write tests/gateway/collaboration-integration-delegation.test.ts for connection-owner consent, tool/upstream scopes, read versus send/delete, approval races, revoked credentials, output audience and ambiguous remote effects.
- [ ] T056 Implement integrations/{local-credential-store,delegated-action-broker,connection-policy}.ts reusing custom-mcp client/schema/SSRF protections. Encrypt secrets locally; sandbox agents receive capabilities, never raw tokens or unrestricted MCP endpoints.
- [ ] T057 Add local and peer connection-action routes with exact connection/actor/project/tool/resource binding. Reauthorize after queued approval and before invocation; use upstream idempotency where supported and uncertain-outcome state otherwise.
- [ ] T058 Migrate direct-capable custom MCP execution/custody from platform-backed paths using S00 inventory and explicit connection-owner consent or reconnect. Document vendor-hosted exceptions and block unsupported fine-grained delegation instead of pretending scopes exist.
- [ ] T059 Wire app bridge/agent tool discovery/readiness/approval UI to the same action policy. Prove hidden integration results cannot enter broader Chat history and direct shell/network paths cannot bypass the broker.

## S12 — Direct resource adapters and sync

**Owner:** Resource Sol. **Depends on:** S06,S07. **Exit:** Apps/files/projects/sync enforce identical granular grants on the home computer.

- [ ] T060 Write tests/gateway/direct-resource-policy-postgres.test.ts for file/folder identity, renamed/deleted incarnations, narrow app actions, parent ceilings, exports/search/thumbnails and simultaneous policy change/upload commit.
- [ ] T061 Implement collaboration/resource-catalog.ts and production file/project/app routes using project-adapters.ts/project-app-adapter.ts, local owner namespaces and stable app instance IDs. No allowlisted-but-unmounted project endpoints.
- [ ] T062 Implement direct streaming reads, staged uploads, multipart/resume, immutable checksums and final fresh commit. Do not issue reusable shared storage GET URLs; cancel on revoked leases and clean inert staging.
- [ ] T063 Extend packages/sync-client shared transfer and CLI mounts to direct scoped endpoints; import sync grants into the single authority with exact legacy action ceilings. Personal sync remains its own non-collaboration operation.
- [ ] T064 Wire app sandbox assets and action-specific bridges to scoped direct sessions. Prove viewer/limited app users cannot mutate through alternate HTTP/network/bridge paths and all applicable surfaces use the same selectors.

## S13 — Computer-to-computer migration and recovery

**Owner:** Transfer Sol. **Depends on:** S10,S11,S12. **Exit:** One authoritative home survives staged transfer and every injected failure point.

- [ ] T065 Write tests/gateway/collaboration-peer-transfer-postgres.test.ts for wrong peer/source/target, replay, chunk corruption, changing inventory, lost acknowledgements, revoked consent and crash at every transfer phase.
- [ ] T066 Implement collaboration/{peer-auth,peer-transfer,peer-routes}.ts for exact actor-delegated source/target operation tickets, endpoint key validation, bounded encrypted streams/checkpoints and quota enforcement. No caller-selected URL or remote shell.
- [ ] T067 Extend project-transition.ts/project-fence.ts with dual-consent inventory, source durable fence, platform directory-generation CAS and target activation. Reconcile uncertain cutover before opening either writer.
- [ ] T068 Implement export/import drivers for project/Chat/app/file/folder and dirty worktree content; exclude credentials/private memory/drafts and do not assume native provider resume migrates. Target creates fresh authorized continuation when needed.
- [ ] T069 Prove org-managed member assignment backup/key custody/reassignment supports creator departure. Personal hosts without that contract retain personal resource ownership; transfers to ineligible custody fail visibly. Add bounded recovery backup/staging retention and shutdown behavior.

## S14 — Org billing and invitation compute choices

**Owner:** Billing Sol. **Depends on:** S03,S08. **Exit:** Admins see reviewed costs and accept/provision/sponsor flows cannot double-charge.

- [ ] T070 Write tests/platform/org-invite-billing-postgres.test.ts for new/existing members, zero-compute invite, stale quote, acceptance retries, concurrent invites, changed price, failed payment, duplicate/reordered Stripe events and sponsor departure.
- [ ] T071 Implement extracted billing/{payer-accounts,sponsorships,invite-quotes}.ts with configured SKUs, current/incremental monthly totals, prorated/tax estimate and expiry. Missing prices are unavailable; no invented per-member fee.
- [ ] T072 Implement organizations/{member-computer-assignments,invite-compute-commands}.ts for no-compute, sponsor-existing and provision-member choices. Pending invitations never provision/charge; accepted quote revalidation and confirmed entitlement precede provision.
- [ ] T073 Extend Stripe/customer-VPS/funded-AI repositories through focused modules for separate payer/owner/assigned actor and original-payer ledger settlement/refund. Require explicit personal-subscription cancellation/continuation and owner consent before sponsorship changes.
- [ ] T074 Implement leave/reassign/end-sponsorship and failed-payment recovery with retained owner data, org-managed backup access and no personal-card fallback. Integrate S13 transfer operation references without platform content payloads; test with Stripe sandbox fixtures.

## S15 — Shared permission/readiness and org UI

**Owner:** Shared UI Sol. **Depends on:** S06,S10,S11,S12,S14. **Exit:** Owners can grant a usable bounded environment and recipients understand missing access.

- [ ] T075 Write tests/ui/collaboration-ready-to-work.test.tsx for presets, granular folders/apps/task/connection selection, overlapping deny explanation, hidden resource counts, missing dependencies and exact access-request approval.
- [ ] T076 Build shared packages/ui/src/collaboration/{CapabilityEditor,ReadinessSummary,ProjectSourceSummary,AccessRequest}.tsx with stable server-derived state. Default join opens the shared group Chat with named humans; show one owner-configured source/payer and submit mode, not a participant account picker. Include audience-safe history preview and exact owner Git approval controls.
- [ ] T077 Build packages/ui/src/organizations/{OrganizationSettings,SharedResources,MemberComputerAssignments,OrganizationBilling,InviteCostReview}.tsx using brand primitives, custom-role permissions and reviewed quote choice/expiry handling.
- [ ] T078 Mount identical feature components in Web Canvas/Web Desktop/Electron Desktop normal Share/Chat/project/app/file surfaces. Worktree state, integration approvals, offline/blocked/unknown funding and upgrade-required states must remain truthful.
- [ ] T079 Exercise admin/member/guest/billing-manager/integration-manager journeys; sharing never silently connects a personal integration, broadens a folder or picks a different payer. Record Web Canvas first, Web Desktop then Electron evidence.

## S16 — Managed Matrix group text

**Owner:** Messaging Sol. **Depends on:** S03,S04. **Exit:** Matrix communication cannot bypass org/resource revocation.

- [ ] T080 Write tests/platform/organization-matrix-boundary.test.ts for direct human/AI token reads/joins, lost kick jobs, partition expiry and arbitrary room/media IDs.
- [ ] T081 Implement platform organization-matrix service identity, private Space/group binding and bounded text routes with fresh group authority. Secret references stay in service custody; no AI/resource payload mirroring.
- [ ] T082 Wire group text UI to safe actor attribution and current group rights, with independent membership generation. Native Matrix clients remain unavailable until a separately reviewed enforcement design.
- [ ] T083 Prove direct homeserver tokens cannot join/read/send and managed routes expire during outage. Record this explicit bounded messaging-service exception in architecture evidence.

## S17 — Native Mobile and CLI parity

**Owner:** Surface Sol. **Depends on:** S13,S15,S16. **Exit:** Every applicable surface honors direct protocol, permissions, funding and root binding.

- [ ] T084 Write mobile Jest and CLI integration tests for direct auth refresh/key custody, resource-home selection, worktree/root state, scoped integrations and stale policy handling.
- [ ] T085 Wire apps/mobile and existing CLI collaboration clients to shared contracts and direct transport adapters, platform-native secure key storage, same permission/readiness derivations and safe error states.
- [ ] T086 Expose applicable Share, worktree create/select, owner source/payer summary, group Chat and owner Git approvals/access requests, org invite-cost and member assignment flows; Web Mobile uses shared components. Record explicit genuine platform limitations in spec.md, never silently omit business state.
- [ ] T087 Run native dev-client and CLI two-computer journeys with browser/Electron counterparts. Verify deep links obtain fresh tickets and do not embed reusable credentials; no recipient computer required to read a shared resource.

## S18 — One coordinated migration and removal

**Owner:** Cutover Sol. **Depends on:** S13,S14,S17. **Exit:** Direct protocol is the only serving collaboration path after activation.

- [ ] T088 Write tests/platform/collaboration-cutover-postgres.test.ts for idempotent import/count validation, ambiguous legacy handles, offline homes, exact old ceilings, failed freeze, interrupted CAS, compatible rollback and the T102 person-to-person record disposition (zero expected; any found are terminated with notice or owner re-homed, never imported as personal grants).
- [ ] T089 Implement collaboration cutover coordinator/journals under packages/platform/src/collaboration/cutover.ts and gateway collaboration/cutover.ts: backup inventory, maintenance fence, drain, shadow import, verification and direct-generation activation.
- [ ] T090 Remove packages/platform/src/collaboration/proxy.ts serving behavior, collaboration payload WS forwarding, V1 proof/ACL fallback and `MATRIX_COLLABORATION_PREFLIGHT_SECRET` after migrated direct consumers are integrated. Update exact route registration/tests to reject retired endpoints; retain only metadata/control routes. The rollout flag and cohort policy are already gone from S20; assert their absence here.
- [ ] T091 Remove direct-capable integration central execution fallback and legacy sync/collaboration secondary allow readers. Temporary import code is migration-only with explicit completion/retention state; snapshots and unrelated personal routing remain separate.
- [ ] T092 Run full dry-run with old client/home negative tests, two direct computers, multiple actors/one owner source, shared group Chat, owner-controlled commit/PR operations, integration grants and dirty worktrees. Record no collaboration payload traverses platform, no dual writer and recoverable rollback state before release approval.

## S19 — Release acceptance and docs

**Owner:** Coordinator. **Depends on:** S18. **Exit:** Full architecture is reviewable and ready for explicitly authorized deployment.

- [ ] T093 Run quickstart.md acceptance matrix with real Postgres, approved provider/Stripe/Clerk/Matrix sandboxes and disposable reachable computers. Capture exact SHA/version/result, not fabricated screenshots or skipped-required-tests passes.
- [ ] T094 Profile platform requests/bytes separately from direct resource data under concurrent Chat/PTY/file workloads. Verify control request coalescing and host CPU/memory/network caps; flag managed inference/vendor exceptions clearly.
- [ ] T095 Perform auth/atomicity/wiring review covering direct routes, dynamic policy/history, sandbox escapes, owner-source concurrency and Git identity/approval bypass, transfer failures and all-surface parity; resolve material findings before declaring release ready.
- [ ] T096 Prepare separate FinnaAI/matrix-os-site/content/docs/ documentation PR deliverable for direct connectivity, group Chat/owner source/payer, owner Git/PR identity, worktrees, granular sharing, integration consent, invite quotes, outages and migration. External publication needs its own authorization.
- [ ] T097 Record full implementation log, migration/rollback runbook and configured price/provider limitations. Obtain required CI/current-head Greptile 5/5 and ready-for-ci; do not infer deployment/merge authority from this planning request.

## S20 — Org-only precondition and release-gate removal

**Owner:** Foundation Sol. **Depends on:** S01. **Executes:** immediately after S01 and before S02. **Exit:** No release flag, cohort or person-to-person path exists; organization membership or guest admission is the only gate and missing configuration fails closed.

- [ ] T098 Write failing tests/gateway/collaboration-org-precondition.test.ts and tests/platform/collaboration-org-precondition.test.ts: every collaboration route, WebSocket upgrade, queue claim, tool invocation and integration action denies an actor with a valid Clerk session but no current membership or guest admission in the resource's organization; no `MATRIX_COLLABORATION_ENABLED` or cohort lookup is consulted; wiring with missing signing/origin configuration fails closed with a logged generic denial rather than skipping construction; invitation identifiers outside the organization are not resolved.
- [ ] T099 Remove `MATRIX_COLLABORATION_ENABLED` from packages/platform/src/collaboration/{wiring,bootstrap}.ts, packages/gateway/src/collaboration/wiring.ts, packages/gateway/src/server.ts, packages/gateway/src/system-info.ts, the cloud-init template in packages/platform/src/customer-vps.ts, distro/customer-vps/cloud-init.yaml and .github/workflows/platform-cloud-run.yml, with their tests (collaboration-wiring, collaboration-bootstrap, collaboration-deployment, customer-vps-cloud-init, system-info). Existing `host.env` values become inert; no in-place rewrite. The system-info `collaboration` capability reports configuration health, not a flag.
- [ ] T100 Remove the platform `collaboration_rollout_policy` table and its migration, the `CollaborationPolicy` milestone/mode/cohort contract, the `/internal/collaboration/policy` route, packages/gateway/src/collaboration/policy-client.ts, the cohort/milestone branches in authority.ts `executionAllowed`, platform websocket.ts, terminal-websocket-route.ts, terminal-dispatcher.ts and shared-ai-runtime.ts, and update the affected contract, gateway and platform tests. Replace them with one organization-precondition input to the authority evaluator; no gradual-rollout mechanism replaces the cohort.
- [ ] T101 Restrict audiences to the organization context: invitation identifier resolution returns only current members or admitted guests of the scope's organization; record the owning organization on every scope and the deriving organization on every grant; remove personal-share and departure-surviving branches; update ProjectSharingDialog, ChatCollaboratorsDialog, ShareChoiceDialog and TerminalSharingButton copy and tests. Coordinate vocabulary with S02 T013.
- [ ] T102 Inventory existing person-to-person scope, grant and invitation records on platform and gateway databases and record counts in research.md (zero expected because customer VPSes shipped with the flag off). Define the disposition executed by S18: terminate with notice, or the owner explicitly re-homes the resource into an organization. Never silently orphan or auto-convert.

## Dispatch and completion rules

S20 runs before S02 despite its number; packet numbers are stable labels, not order. Sequential prerequisite integration is required even when packets are developed in parallel. S07/S09/S10 share runtime seams, S08/S11 share account custody, S12/S13 share resource/transfer drivers, S03/S14 share org commands: coordinate ownership rather than concurrent edits. No packet is complete without a red/green receipt and actual registration/export integration. Provider modes that fail probes remain explicitly unavailable; required shared API harness modes and direct architecture must pass before final release.

Planning validation only checks document coherence. It is not evidence that SDK/native account isolation, subscription eligibility, direct TLS deployment, or authorization boundaries work.

## Future scope — no V1 implementation checkboxes

Participant AI account enrollment/routing is deferred; existing owner account settings may be reused without new participant UI. Git-based copy-and-continue is deferred: pin the source commit plus reviewed dirty/untracked state, explicitly handle LFS/submodules, create a new destination project/permissions/identity, and never transfer credentials, subscription bindings, provider resume or invisible Git history. Chat/app data exports are separate. This independent fork must never masquerade as the current peer ownership-transfer operation.
