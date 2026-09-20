# Organization collaboration on member computers

**Status:** Revised product specification for review; implementation is not started.
**Date:** 2026-09-20
**Baseline:** inspected main `94985f02e`; planning branch `codex/org-collaboration-spec`. Source inspection is not production validation.
**Decision:** owner-hosted project + shared group Chat + one owner-selected AI source + owner-controlled Git; direct transport and one coordinated cutover; no organization-wide computer requirement. Sharing exists only inside an organization; the organization is the only gate, and the legacy release flags and rollout cohort are removed rather than switched on. Transport is the platform as a transparent relay with all authorization on the home computer; direct client-to-home connectivity is a later, compatible upgrade.

## Product and placement

Members share a project, Chat, terminal, live app instance, file or folder with their Clerk organization, an organization group, or specific current members or admitted guests of that organization. There is no sharing outside an organization: every shared resource is bound to exactly one organization context, and every grant resolves against that organization's current membership or guest admission. Every resource has one authoritative home computer. Content, Postgres data, AI execution, worktrees, PTYs, integration execution and realtime fanout stay on member computers. Opening a resource does not require the recipient to own a computer.

An organization is an identity, policy, administration and billing boundary. It is not a mandatory shared VPS. Existing personal computers can host member-owned shared resources; the share itself is always scoped to one organization. An organization may sponsor an existing member computer or provision a computer assigned to a named member. Sponsorship does not change ownership. An org-owned member-assigned computer/isolated org namespace may host org-owned resources only with org-controlled recovery keys, backups and reassignment. Do not claim creator-independent durability for a personal host without that recovery contract. No pooled org computer, org-wide desktop, automatic machine conversion or fleet placement scheduler is required.

Keep actor, resource owner, host owner, assigned member, credential owner and payer distinct. A recipient connects to the resource's home, not a copied project on their own computer. Offline hosts show unavailable; no implicit new authority or writable replica is created.

## Opinionated first-release experience

1. The owner shares a project with their organization, an organization group, or specific members of that organization and chooses a capability preset. The default contributor preset covers the whole approved project; advanced restrictions remain available when needed.
2. Accepted contributors join the same default project group Chat, with named human messages. Discussion never automatically starts AI work. Read-only viewers can follow but cannot post; the ordinary collaborator preset includes discussion.
3. Everyone sees one canonical conversation, files and run queue on the owner's computer. An eligible contributor can explicitly request AI work through the owner's configured project source; subscription-only mode may instead permit only the owner to submit actual AI runs. This distinction is visible before joining.
4. The host executes the selected Codex or Claude harness locally. One run at a time per Chat; additional task Chats/worktrees are optional rather than a prerequisite for joining.
5. The project owner controls Git identity and remote credentials. Commit/merge/push/PR operations run through the host's scoped Git broker. Contributors propose changes; the owner approves exact commit/remote operations. Everyone sees requestor, approver and outcome in Matrix audit.

Default project Chat creation is idempotent and binds the project audience. A new member's join preview includes existing shared Chat history. For a member with narrower data access, a Chat must use a data ceiling readable by its entire audience; mixed-sensitivity history requires a separate restricted Chat or reviewed history publication, never silent disclosure. This keeps the default full-project group experience simple without making advanced restrictions cosmetic.

## UI baseline: the confirmed collaboration UX

The interaction model confirmed by the product owner on 2026-09-17 in `specs/525-collaboration-ux-redesign` (implementation log, "Confirmed Interaction Model") is the collaboration UI for this release. Shared Chat uses the ordinary Matrix timeline, composer, AI rendering and responsive frame; human discussion is a right-side in-session drawer on desktop and a full-height bottom sheet on mobile; access is one compact summary popover with an owner-only second-level manager; `Shared with me` is a first-class Chat navigation row with a bounded pending badge; shared terminals keep the ordinary terminal viewport with compact access, discussion, role and controller controls. The shipped components under `packages/ui/src/collaboration/` and `shell/src/components/collaboration/` are the starting point.

124 adds state and controls inside that chrome. It does not introduce a new collaboration header, transcript, composer, composer mode switch, share dialog, inbox or discovery surface. Implementers do not change the confirmed model on their own; a change to it is a product decision recorded in this section before the affected packet starts.

| Confirmed surface | What 124 adds inside it |
| --- | --- |
| Access popover and owner manager (`SessionAccessControl`) | Readiness summary (ready, owner setup needed, approval needed, host offline, unsupported), capability presets and editor, exact access requests |
| Share dialog (`ProjectSharingDialog`, `ShareChoiceDialog`, `ChatCollaboratorsDialog`) | Audience is the organization, a group or specific members instead of a free identifier field; preview shows the owner-selected AI source, submit mode and owner Git identity |
| Ordinary timeline and composer (`SharedChatControls`) | Run queue with `owner_only` versus `delegated` submit state, Git operation approval cards alongside existing approvals, worktree/branch status through the ordinary Chat worktree context |
| Discussion drawer / sheet (`SessionDiscussionLayer`) | Unchanged |
| `Shared with me` navigation row | Unchanged; organization and group shares appear there with the same pending badge |
| Terminal viewport controls (`SharedTerminalControls`) | Task profile / sandbox indicator |
| Settings | Organization administration (members, groups, guests, shared resources, member computers, billing and invite quotes) is the only new surface and lives as a Settings section |

Open UI decisions for the product owner (implementers must not resolve these by guessing):

1. **Contributor composer in `owner_only` submit mode.** Proposed: the ordinary composer is disabled with copy pointing to the discussion drawer; the removed Discussion/Ask AI composer switch is not reintroduced.
2. **Organization membership invitations.** Proposed: Clerk membership invites are accepted through Clerk's flow and Settings › Organization; `Shared with me` stays resource-level and does not list org membership invites.
3. **Settings › Organization visibility.** Proposed: a new visible Settings section, not one of the sections currently hidden by `HIDDEN_SECTION_IDS`.
4. **Share dialog audience picker.** Required by org-only sharing: replace the identifier field with an organization / group / member picker inside the existing dialog rather than a new dialog.

## Existing implementation and gaps

| Area | Verified source baseline | Required work |
| --- | --- | --- |
| Transport | `platform/src/collaboration/proxy.ts` forwards resource requests and performs per-request policy lookups; platform signs actor proofs; customer VPSes use self-signed certificates behind existing platform routing | Strip authorization, body parsing and payload logging from the forwarder so it becomes a transparent relay; homes verify tickets and enforce policy; authenticated peer operations |
| Authority | Gateway collaboration scopes, membership, events and adapters exist | Dynamic Clerk org/group grants, scoped capabilities, direct revocation |
| AI | `shared-ai-runtime.ts` selects a Claude-only profile; `scope-runtime-chat-adapter.ts` rejects execution roots/resume; shared capabilities report worktrees none | Safe shared Codex and Claude adapters, worktree roots, account-bound resume, brokered tools |
| Ordinary Chat | Canonical Chat execution roots support project/worktree; run admission records fingerprints | Reuse these records; prove shared UI/backend parity rather than assuming it |
| Accounts | Provider V3 contains accounts, access sources and instances | One project owner-selected V3 source; participant account selection deferred |
| Integrations | Custom MCP broker and projections exist; some credentials/execution are platform-backed | Computer-local credentials/execution for direct-capable connectors, exact action delegation, disclose vendor-hosted exceptions |
| Sharing | Project/app/file adapter seams exist; direct people and sync use different permission paths; person-to-person invitation identifiers resolve any Matrix user | Org-scoped audiences only, production wiring and one enforced resource policy |
| Release gating | `MATRIX_COLLABORATION_ENABLED` (hardcoded `false` in customer-VPS cloud-init), platform `collaboration_rollout_policy` milestone/mode/cohort table and gateway policy client gate every path | Remove all three; organization membership becomes the only gate and missing configuration fails closed |

## Identity and permissions

Clerk is authoritative for org membership and coarse roles. Matrix owns project/resource grants, groups, capability profiles and connection delegation in owner-controlled Postgres. Matrix room membership never grants access to projects or funding.

Clerk roles: owner/creator, admin, member, guest, billing manager and integration manager, mapped explicitly to configured custom permissions. Use `org:members:manage`, `org:groups:manage`, `org:resources:share`, `org:resources:manage`, `org:billing:read`, `org:billing:manage`, `org:integrations:manage`, `org:policies:manage`, and `org:audit:read`. Unknown role/permission mappings deny. Billing manager has no content privilege. Admins cannot read member-owned shares merely because they administer the organization. Resource owners may delegate share management explicitly.

Resource roles are editable presets (Viewer, Discussant, Contributor, Maintainer), expanded into explicit capabilities. Grants name audience, resource selectors, actions, policy version, expiry and approval requirements. A share preview explains exactly what this recipient can do:

| Capability family | Granularity |
| --- | --- |
| Content | file/folder IDs with read/write/create/delete/export; app instance and read/mutate actions; specific Chats and history visibility |
| AI | submit/cancel own run, steer, model/harness selection, approved funding sources, spend ceiling |
| Worktrees/Git | create/use worktree, inspect changes, commit, merge, push, delete; main checkout protected separately |
| Commands | approved task profile (executable, validated arguments, cwd, environment, network and mounts); unrestricted sandbox shell is an explicit stronger permission |
| Integrations | connection ID, tool/action IDs, read/write/send/delete, upstream resource scope, approval and credential owner consent |
| Management | invite, change policy, approve specific actions, transfer, publish; independent of content editing |

Effective access is lifecycle/fresh membership AND union of applicable allows AND mandatory org/resource ceilings, minus explicit deny rules. A deny always wins across overlapping grants. Every grant derives from one organization's current membership or guest admission; departure, removal or guest expiry ends every grant derived from it. No grant outlives membership and there is no personal grant path. UI explains the ended access.

This deliberately supersedes 121's unconditional all-contents access and the previous draft's prohibition on child restrictions. Project membership covers the project structure; inherited defaults may be narrowed by folder/app/Chat capability restrictions. New children inherit parent defaults and restrictions. Child grants cannot widen a parent ceiling. Moving resources requires an access-impact preview and fenced commit. Existing grants migrate with their exact action ceilings, never a silent broadening.

## Direct transport and cutover

In this specification, *direct* means the home computer is the sole authorization point: the platform makes no per-request allow/deny decision, parses no collaboration payload and logs no payload. In this release the bytes still traverse the platform as a transparent relay, because customer VPSes are reached through existing `app.matrix-os.com` session routing, run self-signed certificates and have no per-user hostnames. Direct client-to-home connectivity (per-home hostname plus browser-trusted certificate) is a later upgrade that must not require a protocol change.

The platform authenticates actors, resolves endpoints, manages Clerk projections, issues short-lived scoped proofs, distributes policy epochs and tracks billing. Its relay terminates TLS and forwards collaboration transcripts, PTYs, app payloads, file bytes, worktree patches and peer migration payloads as opaque bytes: no authorization decision, no schema parsing, no payload logging or tracing, coarse byte/connection limits only. Payload privacy from the platform is therefore an operational policy in this release, not a cryptographic property; do not market it as such. Current managed Matrix AI inference and explicitly vendor-hosted connectors remain named external data-processing paths; direct collaboration does not remove those services or imply end-to-end provider secrecy.

Browsers and native clients obtain a resource-scoped ticket and connect by HTTPS/WSS to the origin the resource directory returns, which in this release is the platform relay routed to the registered home. Clients never hardcode an origin. Tickets bind the logical runtime ID and authority generation, never a TLS hostname, and the home verifies them identically whichever ingress delivered them. Computers use authenticated HTTPS sessions with runtime identity and an actor-delegated operation ticket. Tickets never substitute for gateway-local resource checks. No generic owner session is issued to a collaborator. TLS endpoints, CORS/origin checks, replay resistance, key rotation, request/stream limits and expiring membership evidence are mandatory.

Every enrolled customer VPS is eligible in this release through the relay; no per-home hostname or browser-trusted certificate is required. Private/local computers, automated NAT traversal and mesh VPN remain future transport options. The relay is the transport, not a fallback; what is removed is platform-side authorization. Revocation push is paired with fixed-expiry leases, including long-lived streams and tool execution.

All applicable clients and serving runtimes switch together after backup, migration and validation. Remove per-request platform authorization, policy lookups, body parsing and V1 proof/ACL fallback from the proxy and WebSocket bridge, leaving a transparent byte-forwarding relay for HTTP and WebSocket. Preserve user data, stable IDs, personal non-collaboration billing and public snapshots. Sequential development PRs are allowed, but there is one release acceptance gate. Rollback uses a direct-protocol-compatible build or makes collaboration unavailable; it never restores a permissive legacy reader.

## Release gating: the organization is the gate

The legacy collaboration release controls are removed, not switched on. That covers the `MATRIX_COLLABORATION_ENABLED` environment flag (platform wiring, gateway wiring, system info, the customer-VPS cloud-init template and the platform deployment workflow), the platform `collaboration_rollout_policy` table with its milestone/mode/cohort allowlist, the gateway policy client and every cohort or milestone check in authority, WebSocket, terminal and shared-AI paths. Because the flag was written once at provisioning and never rewritten, deleting it is cheaper and safer than fleet-wide flipping: existing `host.env` values become inert and no in-place rewrite is required.

Collaboration wiring always constructs. The organization precondition is a hard authorization check on every collaboration route, WebSocket upgrade, queue claim, tool invocation and integration action: an actor without current membership or admitted guest status in the resource's organization is denied regardless of Clerk session validity, direct reachability or selected org. Missing signing or origin configuration fails closed with a logged generic denial; it never skips a check and never opens a route. No gradual-rollout mechanism replaces the cohort. If staged access is required, it is an organization-creation entitlement on the platform, not a collaboration cohort.

Person-to-person sharing was never enabled on customer VPSes. Cutover inventories any person-to-person scope, grant or invitation record on platform and gateway databases; the expected count is zero. Any record found is terminated with notice or explicitly re-homed into an organization by its owner. Nothing is silently orphaned or auto-converted.

## One owner-selected AI source

V1 has one owner-selected funding/account binding per project, resolved through existing Provider V3. Collaborators see “Runs on the owner's computer; funded by [configured source]” and do not need to add AI accounts. The owner can change the binding between runs using existing account settings; there is no collaborator account picker, subscription pool, per-actor sign-in on the host or quota-driven account rotation. Existing personal multi-account settings are reused only for owner selection, not expanded into a new collaboration subsystem.

Use the owner's subscription when the provider permits that exact operation and caller model. Owner-only native subscription execution is distinct from making that subscription available to other people. Do not infer multi-user authorization from the fact that the process runs on the owner's computer. Without evidence permitting delegated requests, contributors can discuss/propose work while the owner explicitly initiates their own runs; this is not a rubber-stamp proxy for prohibited shared use. For collaborators to submit AI work directly, configure an eligible owner-controlled API/business/Matrix AI source with explicit delegation and applicable provider agreement. Owner approval cannot override provider eligibility. Never silently switch to paid API usage when a subscription is unavailable.

The project owner chooses model/harness, permitted submitters, budget and integration/task profile once. Org sponsorship may fund the selected eligible source without an org-wide computer. Pin requesting actor, executing owner, account/access-source/model, scope/worktree, Chat audience, authorizing policy and original payer on every run. Source exhaustion/disconnection pauses work and preserves the request; no fallback card or account. Usage is provider-reported or explicitly unknown.

Canonical shared history is separate from the owner's private provider session: create a project/Chat-scoped session seeded only from shared authorized context. A changed account, root or audience requires a fresh session unless a tested adapter proves safe continuation. Serialize the shared Chat queue; optional separate Chats/worktrees may run subject to the same owner-source limits.

Multi-participant accounts, named actor seats on another member's host and automatic source routing are future scope, not first-release gates. Stable run binding fields preserve that extension point without implementing it now.

## Owner-controlled Git identity

Use the project owner's configured Git author/committer identity for newly created host commits and the owner's authorized forge credential for pushes and PR creation. Preserve existing imported authorship; never impersonate a collaborator or invent a configured identity. If the owner uses an explicitly configured service identity, show it as such. Missing Git/forge configuration is an owner setup action; collaborators never need to connect GitHub just to join.

The Matrix audit preserves the requesting human, AI run, worktree, approving owner, commit SHA and remote PR URL independently of Git authorship. No automatic co-author trailers. Contributors may edit via their task capabilities and propose commit/PR actions; committing, merging, pushing, creating/updating PRs or changing remotes is owner-controlled in V1. Owner approval binds the exact tree/ref digest, target remote/branch and operation, expires and is consumed once; new changes require fresh approval. Force pushes, branch protection bypass and broad forge tokens are not implied.

Git/forge credentials stay in the local operation broker, outside Chat agents and PTYs. An agent cannot bypass owner approval with raw git/gh commands, credential helpers, shell/network calls, alternate Git config or MCP/forge integration actions. Owner-controlled Git restrictions are mandatory ceilings across the generic capability model. An org admin is not automatically the personal project's Git owner.

## Chats, worktrees and project concurrency

Canonical Chat already models worktree roots; shared Chat does not yet support them end to end. Deliver a shared Chat worktree picker, branch/status, create/reuse controls and restore behavior across Web Canvas, Web Desktop, Electron Desktop and applicable mobile/CLI. Joining the default project group Chat uses its existing root without creating another worktree. Starting an additional coding Chat offers a new worktree by default; explicitly reusing one requires the existing write-lease rules. Multiple viewers of the same Chat use its same worktree. Different Chats may use distinct worktrees concurrently.

One writable lease per worktree; separate Chats cannot silently edit the same root. Main is protected; commit/merge/push/PR require owner approval and ref/tree-revision checks even when a Contributor preset otherwise allows edits. Worktree locks, run cancellation and recovery survive restart. Chat deletion does not delete a dirty worktree. Cleanup verifies no active run/terminal, retained user edits and reviewed merge state. Branch deletion, merge conflicts, missing roots and an offline home show recoverable states.

A Git worktree is not a security sandbox. All tool execution runs in OS-enforced isolation. Full-project authorized workers may use managed Git worktrees. A restricted-folder worker gets a filtered workspace without the shared Git object database, outside paths, hooks, personal config or credentials; allowed changes are committed back through the home authority under revision checks. No sparse-checkout-only security. Missing dependencies are shown before execution; users may request access or use an approved task profile, never get silent broader mounts.

Shared transcript/tool output can reveal data. Each Chat has a content audience and maximum data capability boundary; AI reads/integration results must be safe for that audience, not merely the initiating actor. Run inputs/results and produced artifacts retain their audience restrictions. Publishing/merging restricted artifacts into broader resources requires explicit content-owner authorization and a review step. Policy narrowing invalidates sessions and affected history projections; UI hiding is not a security boundary. If historical mixed-sensitivity content cannot be proven safe, restrict that Chat to the narrower audience or create a new appropriately scoped Chat.

## Integrations and ready-to-work sharing

A shared project declares required apps, folders, task profiles and integration actions. The owner configures a reusable capability profile and the recipient sees a readiness summary before acceptance/first run: ready, owner setup needed, approval needed, host offline or unsupported. The default connection/task profile is configured by the owner; participant account setup is not required. Actionable access requests name the missing capability, intended operation and approver; accepting an invitation grants only the reviewed profile.

A connection grant selects the credential owner's exact connection, allowed tools/actions and upstream scope (for example one repository or channel). Credentials remain in an isolated local broker, outside tool subprocess environments and filesystem mounts. The broker reauthorizes at every call. Personal connections are not implicitly shared with a project. Connectors whose upstream API cannot enforce a needed resource boundary are unavailable for that restricted profile. External sends/deletes can require per-action approval by a separately authorized approver. Tool lists and approval prompts derive from the same policy.

Run capabilities constrain subprocesses, MCP, app bridges, HTTP, network egress, files, previews and terminals. An executable allowlist alone cannot contain scripts/interpreters; arbitrary project code is confined by the sandbox and cannot reach credential brokers except through scoped authenticated operations. Direct terminal access grants explicit sandbox execution authority. Remote integration execution on another member computer uses an exact operation ticket and account-owner delegation; the platform carries only coordination metadata.

## Billing, invitations and lifecycle

Before sending an org invitation, admins see server-quoted current total, extra recurring charge, immediate/prorated estimate, effective date and compute choice: no new computer, sponsor an eligible existing computer, or provision a member-assigned computer. Do not invent seat prices; unconfigured commercial items remain unavailable. Pending invites create no charge or VPS. Acceptance revalidates the quote; changed pricing needs renewed payer approval. Accepted membership and paid compute activation are distinct states. Provisioning starts only after entitlement is confirmed; retries/failed payments cannot double charge.

Existing personal computers stay personal by default. Sponsoring hosting changes payer prospectively with owner consent and explicit personal-subscription handling; it does not transfer data. A new member-assigned computer supports selective direct transfer of projects/apps/Chats/files/worktrees after preview and dual consent. Credentials, personal memory and private drafts never migrate. Whole-machine adoption is deferred. Departure immediately revokes org access; org-managed assignments/resources stay recoverable by the org, while personal data remains personal and no grant outlives membership.

## Acceptance and exclusions

Release tests must prove the organization-only precondition on every path with no environment flag or cohort record consulted, fail-closed behavior on missing configuration, two-computer access through the relay with no platform authorization decision and no payload parsed or logged there, home rejection of forged/expired tickets delivered by the relay, revocation during partitions, multiple actors using one eligible owner source, default group Chat and owner-approved Git/PR actions, shared Codex and Claude worktree runs, exact integration action grants, folder/Git/terminal escape denial, filtered history, granular app access, invite quotes and member-computer migration. Use real Postgres races and disposable enrolled VPSes; no claimed provider support without versioned live evidence. Include all applicable surfaces and a separate documentation PR in `FinnaAI/matrix-os-site/content/docs/`.

Deferred: direct client-to-home transport (per-home hostname and browser-trusted certificate), sharing between individuals outside an organization, participant AI accounts/source routing, copy-and-continue, pooled org computer, automatic whole-personal-machine adoption, arbitrary disconnected/offline writes, peer replicas as co-authorities, CRDT editor collaboration, general NAT/mesh/relay services, direct native Matrix room participation. Unsupported personal subscription modes must remain explicit unavailable states; sponsored API modes and both required harnesses still need acceptance evidence.

## Future: copy and continue on my computer

This is an explicit independent fork, not live collaboration or an ownership transfer. An authorized org member with copy/export rights can later choose a source revision/worktree and a destination computer. Pin the commit SHA; for dirty current state, offer an explicit owner-reviewed snapshot/patch including permitted untracked files. Git clone/bundle fetch of the pinned state is preferred, with Git LFS/submodules handled explicitly. Do not quietly omit dirty edits or claim a clean HEAD equals the current workspace.

Create a new project identity, private/default destination grants and a provenance link. The destination member uses their own Git identity, remotes and AI source. Do not copy credentials, integrations, provider resume state, private Chat drafts, grant lists or billing sponsorship. Chat history and app database state are separate explicit exports; Git alone does not clone them. Full repository export requires permission to its history; restricted-folder members cannot receive the entire Git object graph and need a filtered export. Existing collaboration on the source continues unchanged; later PRs are normal Git contributions, not automatic bidirectional sync. No clone endpoint or execution task is activated in V1.
