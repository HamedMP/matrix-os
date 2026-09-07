# Realtime and Execution Contract

**Status:** Design and proof requirements; no runtime compatibility is claimed by this document.
**Related:** [HTTP/auth contract](collaboration-api.md), [research](../research.md), [delivery plan](../delivery-plan.md).

## Browser/CLI attachment

Exact new routes are `/ws/collaboration/scopes/:scopeId/events` and `/ws/collaboration/scopes/:scopeId/terminal`. Both are private. CLI uses existing verified identity through platform; browser upgrade uses the authenticated same-origin session or an opaque one-use connection ticket from the HTTP contract. Register these exact patterns in browser query-token authorization, never a wildcard for owner runtime sockets. A ticket binds actor, scope, purpose and 30-second expiry; store only its hash, atomically consume once, redact query credentials from logs. Maximum 20 outstanding tickets/actor, swept every minute.

Platform checks Origin against the exact supported origins for browser connections and signs a fresh scoped upgrade proof. Gateway verifies purpose/audience/route, resolves current membership and runtime capability, and completes async authorization/subscription before sending `ready`. A failed setup sends a generic error best-effort then closes. Personal terminal/Chat sockets reject collaboration credentials. Existing public snapshot tokens from #1551 cannot authenticate these sockets or be exchanged for connection tickets; the snapshot relay never upgrades to live streams. Socket establishment is not permission to act forever.

Scope frames use a bounded versioned discriminated union. Common fields are `version`, `type`, `scopeId`, `resourceId`, `authorityGeneration`, and a scope-specific sequence/cursor. Actor is derived from the connection. Each incoming JSON frame is schema-validated after parse; invalid size/type/scope closes the connection. Binary terminal protocol framing retains its bounded parser and feeds the same authorized dispatcher.

| Stream | Messages / meaning |
| --- | --- |
| Scope events | `ready`, `changed`, `capabilities_changed`, `refresh_required`, `unavailable`; event ID, scope sequence, resource kind/ID and revision only. Fetch authorized content through HTTP. |
| Client lifecycle | `heartbeat`, bounded `resume` cursor; no client actor/role grants. |
| Terminal output | Ordered output with session incarnation, sequence and bounded bytes; terminal only, no parent/sibling event feed. |
| Terminal state | Controller actor label, lease epoch/expiry, exit/restore/availability; no owner host/process secrets. |
| Terminal actions | Same strict action union as HTTP; request ID, incarnation and mandatory applicable lease epoch. |

Scope events carry content-free invalidation metadata. Terminal output is the explicitly shared terminal content; it cannot use an owner-wide replay buffer. Streamed Chat content, if an existing adapter supports it, must be filtered into the same authorized scope and subject to identical checks; no owner-wide subscription fallback.

## Delivery, revocation and resources

Commit mutations and outbox together; broadcast only after commit. Replay is at least once, deduplicated by event ID/sequence. A cursor from another scope/generation is invalid. Expired replay returns `refresh_required`, never owner-wide history. Reauthorization occurs before every replay/live batch and before every input, command or mutation. No cached role can authorize a later action.

Revocation rejects new admission immediately at the authority commit and disconnects affected streams within 60 seconds. Serialize terminal input/transfer/revoke through one gateway-owned coordinator so a delayed old-controller action cannot pass after the fence. A batch already handed to the network cannot be recalled; do not promise removal of previously seen content. Downgrade preserves reads but invalidates controller/input authority and queued requests that need editor rights.

Connection caps: 256/gateway, 32/scope, four/actor/scope. Heartbeat every 10 seconds; stale after 30, sweep every five. Maximum JSON frame 64 KiB, outbound buffer 1 MiB/socket, replay 2 MiB/terminal session; scope events retain at most 24 hours or 10,000 rows. Slow recipients get refresh/close. Catch send failures per recipient, evict failed senders, continue others. Bounded coordinators use the same active-scope/session caps and release idle entries; timers and registries drain on shutdown before DB disposal.

Control lease lasts 30 seconds and renews every 10; transfer increments epoch and releases previous connection binding. Gateway restart invalidates all leases; reconnect explicitly reacquires. Do not replay queued keystrokes after reconnect. If replicas ever share one terminal authority, replace the local coordinator with shared fenced authority before deploying that topology.

## Canonical AI execution

An accepted shared request carries requesting actor, scope, immutable accepted sequence, operation key, execution generation and attempt lineage. Admission supports idle and busy Chats, maximum 32 pending and one running. The dispatcher rechecks actor role, scope epoch and runtime/policy readiness before starting. Reordering and steering personal queues must not affect the shared queue.

Discussion appends create no run. AI submission does not carry an owner principal, arbitrary root, credential or personal resume ID. The adapter receives a trusted scoped execution context constructed by authority. Resume state must match Chat+scope+execution generation+adapter and derive solely from shared execution. Historical visible messages may inform fresh context; hidden private session state, personal memory and tool credentials may not.

Claim approval/cancel/retry commands transactionally, then invoke adapter outside DB locks with the fenced command ID. Only one approval decision wins. Owner controls all permitted requests; editors cancel/retry their own requests; viewers do neither. Retry is a new attempt. Unknown external outcome becomes explicit interrupted/reconciling state; never automatically repeat a possibly completed tool effect.

Streaming output is attached to that shared request only and labeled with initiating human and AI authorship. Revoked queued authors cannot begin new work. Already-running execution follows existing run cancellation/recovery policy, preserving the spec's boundary rather than introducing a new billing or running-agent policy here.

## Native scope runtime and terminal eligibility

Use a system-owned native supervisor with a fixed versioned isolation profile and narrow local IPC, integrated through the existing runtime adapters. No Docker customer runtime. The supervisor accepts validated operations such as create/attach/stop scope runtime by opaque handle; it does not accept arbitrary service unit text, host mounts, commands under root, environment passthrough or caller-selected host paths. Run user work non-root in isolated filesystem/process/network namespaces with capped CPU, memory, processes and storage. Within PR2, the proof phase must choose and record concrete measured host/profile quotas before building and validating the adapter. Shared execution remains disabled until its consumer milestone is complete.

Mount only approved scope content plus required read-only runtime binaries. Personal home/system state, sibling process access, global memory, credential directories, service/database sockets and host environment secrets are absent. Direct access to loopback, metadata, private networks and host services is denied. Broker approved inference and other necessary services through a bounded scope/action interface; the trusted broker invokes existing account/access-source policy. Never return credentials or generic owner HTTP/SQL/shell capability to a child. A harness requiring an unbrokerable credential is unsupported until proven safe.

The fixed boundary is a proposed architecture, not proof that the current launcher or SDK is isolated. Before shared AI or Terminal support, test actual installed harness/native binaries against filesystem, process, network, socket, environment and resume escape attempts on disposable VPS-native Linux. Include timeout/crash/shutdown behavior and attempts through child processes and tools. A cwd setting, environment variable or application permission prompt is not this evidence. Keep a versioned support matrix and disable unknown profile/binary combinations.

Eligible standalone terminals start in the proven boundary while still private and retain the exact session/incarnation/process after sharing. An unrestricted legacy personal terminal fails preflight intact; replacing it with a fresh process is not a successful share of that session. A Chat-bound terminal cannot be independently shared to bypass its Chat scope. Project inventory distinguishes external references from owned terminals; an owned terminal unable to participate blocks whole-project activation. At least one real working adapter/session is required to complete M2/M3.

## Wiring and proof gates

Resolve authority, canonical Chat adapter, session registry, broker and supervisor clients at registration, before advertising capability. Missing or stale dependencies disable the corresponding capability with a safe reason. Run startup recovery before shared admission. On shutdown stop admission, fence commands, release controllers, drain connections and workers, then close resources only through their owners. Existing durable terminal processes survive observer disconnect and gateway restart where their native lifecycle supports it.

Required full-path tests: two actors through platform routing into the owner gateway and real storage; actor-isolated Chat discussion; one ordered AI run with tested scope isolation; same native terminal with concurrent control and delayed paste after revoke; complete project transition with source writers fenced. Record the exact platform/runtime/client and supervisor profile versions. Fake registry or SDK fixtures complement these tests but cannot establish runtime eligibility.
