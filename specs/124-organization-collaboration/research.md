# Research and decisions — direct member-computer collaboration

Inspected 2026-09-20 against main `94985f02e`. These are source findings and design decisions; no deployment or provider spike was run. The previous central-proxy/pooled-org-runtime delivery plan is superseded by this revision.

## R1 — Reuse authority; replace transport

`packages/platform/src/collaboration/proxy.ts` signs actor proofs and forwards allowlisted resource routes. `routes.ts` consumes request bodies; `websocket.ts` participates in tickets. Gateway `collaboration/authority.ts`, actor proofs, events, terminal control, directory outbox and transition journals are reuse points. Today the platform is in the payload path. Direct endpoints must be enrolled/TLS-verified; a hostname existing is not proof of safe direct exposure.

Decision: ticket/discovery/control on platform, content on registered resource home. Browser-to-home and authenticated peer-to-peer HTTPS/WSS ship together. No collaboration payload relay fallback after cutover. Direct-ineligible hosts show offline/unavailable. Lightweight control refresh, billing metering and discovery still load the platform; measure this separately from content bandwidth.

## R2 — No organization-wide computer

A resource home is one member computer. Runtime ownership, assignment, resource ownership and payer differ. Org-managed member-assigned computers can retain org namespaces and recovery after departure; personally administered machines cannot promise org durability by storing an org ID alone. Keep personal resources personal unless explicit transfer targets a verified org-managed member assignment. This honors owner-controlled storage without provisioning a pooled org desktop.

## R3 — Worktree support exists only in part

`packages/contracts/src/canonical-chat-primitives.ts` defines project/worktree execution roots. Gateway `chat/execution-root.ts` resolves managed paths and fingerprints. `chat/turn-admission.ts`, `queue-admission.ts` and `orchestrator.ts` persist/recheck execution roots; `chat/coding-provider-adapter.ts` forwards worktree IDs. Desktop stores already track worktree context.

However `collaboration/scope-runtime-chat-adapter.ts` rejects `executionRoot`, resume state and non-text parts. `chat-execution-adapter.ts` reports worktrees none; `shared-ai-runtime.ts` has a Claude-only fixed profile. Thus shared Codex/Claude worktree execution and its Chat UI are required new integration work. Do not change capability flags to true without sandbox/provider/end-to-end evidence.

## R4 — One owner-selected AI source; participant accounts later

Provider V3 (`packages/contracts/src/ai-provider.ts`) already models accounts, access sources and instances. Reuse the owner's existing selection; one project binding and immutable run snapshot are enough for V1. Building isolated participant enrollment, account routing and cross-actor credential profiles is not a cheap UI toggle and is deferred. The shared session starts from authorized project history, not the owner's private harness state.

Official guidance checked on 2026-09-20:

- [OpenAI terms](https://openai.com/policies/terms-of-use/) restrict making an individual account available to others. A process location does not establish delegated subscription rights.
- [Claude Code legal/authentication guidance](https://code.claude.com/docs/en/legal-and-compliance) distinguishes a user signing into an unmodified hosted binary from third-party credential intermediation, and discusses customer-controlled API credentials. Verify the applicable hosted/customer contract before enabling a funding mode.
- [Claude Agent SDK plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the June usage-billing change was paused; it does not authorize pooling individual subscriptions.

Decision: honor owner-source simplicity. Owner subscription is available for eligible owner-submitted runs; contributor AI submission requires a source whose applicable terms support delegation. Otherwise contributors discuss/propose and only the owner initiates their own work, rather than an automatic approval proxy. Eligible owner-controlled API/business funding supplies direct collaborator requests without adding participant accounts. No silent paid fallback. Provider-specific verification is a capability gate, not a claim of legal clearance from these documents.

Required probes: shared Codex/Claude project roots, owner source selection, owner-only versus delegated submission, safe project session resume, cancellation, approvals, exhaustion and bounded concurrent worktrees. Participant native sign-in/multi-account routing is future work.

## R5 — Clerk handles coarse org permissions

[Clerk roles/permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions) supports custom permissions; system permissions are not included in session claims. Configure Matrix custom permissions for server authorization and enforce the corresponding Clerk management authority for Clerk mutations. Do not create a Clerk role/claim for every folder, tool or project. Those selectors live with resource grants on the home computer. Membership freshness is independently checked; a signed old JWT alone is insufficient.

## R6 — Granular access changes the project contract

121/previous 124 whole-project unconditional inheritance cannot express selected folders/apps/tools. Replace it with inheritable defaults, explicit ceilings and deny-wins selectors. Migrate old broad grants faithfully, never silently restrict/widen them; owners may then deliberately narrow. A scoped shell with the entire Git object database can read denied files, so filtered workers cannot receive raw shared Git metadata. Arbitrary scripts also defeat executable-name-only policies. Enforce mounts, UID/process boundaries, network and credential broker capabilities.

Chat history is itself shared data. A broad Chat cannot receive narrow-only tool results. Admission checks the Chat audience's data ceiling, and restricted artifacts cannot be auto-published into a wider tree. New grants to historical Chats require inventory/history review; revocation cannot recall bytes already delivered.

## R7 — Integrations require custody and action delegation

`packages/gateway/src/integrations/custom-mcp/broker.ts` uses platform DB-backed connection records and projections. Existing registry/routes/bridge and custom MCP client are useful seams, not proof of per-project delegation. Inventory each connector's execution/credential location. Move direct-capable user-managed connections to a local encrypted broker and remove their legacy execution route at cutover. Provider-hosted connector services may remain explicit external processors; never promise that such requests avoid the vendor. Token migration requires documented custody authorization, staged encrypted transfer or reconnection; never copy OAuth tokens through Chat/transcript exports.

## R8 — Durable migration, not permanent compatibility

Keep immutable source IDs, exact old action ceilings and recoverable journals. Offline/ambiguous sources cannot activate. Prepare and validate migrations during a maintenance gate, then activate only direct-capable clients/runtimes. Delete old serving fallback paths; rollback only to compatible builds. Data backup and transient migration readers are necessary for safe cutover and do not constitute a second long-lived product path.

## R9 — Matrix communication remains separate

Use private service-only Matrix group text through fresh org/group authorization as previously planned; no AI transcript/file mirroring or native user token bypass. Spaces do not recursively enforce resource grants. This bounded messaging service is explicitly outside the computer-owned resource payload path. A homeserver partition test remains required.

## R10 — Group Chat and Git owner are opinionated defaults

Idempotently create one default project group Chat and root. Join reuses both; additional task Chats/worktrees are optional. Everyone has a named Matrix actor; read-only viewers cannot post, normal Contributor includes discussion. Human discussion is separate from AI submission. The project owner controls the selected source and Git identity. New local commits use configured owner author/committer; pushes and PRs use the owner's configured forge account. Imported commit history is untouched; requestor attribution lives in Matrix audit, not fabricated Git authorship.

Owner approval must bind exact tree/ref/remote/action and be enforced through a credential-holding Git broker even if generic task/integration permissions otherwise allow shell or forge actions. This is required for the simple owner-control promise; a UI-only approval is insufficient. Collaborators can propose changes without GitHub/AI onboarding.

## R11 — Copy-and-continue is a future fork

An independent Git-based copy should pin SHA plus explicitly approved dirty/untracked snapshot, handle LFS/submodules, and create a new project under the destination member's own Git/AI configuration. It neither moves source authority nor copies its permissions/credentials. Restricted members must not receive invisible repository history. Chat and app database exports require separate explicit decisions. Document the extension now; do not implement it in the initial direct collaboration release.

## R12 — The organization is the only gate

Three independent release controls gate collaboration today. `MATRIX_COLLABORATION_ENABLED` is `'true'` on the platform Cloud Run deployment but hardcoded `false` in the customer-VPS cloud-init template (`packages/platform/src/customer-vps.ts`, `distro/customer-vps/cloud-init.yaml`); it is written once into `/opt/matrix/env/host.env` at provisioning and nothing in `distro/` rewrites it afterwards, so template changes reach only new VPSes. The platform `collaboration_rollout_policy` table stores a per-milestone `mode` (`off`/`internal`/`enabled`/`read_only`) and a `cohort` allowlist of up to 1,000 actor IDs; `packages/gateway/src/collaboration/policy-client.ts` fetches `?milestone=m2` and `authority.ts` requires the requester, the owner and every participant to be in the cohort. Fourteen source files and eleven test files across gateway, platform and contracts reference this machinery. Person-to-person invitation identifiers (`identifier-resolver.ts`) resolve any Matrix user by actor ID, username or email.

Decision: sharing exists only inside an organization, so the organization becomes the gate and all three controls are deleted rather than enabled. This removes the fleet-wide `host.env` rewrite that flipping the flag would otherwise require, removes the departure-surviving personal grant rule from the evaluator, and removes the cohort branch from every authorization path. Deletion happens in S20 immediately after S01 so S02 contracts never model a personal audience. Security configuration (signing keys, key IDs, allowed origins) is not a release flag and stays, migrating to the asymmetric scheme in S05. With the kill switch gone, org membership must be a hard authorization check on every route and missing configuration must fail closed; absence of a registered handler is not a security boundary. Any person-to-person record found at cutover is dispositioned explicitly, never silently orphaned.
