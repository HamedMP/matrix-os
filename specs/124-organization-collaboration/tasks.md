# Sol implementation tasks — revised direct architecture

**Status:** all implementation tasks pending. This ledger replaces the previous 121-task S00–S24 ledger; old IDs must not be used to dispatch work. No agents were dispatched by this spec revision.

Use `gpt-5.6-sol` with high reasoning, one coordinator and at most three workers. Each packet owns the files named below; coordinator owns shared composition/exports/package manifests. Paths not present at baseline are proposed new focused modules; integrate with equivalent existing seams rather than duplicate them. Before code changes read constitution/applicable instructions and write failing behavioral tests. Do not revert other workers; do not parallelize overlapping files. All packets join one coordinated release, not independent partial product launches.

## S00 — Baseline and live boundary probes

**Owner:** Coordinator. **Depends on:** None. **Exit:** Versioned evidence establishes the allowed execution/auth modes and direct host eligibility.

- [ ] T001 Inspect current main and record baseline SHA plus changed seams in research.md. Confirm canonical Chat roots, shared adapter limitations, endpoint wiring, provider V3 and connector custody; do not infer that source presence means deployed support.
- [ ] T002 Add failing probe harnesses in tests/integration/collaboration-provider-boundaries.test.ts for Codex/Claude API execution, native owner subscription eligibility (owner-only versus delegated requests), owner source/root change resume, tool/approval/cancel semantics and worktree isolation. Record exact versions/auth modes and real outcomes in evidence/providers.md; never store tokens.
- [ ] T003 Add tests/integration/collaboration-authority-boundaries.test.ts for Clerk direct role changes, lost webhooks, API consistency, clock skew and partition expiry. Freeze supported custom permission mapping and measured removal bound in contracts/organization-api.md.
- [ ] T004 Add relay/Origin/WS pass-through and home ticket verification probes plus sandbox mount/Git-object/credential escape probes in tests/integration/collaboration-direct-boundaries.test.ts. Record browser/Electron/native ingress paths, relay byte-limit behavior and required supervisor facilities in evidence/direct.md.
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
- [ ] T013 Freeze Clerk custom permissions and resource capability vocabulary with identity/runtime/billing owners. Define the V1 preset enum (`viewer`, `contributor`) with its capability expansion and the old-role migration matrix with exact action ceilings. Freeze the default group Chat, owner-selected source and broker-executed owner-identity Git rules. Audiences are the organization or a current member of it only; grants carry one whole-project preset and no selectors; there is no personal, group or guest audience, departure-surviving grant, milestone or cohort field. Git operations carry no approval field in V1. Participant account routing and copy-and-continue are deferred.
- [ ] T014 Give coordinator index.ts exports and package dependency changes; verify package consumers and schemas compile. Update contracts/organization-api.md with final concrete payload unions and version negotiation.

## S03 — Clerk roles and control authority

**Owner:** Identity Sol. **Depends on:** S02. **Exit:** Current membership/permissions reach enrolled homes within tested fixed leases.

- [ ] T015 Write failing real-Postgres tests in tests/platform/organization-authority-postgres.test.ts for duplicate/reordered webhook, remove/rejoin, concurrent webhook and outage cases; groups and guests are deferred.
- [ ] T016 Implement packages/platform/src/organizations/{database,repository,commands,clerk-resolver,roles}.ts as a membership projection using Clerk's default roles (no custom permissions in V1) that also projects `collaboration.aiSubmission` from organization public metadata (absent means owner-only), verified webhook inbox, tombstones, fixed-deadline upstream evidence and reconciliation. Clerk remains membership source of truth.
- [ ] T017 Implement control generations/denial fences and batched active-actor assertions in packages/platform/src/collaboration/control-authority.ts. Never renew evidence from receipt time or trust selected org as membership.
- [ ] T018 Implement `GET /api/organizations`, `GET /api/organizations/:orgId/members` and `POST /webhooks/clerk/organizations` from the contract with body limits, Origin checks, safe errors and idempotent webhook handling. Organization creation, member management, groups, guests and invitations stay in the Clerk dashboard; their routes are deferred.
- [ ] T019 Prove platform revocation completes only after home acknowledgement or lease expiration. Add bounded caches, coalescing, recurring reconciliation, outbox retry/dead-letter and shutdown drains; record provider freshness evidence.

## S04 — Local granular authority

**Owner:** Authority Sol. **Depends on:** S02. **Exit:** One deny-wins evaluator applies the organization precondition and whole-project presets to every resource and execution path; selectors, ceilings and audience rules are deferred.

- [ ] T020 Write failing tests/gateway/collaboration-capabilities-postgres.test.ts covering conflicting user/org grants, preset changes, expiry, departure, legacy ceilings, races, and organization-wide shares that stay pending per member until opened (a member who never opens one is not a participant; a member who joins the organization later sees it pending; a member who declines is durably settled and not a participant; a member who declines and later accepts becomes active through the same accept statement; concurrent accepts from one member produce one active row). Selector, parent-ceiling and move cases are deferred.
- [ ] T021 Implement collaboration/{capability-repository,capability-evaluator,policy-migrations}.ts and extend authority.ts for whole-project presets, per-member activation of organization-wide grants through the accept action (one organization grant row plus `collaboration_grant_activations` rows with state `active` or `declined`; accept is `INSERT ... ON CONFLICT (grant_id, actor_id) DO UPDATE SET state = 'active' WHERE state = 'declined'`, decline is the mirror statement refused once active; pending is the absence of a row; GET reads never activate), expiry and explicit management; no implicit editor funding or admin content privilege. Keep selector fields out of the V1 schema.
- [ ] T022 Deferred from V1: collaboration/{chat-audience-policy,artifact-publication-policy}.ts (audience data ceilings, historical Chat share preflight, restricted-to-broad publication).
- [ ] T023 Implement the readiness evaluator for missing owner setup (Git identity, forge credential, AI source), host offline and unsupported states. Access requests are deferred.
- [ ] T024 Wire evaluator into resource grant mutations and local epoch fences; prove conditional writes, audit/outbox atomicity, safe effective-access reasons and no permissive fallback on policy lookup failure.

## S05 — Direct endpoints, tickets and revocation

**Owner:** Transport Sol. **Depends on:** S03,S04. **Exit:** Enrolled homes authenticate direct clients/peers without platform content proxying.

- [ ] T025 Write tests/platform/collaboration-tickets.test.ts and tests/gateway/collaboration-direct-sessions.test.ts for audience/key/nonce tampering, ticket reuse, Origin, stale generation, endpoint forgery, unknown signing key and old protocol rejection.
- [ ] T026 Implement platform collaboration/{runtime-endpoints,ticket-issuer,control-stream}.ts with asymmetric enrollment, relay-routable home registration reusing existing customer-VPS enrollment, SSRF-safe validation, signed actor/device/purpose binding and rotation. Tickets bind logical runtime ID and generation, never a TLS hostname. Metadata only; no per-home hostname or certificate work.
- [ ] T027 Implement gateway collaboration/{direct-auth,direct-sessions,control-client,direct-websocket}.ts with proof-of-possession, single-use ticket exchange, scoped HTTP/WS authorization and fixed-expiry control snapshots. Reuse local authority, not owner cookie authentication.
- [ ] T028 Integrate expiry/fence checks before input/output batches, queue claims and publication; terminate denied isolated processes/control leases. Add replay limits, slow-reader bounds, quotas and shutdown drains.
- [ ] T029 Run two-home + partition wiring tests in tests/e2e/collaboration-direct-transport.spec.ts through the relay. Prove no per-frame/chunk platform authorization call, no relay allow/deny decision, no lease extension on reconnect and no generic owner endpoint reachable by collaborator.
- [ ] T103 Extract a transparent relay mode from packages/platform/src/collaboration/proxy.ts and websocket.ts into collaboration/relay.ts: TLS termination and HTTP/WebSocket byte forwarding to the directory-resolved home, coarse byte/connection limits, no policy lookup, no body or frame parsing, no payload logging or tracing. Add tests proving the relay forwards forged/expired tickets untouched and the home rejects them, and that platform policy storage being unavailable does not affect an in-flight session.

## S06 — Direct clients and resource discovery

**Owner:** Client Sol. **Depends on:** S05. **Exit:** Every client request reaches the discovered resource home with scoped auth.

- [ ] T030 Add tests for resource-home versus selected-computer routing, endpoint generation changes, offline states, refresh failure and safe errors in tests/ui/collaboration-direct-client.test.ts.
- [ ] T031 Implement shared transport in packages/ui/src/collaboration/direct-client.ts with directory-resolved origins (never hardcoded), ticket exchange, signed requests, WS ticket handshake, session renewal and reconnection. Native/CLI transport adapters consume the same protocol and derivations.
- [ ] T032 Change platform collaboration discovery to metadata-only projections and safe org inventory. Clients hydrate content from the home; do not make platform hydration fetch full resource data.
- [ ] T033 Wire shell and desktop collaboration clients, event streams, terminal attach, download/upload and sandboxed app origins through direct transport. Coordinator applies CSP/query-ticket allowlist/composition patches.
- [ ] T034 Run browser and Electron cross-origin/session/logout tests; verify no reusable token leaks in referrers/logs, no fallback to platform-side authorization and no stale resource content on computer switch.

## S07 — Execution sandbox and task policies

**Owner:** Runtime Sol. **Depends on:** S04,S05. **Exit:** Commands/tools cannot escape the granted data, network or credential boundary.

- [ ] T035 Write tests/scope-runtime/collaboration-policy-boundary.test.ts and disposable-host tests for symlink/hardlink escape, subprocess/interpreter escape, proc/environment secrets, forge-token and credential-helper reach and denied network from a shared run.
- [ ] T036 Extend packages/scope-runtime/ supervisor/profile/protocol seams and gateway collaboration/scope-runtime-client.ts with actor/scope/worktree mount manifests, isolated UID/process namespaces, resource caps and restricted network. No changes based only on prompt instructions.
- [ ] T037 Deferred from V1: collaboration/{task-profiles,filtered-workspace,publication-broker}.ts. V1 shared runs use the project root under the sandbox from T036.
- [ ] T038 Extend terminal adapter/control/dispatcher for sandbox-only terminal sessions and exact task profile capability. Arbitrary sandbox shell is explicit and cannot imply unrestricted host shell or connection secrets.
- [ ] T039 Prove revocation stops new tools/terminal input and terminates isolated processes on lease loss. Expose unsupported profiles through readiness, with dependency/access requests rather than silent wider mounts.

## S08 — Single owner source and run funding

**Owner:** AI Source Sol. **Depends on:** S02,S04. **Exit:** All permitted participants use one explicitly configured eligible owner source; no participant account onboarding required.

- [ ] T040 Write tests/gateway/collaboration-owner-source.test.ts for multiple members/one source of each kind, organization metadata absent or not `members`, project restricted to owner-only, missing owner provider-terms acknowledgement, exhausted source, source change while queued and attempted participant account override.
- [ ] T041 Implement collaboration/{execution-policy,run-account-binding,account-eligibility}.ts using AiProviderSnapshotV3. Store one selected owner binding per execution scope (project scope, or standalone Chat scope with the Chat's owner in the owner role) and pin requesting actor, executing owner, source/model/payer/policy/audience/root per run; validate stale policy before dispatch.
- [ ] T042 Reuse existing owner provider/account setup and native sign-in only for verified modes. Expose owner setup/readiness and explicit owner-only versus delegated submission state. Do not create participant profile stores, login flows, automatic account routing or copy OAuth tokens.
- [ ] T043 Implement explicit owner-funded eligible API/business/Matrix AI source with configured models/budget; organization sponsorship and org-sponsored Matrix AI budgets are deferred. Effective submit mode is organization metadata AND project policy, both fail-closed to owner-only; record the owner's provider-terms acknowledgement; do not enforce provider eligibility. A member proposal is discussion, not a hidden execution request in owner-only mode; no silent source/card fallback.
- [ ] T044 Bind one project/Chat provider session to owner source/harness/root/audience generation, never the owner's private session. Owner source changes start fresh authorized continuation unless proven safe. Account selection in existing owner settings is reused; participant multi-account support stays in future scope.

## S09 — Shared Codex and Claude execution

**Owner:** AI Execution Sol. **Depends on:** S07,S08. **Exit:** Both harnesses execute shared authorized work with attributable queues and tool events.

- [ ] T045 Write tests/gateway/shared-coding-execution.test.ts against canonical Chat queue/run state for concurrent humans, cancellation permitted only to the requesting member or the project owner (other Contributors and Viewers denied), harness tool-approval prompts answerable only by the requester or the project owner, retry of an interrupted or failed request permitted only to the requester (owner denied), interrupted-run marking and preserved-queue re-admission on fresh membership after the home loses a run, resume isolation, unsupported modes, edits after revoke and partial provider failures.
- [ ] T046 Extend the isolated Codex (#1761) and Claude (#1765) shared adapters, which must land first, into focused shared-codex-adapter.ts and shared-claude-adapter.ts behind the canonical provider contract, adding executionRoot/worktree support. Reuse chat/coding-provider-adapter.ts seams where safe; preserve the immutable harness binding those PRs establish.
- [ ] T047 Extend shared-ai-runtime.ts, shared-ai-runtime-registry.ts and shared-execution-coordinator.ts for account/root/policy-bound execution, authorized history materialization and sandbox tool events. Never import the owner’s private provider state into the shared session.
- [ ] T048 Wire queue claims and broker side effects through current authority/F bindings; serialize one active run per Chat, retain independent Chat concurrency with host/account limits. Persist initiating actor and exact approval/cancel actor; accept cancel and tool-approval decisions only from the requesting member or the project owner; when the home loses the run for any reason (gateway restart, scope-runtime crash, run unit exit without a terminal result, or loss of the control stream past its lease) mark the executing run interrupted with the requester attributed and re-admit preserved queued requests only when each requester's membership evidence is fresh; reattaching to a run unit that survived the gateway is deferred. Shared discussion never implicitly invokes AI; enforce the effective submit mode (organization-enabled members or owner-only). T048 owns `/scopes/:scopeId/chat/requests*` and `/chat/approvals*` for project scopes and standalone Chat scopes alike; for a standalone Chat the preset, the execution policy row (owner-selected source, submit mode, provider-terms acknowledgement) and the privileged cancel/approval actor all resolve on the Chat scope itself with the Chat's owner in the project owner's role, and a Chat shared as part of a project uses the project's policy; `/chat/requests/:id/retry` resubmits an interrupted or failed request and is permitted only to the requesting member.
- [ ] T049 Run versioned real Codex/Claude API-backed shared run probes with approved test credentials and costs; record unsupported native-source modes explicitly. Capability flags become true only for observed supported paths.

## S10 — Chat worktrees and Git concurrency

**Owner:** Worktree Sol. **Depends on:** S09. **Exit:** Members commit/push/PR through the broker under the owner identity without approval, and every Chat root in a project is inventoried at share time; per-Chat worktree UI and leases are deferred.

- [ ] T050 Write tests/gateway/project-share-inventory-postgres.test.ts: a project whose Chats own separate worktrees lists every Chat with execution root, branch and dirty state in the share preflight; an unresolvable root blocks the share; joining creates no worktree or copy; a dirty worktree survives Chat deletion. Per-Chat worktree, viewer and lease tests are deferred.
- [ ] T051 Extend chat/execution-root.ts and the project inventory to resolve and fingerprint every Chat root in a project for the share preflight, using canonical executionRoot fields. Worktree leases, protected-main fencing and explicit reuse are deferred.
- [ ] T052 Implement collaboration/{project-git-operations,project-git-broker}.ts: commit, push and PR for Contributor through the broker under the configured owner Git identity and broker-held forge credential, no owner approval, requestor and run audited, ambiguous push/PR results reconciled by operation ID before retry. Deny raw git/gh credential access from the sandbox; approval, merge and remote changes are deferred.
- [ ] T053 Show the share-time Chat root inventory and owner Git identity/setup state inside the confirmed 525 share dialog and access popover. Per-Chat worktree/branch/status/restore controls are deferred.
- [ ] T054 Prove a member commit/push/PR carries the owner identity with the requesting member in audit, imported authorship is preserved, Chat deletion retains a dirty worktree, and concurrent Codex and Claude Chats on the project root serialize per Chat under the same owner source.

## S11 — Local and peer integration delegation

**Deferred from V1; not on the release path.** **Owner:** Integration Sol. **Depends on:** S07,S08. **Exit:** Exact connection actions run with scoped credentials outside the platform content path. V1 shared runs use the owner's existing connections as the owner's own runs do; the accepted risk is recorded in spec.md.

- [ ] T055 Write tests/gateway/collaboration-integration-delegation.test.ts for connection-owner consent, tool/upstream scopes, read versus send/delete, approval races, revoked credentials, output audience and ambiguous remote effects.
- [ ] T056 Implement integrations/{local-credential-store,delegated-action-broker,connection-policy}.ts reusing custom-mcp client/schema/SSRF protections. Encrypt secrets locally; sandbox agents receive capabilities, never raw tokens or unrestricted MCP endpoints.
- [ ] T057 Add local and peer connection-action routes with exact connection/actor/project/tool/resource binding. Reauthorize after queued approval and before invocation; use upstream idempotency where supported and uncertain-outcome state otherwise.
- [ ] T058 Migrate direct-capable custom MCP execution/custody from platform-backed paths using S00 inventory and explicit connection-owner consent or reconnect. Document vendor-hosted exceptions and block unsupported fine-grained delegation instead of pretending scopes exist.
- [ ] T059 Wire app bridge/agent tool discovery/readiness/approval UI to the same action policy. Prove hidden integration results cannot enter broader Chat history and direct shell/network paths cannot bypass the broker.

## S12 — Direct resource adapters and sync

**Owner:** Resource Sol. **Depends on:** S06,S07. **Exit:** Projects and standalone Chats, terminals, app instances, files and folders enforce the same two presets on the home computer.

- [ ] T060 Write tests/gateway/direct-resource-policy-postgres.test.ts for file/folder identity, renamed/deleted incarnations, whole-project preset enforcement on files/apps/exports/search/thumbnails, standalone Chat, terminal, file, folder and app-instance shares that grant only that resource (a folder share includes its contents) with the Viewer and Contributor presets (a Chat Viewer reads history and discussion only; a terminal Viewer observes only and a Contributor may hold the controller), and simultaneous policy change/upload commit. Narrow app actions and parent ceilings are deferred.
- [ ] T061 Implement collaboration/resource-catalog.ts and production file/project/app routes using project-adapters.ts/project-app-adapter.ts, local owner namespaces and stable app instance IDs, and own the standalone Chat scope read and discussion routes (`GET /scopes/:scopeId/chat`, `/chat/messages`, `/discussion/messages`, `/user-state`) and the standalone terminal scope routes (`/scopes/:scopeId/terminal*`) with their Viewer/Contributor preset enforcement: a standalone Chat or terminal scope has no enclosing project, so the evaluator must resolve the preset on the scope itself, with Viewer read-only for Chat and observe-only for terminal, and Contributor able to post discussion and request the terminal controller. The AI submission routes (`/chat/requests*`, `/chat/approvals*`) for every scope kind, including standalone Chats, are owned by S09 T048 because they need the S08 effective submit mode and the S09 queue; T061 mounts nothing for them. No allowlisted-but-unmounted project, Chat or terminal endpoints.
- [ ] T062 Implement direct streaming reads, staged uploads, multipart/resume, immutable checksums and final fresh commit. Do not issue reusable shared storage GET URLs; cancel on revoked leases and clean inert staging.
- [ ] T063 Deferred from V1: packages/sync-client shared transfer and CLI mounts. Personal sync remains its own non-collaboration operation; existing sync grants are inventoried in T102.
- [ ] T064 Wire app sandbox assets and bridges to scoped sessions. Prove viewers cannot mutate through alternate HTTP/network/bridge paths and Web Canvas, Web Desktop and Electron Desktop use the same preset semantics.

## S13 — Computer-to-computer migration and recovery

**Deferred from V1; not on the release path.** **Owner:** Transfer Sol. **Depends on:** S10,S11,S12. **Exit:** One authoritative home survives staged transfer and every injected failure point.

- [ ] T065 Write tests/gateway/collaboration-peer-transfer-postgres.test.ts for wrong peer/source/target, replay, chunk corruption, changing inventory, lost acknowledgements, revoked consent and crash at every transfer phase.
- [ ] T066 Implement collaboration/{peer-auth,peer-transfer,peer-routes}.ts for exact actor-delegated source/target operation tickets, endpoint key validation, bounded encrypted streams/checkpoints and quota enforcement. No caller-selected URL or remote shell.
- [ ] T067 Extend project-transition.ts/project-fence.ts with dual-consent inventory, source durable fence, platform directory-generation CAS and target activation. Reconcile uncertain cutover before opening either writer.
- [ ] T068 Implement export/import drivers for project/Chat/app/file/folder and dirty worktree content; exclude credentials/private memory/drafts and do not assume native provider resume migrates. Target creates fresh authorized continuation when needed.
- [ ] T069 Prove org-managed member assignment backup/key custody/reassignment supports creator departure. Personal hosts without that contract retain personal resource ownership; transfers to ineligible custody fail visibly. Add bounded recovery backup/staging retention and shutdown behavior.

## S14 — Org billing and invitation compute choices

**Deferred from V1; not on the release path.** **Owner:** Billing Sol. **Depends on:** S03,S08. **Exit:** Admins see reviewed costs and accept/provision/sponsor flows cannot double-charge.

- [ ] T070 Write tests/platform/org-invite-billing-postgres.test.ts for new/existing members, zero-compute invite, stale quote, acceptance retries, concurrent invites, changed price, failed payment, duplicate/reordered Stripe events and sponsor departure.
- [ ] T071 Implement extracted billing/{payer-accounts,sponsorships,invite-quotes}.ts with configured SKUs, current/incremental monthly totals, prorated/tax estimate and expiry. Missing prices are unavailable; no invented per-member fee.
- [ ] T072 Implement organizations/{member-computer-assignments,invite-compute-commands}.ts for no-compute, sponsor-existing and provision-member choices. Pending invitations never provision/charge; accepted quote revalidation and confirmed entitlement precede provision.
- [ ] T073 Extend Stripe/customer-VPS/funded-AI repositories through focused modules for separate payer/owner/assigned actor and original-payer ledger settlement/refund. Require explicit personal-subscription cancellation/continuation and owner consent before sponsorship changes.
- [ ] T074 Implement leave/reassign/end-sponsorship and failed-payment recovery with retained owner data, org-managed backup access and no personal-card fallback. Integrate S13 transfer operation references without platform content payloads; test with Stripe sandbox fixtures.

## S15 — Shared permission/readiness and org UI

**Owner:** Shared UI Sol. **Depends on:** S06,S10,S12. **Exit:** Owners can share a project or any standalone resource with one of the two presets and recipients understand readiness.

- [ ] T075 Write tests/ui/collaboration-ready-to-work.test.tsx for the two presets, organization/member audience selection, per-type readiness preview (source and submit mode for projects and Chats, Git identity and root inventory for projects and rooted Chats, none for files, folders and apps), pending organization shares that activate only through the accept call made when the member opens them (never on list or preview fetch), Chat root inventory display, missing owner setup and source-kind display.
- [ ] T076 Build shared packages/ui/src/collaboration/{ReadinessSummary,ProjectSourceSummary}.tsx with stable server-derived state, mounted inside the existing SessionAccessControl popover/owner manager and ProjectSharingDialog/ShareChoiceDialog per the spec.md UI baseline table; replace the identifier field with an organization/member picker; show the per-type readiness items and, for projects and rooted Chats, the Chat root inventory and owner Git identity; map Viewer and Contributor to observe-only and controller-eligible in `SharedTerminalControls`. CapabilityEditor and AccessRequest are deferred; do not add a new share dialog or inbox.
- [ ] T077 Deferred from V1: packages/ui/src/organizations/{OrganizationSettings,SharedResources,MemberComputerAssignments,OrganizationBilling,InviteCostReview}.tsx. V1 has no organization surface; the share dialog member picker reads the platform membership projection.
- [ ] T078 Mount identical feature components in Web Canvas/Web Desktop/Electron Desktop normal Share/Chat/project/app/file surfaces, keeping the confirmed 525 model (ordinary timeline/composer, discussion drawer, access popover, Shared with me row, ordinary terminal viewport). Native Mobile and CLI are a recorded V1 limitation.
- [ ] T079 Exercise owner/member/outsider journeys; sharing never silently connects a personal integration, broadens a folder or picks a different payer. Record Web Canvas first, Web Desktop then Electron evidence.

## S16 — Managed Matrix group text

**Deferred from V1; not on the release path.** **Owner:** Messaging Sol. **Depends on:** S03,S04. **Exit:** Matrix communication cannot bypass org/resource revocation.

- [ ] T080 Write tests/platform/organization-matrix-boundary.test.ts for direct human/AI token reads/joins, lost kick jobs, partition expiry and arbitrary room/media IDs.
- [ ] T081 Implement platform organization-matrix service identity, private Space/group binding and bounded text routes with fresh group authority. Secret references stay in service custody; no AI/resource payload mirroring.
- [ ] T082 Wire group text UI to safe actor attribution and current group rights, with independent membership generation. Native Matrix clients remain unavailable until a separately reviewed enforcement design.
- [ ] T083 Prove direct homeserver tokens cannot join/read/send and managed routes expire during outage. Record this explicit bounded messaging-service exception in architecture evidence.

## S17 — Native Mobile and CLI parity

**Deferred from V1; recorded platform limitation.** **Owner:** Surface Sol. **Depends on:** S15. **Exit:** Native Mobile and CLI honor the same permissions, funding and root binding. Their existing 525 shared Chat and terminal keep working in V1.

- [ ] T084 Write mobile Jest and CLI integration tests for direct auth refresh/key custody, resource-home selection, worktree/root state, scoped integrations and stale policy handling.
- [ ] T085 Wire apps/mobile and existing CLI collaboration clients to shared contracts and direct transport adapters, platform-native secure key storage, same permission/readiness derivations and safe error states.
- [ ] T086 Expose applicable Share, worktree create/select, owner source/payer summary, group Chat and owner Git approvals/access requests inside the 525 mobile model (full-height discussion sheet, compact access control); Web Mobile uses shared components. Record explicit genuine platform limitations in spec.md, never silently omit business state.
- [ ] T087 Run native dev-client and CLI two-computer journeys with browser/Electron counterparts. Verify deep links obtain fresh tickets and do not embed reusable credentials; no recipient computer required to read a shared resource.

## S18 — One coordinated migration and removal

**Owner:** Cutover Sol. **Depends on:** S15. **Exit:** Direct protocol is the only serving collaboration path after activation.

- [ ] T088 Write tests/platform/collaboration-cutover-postgres.test.ts for idempotent import/count validation, ambiguous legacy handles, offline homes, exact old ceilings, failed freeze, interrupted CAS, compatible rollback and the T102 person-to-person record disposition (zero expected; any found are terminated with notice or owner re-homed, never imported as personal grants).
- [ ] T089 Implement collaboration cutover coordinator/journals under packages/platform/src/collaboration/cutover.ts and gateway collaboration/cutover.ts: backup inventory, maintenance fence, drain, shadow import, verification and direct-generation activation.
- [ ] T090 Remove per-request authorization, policy lookups, body parsing, V1 proof/ACL fallback and `MATRIX_COLLABORATION_PREFLIGHT_SECRET` from packages/platform/src/collaboration/proxy.ts and websocket.ts after migrated consumers are integrated, leaving only the transparent relay extracted in T103. Update exact route registration/tests to reject retired endpoints; retain only metadata/control routes. The rollout flag and cohort policy are already gone from S20; assert their absence here.
- [ ] T091 Remove direct-capable integration central execution fallback and legacy sync/collaboration secondary allow readers. Temporary import code is migration-only with explicit completion/retention state; snapshots and unrelated personal routing remain separate.
- [ ] T092 Run full dry-run with old client/home negative tests, two computers through the relay, multiple members/one owner source, shared group Chat, member commit/push/PR under the owner identity, share-time root inventory and dirty worktrees. Record that the relay makes no authorization decision and parses or logs no payload, no dual writer and recoverable rollback state before release approval.

## S19 — Release acceptance and docs

**Owner:** Coordinator. **Depends on:** S18. **Exit:** Full architecture is reviewable and ready for explicitly authorized deployment.

- [ ] T093 Run quickstart.md acceptance matrix with real Postgres, approved provider and Clerk sandboxes (Stripe and Matrix sandboxes only for the deferred packets) and disposable reachable computers. Run `vitest --coverage` for the kernel and gateway packages and record the result against the constitution's 99-100% target. Capture exact SHA/version/result, not fabricated screenshots or skipped-required-tests passes.
- [ ] T094 Profile platform control requests separately from relayed resource bytes under concurrent Chat/PTY/file workloads and report relay bandwidth cost. Verify control request coalescing and host CPU/memory/network caps; flag managed inference/vendor exceptions clearly.
- [ ] T095 Perform auth/atomicity/wiring review covering relayed routes, dynamic policy, sandbox escapes, owner-source concurrency, Git broker credential containment and Web Canvas/Web Desktop/Electron Desktop parity; resolve material findings before declaring release ready.
- [ ] T096 Prepare separate FinnaAI/matrix-os-site/content/docs/ documentation PR deliverable for organization sharing, group Chat/owner source, member prompting, owner Git identity, share inventory, readiness, outages, the Native Mobile/CLI limitation and migration. External publication needs its own authorization.
- [ ] T097 Record full implementation log, migration/rollback runbook and configured price/provider limitations. Obtain required CI/current-head Greptile 5/5 and ready-for-ci; do not infer deployment/merge authority from this planning request.

## S20 — Org-only precondition and release-gate removal

**Owner:** Foundation Sol. **Depends on:** S01. **Executes:** immediately after S01 and before S02. **Exit:** No release flag, cohort or person-to-person path exists; organization membership is the only gate and missing configuration fails closed. S20 is independently deployable: with no S03 membership projection registered, the precondition has no positive evidence and denies every collaboration request, so no intermediate deployment serves ungated collaboration.

- [ ] T098 Write failing tests/gateway/collaboration-org-precondition.test.ts and tests/platform/collaboration-org-precondition.test.ts: every collaboration route, WebSocket upgrade, queue claim, tool invocation and integration action denies an actor with a valid Clerk session but no current membership in the resource's organization; no `MATRIX_COLLABORATION_ENABLED` or cohort lookup is consulted; wiring with missing signing/origin configuration fails closed with a logged generic denial rather than skipping construction; with no membership projection registered (the state between S20 and S03) every collaboration request is denied; invitation identifiers outside the organization are not resolved.
- [ ] T099 Remove `MATRIX_COLLABORATION_ENABLED` from packages/platform/src/collaboration/{wiring,bootstrap}.ts, packages/gateway/src/collaboration/wiring.ts, packages/gateway/src/server.ts, packages/gateway/src/system-info.ts, the cloud-init template in packages/platform/src/customer-vps.ts, distro/customer-vps/cloud-init.yaml and .github/workflows/platform-cloud-run.yml, with their tests (collaboration-wiring, collaboration-bootstrap, collaboration-deployment, customer-vps-cloud-init, system-info). Existing `host.env` values become inert; no in-place rewrite. The system-info `collaboration` capability reports configuration health, not a flag.
- [ ] T100 Remove the platform `collaboration_rollout_policy` table and its migration, the `CollaborationPolicy` milestone/mode/cohort contract, the `/internal/collaboration/policy` route, packages/gateway/src/collaboration/policy-client.ts, the cohort/milestone branches in authority.ts `executionAllowed`, platform websocket.ts, terminal-websocket-route.ts, terminal-dispatcher.ts and shared-ai-runtime.ts, and update the affected contract, gateway and platform tests. Replace them with one organization-precondition input to the authority evaluator; no gradual-rollout mechanism replaces the cohort.
- [ ] T101 Restrict audiences to the organization context: invitation identifier resolution (platform `collaboration/identifier-resolver.ts` and `identifier-resolution-route.ts`, consumed by the gateway `participant-resolver.ts` and `invitation-creation-route.ts`) returns only current members of the scope's organization; record the owning organization on every scope and the deriving organization on every grant; remove personal-share and departure-surviving branches; update ProjectSharingDialog, ChatCollaboratorsDialog, ShareChoiceDialog and TerminalSharingButton copy and tests. Coordinate vocabulary with S02 T013.
- [ ] T102 Inventory existing person-to-person scope, grant and invitation records on platform and gateway databases and record counts in research.md (zero expected because customer VPSes shipped with the flag off). Define the disposition executed by S18: terminate with notice, or the owner explicitly re-homes the resource into an organization. Never silently orphan or auto-convert.

## Dispatch and completion rules

S20 runs before S02 despite its number; packet numbers are stable labels, not order. Sequential prerequisite integration is required even when packets are developed in parallel. S07/S09/S10 share runtime seams, S08/S11 share account custody, S12/S13 share resource/transfer drivers, S03/S14 share org commands: coordinate ownership rather than concurrent edits. No packet is complete without a red/green receipt and actual registration/export integration. Provider modes that fail probes remain explicitly unavailable; required shared API harness modes and direct architecture must pass before final release.

Planning validation only checks document coherence. It is not evidence that SDK/native account isolation, subscription eligibility, direct TLS deployment, or authorization boundaries work.

## Future scope — no V1 implementation checkboxes

Participant AI account enrollment/routing is deferred; existing owner account settings may be reused without new participant UI. Git-based copy-and-continue is deferred: pin the source commit plus reviewed dirty/untracked state, explicitly handle LFS/submodules, create a new destination project/permissions/identity, and never transfer credentials, subscription bindings, provider resume or invisible Git history. Chat/app data exports are separate. This independent fork must never masquerade as the current peer ownership-transfer operation.
