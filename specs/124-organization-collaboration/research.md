# Research and decisions — direct member-computer collaboration

Inspected 2026-09-20 against main `94985f02e`. These are source findings and design decisions; no deployment or provider spike was run. The previous central-proxy/pooled-org-runtime delivery plan is superseded by this revision.

## R1 — Reuse authority; replace transport

`packages/platform/src/collaboration/proxy.ts` signs actor proofs and forwards allowlisted resource routes. `routes.ts` consumes request bodies; `websocket.ts` participates in tickets. Gateway `collaboration/authority.ts`, actor proofs, events, terminal control, directory outbox and transition journals are reuse points. Today the platform is in the payload path. Direct endpoints must be enrolled/TLS-verified; a hostname existing is not proof of safe direct exposure.

Decision (revised, see R13): ticket/discovery/control on platform; authorization only on the resource home; bytes traverse the platform as a transparent relay in this release. Authenticated peer-to-peer operations ship alongside. Every enrolled customer VPS is eligible. Lightweight control refresh, billing metering and discovery still load the platform; measure this separately from content bandwidth.

## R2 — No organization-wide computer

A resource home is one member computer. Runtime ownership, assignment, resource ownership and payer differ. Org-managed member-assigned computers can retain org namespaces and recovery after departure; personally administered machines cannot promise org durability by storing an org ID alone. Keep personal resources personal unless explicit transfer targets a verified org-managed member assignment. This honors owner-controlled storage without provisioning a pooled org desktop.

## R3 — Worktree support exists only in part

`packages/contracts/src/canonical-chat-primitives.ts` defines project/worktree execution roots. Gateway `chat/execution-root.ts` resolves managed paths and fingerprints. `chat/turn-admission.ts`, `queue-admission.ts` and `orchestrator.ts` persist/recheck execution roots; `chat/coding-provider-adapter.ts` forwards worktree IDs. Desktop stores already track worktree context.

However `collaboration/scope-runtime-chat-adapter.ts` rejects `executionRoot`, resume state and non-text parts. `chat-execution-adapter.ts` reports worktrees none; `shared-ai-runtime.ts` on main has a Claude-only fixed profile. Open PRs #1761 (isolated Codex shared execution: pinned `codex-cli` adapter in the scope-runtime profile, owner credentials on the host broker with a loopback endpoint, immutable harness binding through admission/claim/dispatch, epoch/generation fencing) and #1765 (Claude binding without the synthetic `claude_shared` instance, owner-only first binding, readiness by credential access source) are the baseline for S07/S08/S09 and must land before those packets start. Worktree execution, project-scoped session isolation and the owner-only versus delegated submit modes remain new integration work on top of them. Do not change capability flags to true without sandbox/provider/end-to-end evidence.

## R4 — One owner-selected AI source; participant accounts later

Provider V3 (`packages/contracts/src/ai-provider.ts`) already models accounts, access sources and instances. Reuse the owner's existing selection; one project binding and immutable run snapshot are enough for V1. Building isolated participant enrollment, account routing and cross-actor credential profiles is not a cheap UI toggle and is deferred. The shared session starts from authorized project history, not the owner's private harness state.

Official guidance checked on 2026-09-20:

- [OpenAI terms](https://openai.com/policies/terms-of-use/) restrict making an individual account available to others. A process location does not establish delegated subscription rights.
- [Claude Code legal/authentication guidance](https://code.claude.com/docs/en/legal-and-compliance) distinguishes a user signing into an unmodified hosted binary from third-party credential intermediation, and discusses customer-controlled API credentials. Verify the applicable hosted/customer contract before enabling a funding mode.
- [Claude Agent SDK plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the June usage-billing change was paused; it does not authorize pooling individual subscriptions.

Decision (product owner, 2026-09-20): members may prompt the owner's AI on whatever source the owner configured, including personal subscriptions, when the organization enables member submission in Clerk organization public metadata and the owner has not restricted the project to owner-only. Matrix does not enforce provider eligibility; it shows the source kind to participants and records the owner's acknowledgement that the provider terms of the selected source are the owner's responsibility. Accepted risk: the provider documents above restrict sharing an individual account, and organization trust does not change those terms; if a provider objects, the mitigation is an API/business/Matrix AI source, which needs no code change. The submit-mode probes in T002 remain evidence, not release gates. No silent source fallback.

Required probes: shared Codex/Claude project roots, owner source selection, owner-only versus delegated submission, safe project session resume, cancellation, approvals, exhaustion and bounded concurrent worktrees. Participant native sign-in/multi-account routing is future work.

## R5 — Clerk handles coarse org permissions

[Clerk roles/permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions) supports custom permissions; system permissions are not included in session claims. V1 needs none: membership alone is the authority, organizations are administered in the Clerk dashboard, and the custom-permission vocabulary is deferred with the administration surface. Do not create a Clerk role/claim for every folder, tool or project. Those selectors live with resource grants on the home computer. Membership freshness is independently checked; a signed old JWT alone is insufficient.

## R6 — Granular access changes the project contract

Deferred from V1 (2026-09-20): V1 grants whole-project presets only. The following remains the target design. 121/previous 124 whole-project unconditional inheritance cannot express selected folders/apps/tools. Replace it with inheritable defaults, explicit ceilings and deny-wins selectors. Migrate old broad grants faithfully, never silently restrict/widen them; owners may then deliberately narrow. A scoped shell with the entire Git object database can read denied files, so filtered workers cannot receive raw shared Git metadata. Arbitrary scripts also defeat executable-name-only policies. Enforce mounts, UID/process boundaries, network and credential broker capabilities.

Chat history is itself shared data. A broad Chat cannot receive narrow-only tool results. Admission checks the Chat audience's data ceiling, and restricted artifacts cannot be auto-published into a wider tree. New grants to historical Chats require inventory/history review; revocation cannot recall bytes already delivered.

## R7 — Integrations require custody and action delegation

Deferred from V1 (2026-09-20): shared runs use the owner's existing connections; the accepted risk is recorded in spec.md. The following remains the target design. `packages/gateway/src/integrations/custom-mcp/broker.ts` uses platform DB-backed connection records and projections. Existing registry/routes/bridge and custom MCP client are useful seams, not proof of per-project delegation. Inventory each connector's execution/credential location. Move direct-capable user-managed connections to a local encrypted broker and remove their legacy execution route at cutover. Provider-hosted connector services may remain explicit external processors; never promise that such requests avoid the vendor. Token migration requires documented custody authorization, staged encrypted transfer or reconnection; never copy OAuth tokens through Chat/transcript exports.

## R8 — Durable migration, not permanent compatibility

Keep immutable source IDs, exact old action ceilings and recoverable journals. Offline/ambiguous sources cannot activate. Prepare and validate migrations during a maintenance gate, then activate only direct-capable clients/runtimes. Delete old serving fallback paths; rollback only to compatible builds. Data backup and transient migration readers are necessary for safe cutover and do not constitute a second long-lived product path.

## R9 — Matrix communication remains separate

Use private service-only Matrix group text through fresh org/group authorization as previously planned; no AI transcript/file mirroring or native user token bypass. Spaces do not recursively enforce resource grants. This bounded messaging service is explicitly outside the computer-owned resource payload path. A homeserver partition test remains required.

## R10 — Group Chat and Git owner are opinionated defaults

Idempotently create one default project group Chat and root. Join reuses both; additional task Chats/worktrees are optional. Everyone has a named Matrix actor; read-only viewers cannot post, normal Contributor includes discussion. Human discussion is separate from AI submission. The project owner controls the selected source and Git identity. New local commits use configured owner author/committer; pushes and PRs use the owner's configured forge account. Imported commit history is untouched; requestor attribution lives in Matrix audit, not fabricated Git authorship.

V1 drops per-operation owner approval (product decision 2026-09-20): the credential-holding Git broker executes member commit/push/PR operations under the owner identity and audits the requesting member. Approval bound to an exact tree/ref remains the documented later policy. Collaborators contribute without GitHub/AI onboarding.

## R11 — Copy-and-continue is a future fork

An independent Git-based copy should pin SHA plus explicitly approved dirty/untracked snapshot, handle LFS/submodules, and create a new project under the destination member's own Git/AI configuration. It neither moves source authority nor copies its permissions/credentials. Restricted members must not receive invisible repository history. Chat and app database exports require separate explicit decisions. Document the extension now; do not implement it in the initial direct collaboration release.

## R12 — The organization is the only gate

Three independent release controls gate collaboration today. `MATRIX_COLLABORATION_ENABLED` is `'true'` on the platform Cloud Run deployment but hardcoded `false` in the customer-VPS cloud-init template (`packages/platform/src/customer-vps.ts`, `distro/customer-vps/cloud-init.yaml`); it is written once into `/opt/matrix/env/host.env` at provisioning and nothing in `distro/` rewrites it afterwards, so template changes reach only new VPSes. The platform `collaboration_rollout_policy` table stores a per-milestone `mode` (`off`/`internal`/`enabled`/`read_only`) and a `cohort` allowlist of up to 1,000 actor IDs; `packages/gateway/src/collaboration/policy-client.ts` fetches `?milestone=m2` and `authority.ts` requires the requester, the owner and every participant to be in the cohort. Fourteen source files and eleven test files across gateway, platform and contracts reference this machinery. Person-to-person invitation identifiers (`identifier-resolver.ts`) resolve any Matrix user by actor ID, username or email.

Decision: sharing exists only inside an organization, so the organization becomes the gate and all three controls are deleted rather than enabled. This removes the fleet-wide `host.env` rewrite that flipping the flag would otherwise require, removes the departure-surviving personal grant rule from the evaluator, and removes the cohort branch from every authorization path. Deletion happens in S20 immediately after S01 so S02 contracts never model a personal audience. Security configuration (signing keys, key IDs, allowed origins) is not a release flag and stays, migrating to the asymmetric scheme in S05. With the kill switch gone, org membership must be a hard authorization check on every route and missing configuration must fail closed; absence of a registered handler is not a security boundary. Any person-to-person record found at cutover is dispositioned explicitly, never silently orphaned.

## R13 — Transport: transparent platform relay now, direct later

Customer VPSes generate a self-signed 30-day certificate at provisioning (`distro/customer-vps/cloud-init.yaml`, `CN=customer-vps.matrix-os.local`); the platform reaches them with `CUSTOMER_VPS_TLS_VERIFY=false`; and repository policy forbids per-user hostnames (`docs/dev/vps-deployment.md`). No browser can connect directly to any VPS today, so a direct client-to-home requirement would make zero computers eligible and would reverse a documented routing decision.

Decision: keep the platform in the byte path as a transparent relay and move all authorization to the home. The relay terminates TLS, forwards HTTP and WebSocket bytes, enforces coarse byte/connection limits only, and makes no allow/deny decision, parses no payload and logs no payload. This retains most of the value (no per-request platform authorization, no policy proxy, no schema coupling) without DNS or certificate work, and it is the smallest change from the current deployment. Payload privacy from the platform is an operational policy in this release, not a cryptographic property.

Direct client-to-home connectivity is a later upgrade. To keep it protocol-compatible: clients resolve the origin from the resource directory and never hardcode it; tickets bind the logical runtime ID and authority generation, never a TLS hostname; the home verifies tickets identically whichever ingress delivered them. The relay is extracted from `proxy.ts`/`websocket.ts` as a retained component rather than deleted, so the later switch is a directory change and a deployment, not a rebuild. Relay bandwidth cost is measured separately in T094.

## R14 — V1 is the minimum functional organization collaboration

The product owner will create organizations and add members in the Clerk dashboard. V1 therefore needs only a fresh Clerk membership projection (webhook plus reconciliation, fixed-expiry evidence), organization discovery and member listing for the share dialog, and the organization precondition on every path. Deferred, with their tasks retained in the ledger: in-product organization administration (S03 mutation routes, T077), groups and guests, invitation quotes and compute choices, billing, sponsorship and org-sponsored AI budgets (S14, T043 sponsorship), member-assigned computers and computer-to-computer transfer (S13), and managed Matrix group text (S16). Further trimmed on 2026-09-20: granular restrictions (most of S04 selectors, S07 filtered workspace, S12 catalog selectors), owner Git approval, per-Chat worktrees (S10 except the broker and share-time root inventory), integration delegation (S11) and Native Mobile/CLI parity (S17, recorded as a V1 limitation) are deferred. The worktree caution stands: canonical Chats may already own separate worktrees, so the share confirmation must inventory every Chat root visibly rather than assume one root. The release path is S00 → S01 → S20 → S02 → S03/S04 → S05 → S06/S07 → S08 → S09 → S10 → S12 → S15 → S18 → S19.
