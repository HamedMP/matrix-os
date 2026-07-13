# Failure Modes and Recovery

| Failure | Required behavior | Recovery / evidence |
|---------|-------------------|---------------------|
| OpenClaw not installed | Descriptor is `missing`/`unavailable`; selection mutation rejected; Chat and Hermes unchanged. | Offer install/setup action. No auto-install from a read. |
| OpenClaw installed but gateway stopped | Descriptor is `stopped`; settings can request a bounded start only through the controller. | Probe after start; keep old selection if unhealthy. |
| OpenClaw gateway token missing/unreadable | Treat as unavailable; do not fall back to unauthenticated RPC. | Regenerate through owner-only installer/control path; audit coarse failure. |
| Runtime probe timeout | Return the rest of Agent settings with that runtime `unknown` or `unreachable`. | Retry independently; never fail Chat settings as a whole. |
| Runtime catalog malformed/oversized | Drop malformed entries, cap valid entries, mark degraded if no usable model remains. | Log runtime id + validation issue count only. |
| Provider auth expired | Mark `action_required`; do not expose upstream response or account. | Show API-key/login/base-url recovery action. |
| Auth expires after selection | Runtime work fails safely and stops new delivery if required; Chat stays independent. | Refresh status; owner reauthenticates, then delivery resumes. |
| Key validation service unavailable | Do not persist an unvalidated key unless the runtime explicitly provides atomic validate-and-save semantics. | Return retryable generic setup error; keep prior credential. |
| Unsafe custom base URL | Reject before persistence or fetch. | User supplies an allowed HTTPS endpoint. |
| Runtime switch during active conversation | Pause new delivery claims, drain at most 5 seconds, abort remaining runtime work, recheck permissions before any reply. | Activate target only after old adapter no longer accepts work. |
| Runtime switch target health fails | Do not persist target; restart/reactivate prior runtime and resume delivery. | Return `runtime_switch_failed`; audit from/to/result only. |
| Failure after target persisted | Roll back file revision and process selection under same lock. | Startup reconciler repeats rollback if the process dies mid-step. |
| Gateway crashes mid-switch | Transition file and lock remain bounded; OS releases lock fd. | Startup reconciler compares persisted selection, transition state, and service health; chooses last persisted healthy runtime or disables messaging, never both. |
| Two shells switch concurrently | One controller holds exclusive lock; stale revision or busy conflict rejects the other. | Client refreshes and retries deliberately. |
| Legacy client writes model/effort during switch | Atomic file merge preserves `agent.*`; no shared whole-object rewrite. | Both changes survive or one receives a filesystem/concurrency error, never silent deletion. |
| Per-message override invalid | Frame rejected before dispatch. | Client chooses an advertised kernel model/effort. |
| Per-message model disappears after settings load | Dispatcher revalidates at dispatch time and rejects safely. | Refresh catalog; saved default remains. |
| Stored conversation id malformed | Route returns validation error without touching filesystem. | Client supplies an id from the conversation list. |
| Conversation absent | 404 coarse not-found. | Mobile refreshes conversation list. |
| Conversation store read error | Safe 5xx, not 404 and not empty transcript. | Retry; server logs error class only. |
| System config malformed | Preserve current fail-safe kernel defaults; Agent settings reports safe configuration error for mutation. | Owner/operator repairs config; do not overwrite unknown malformed content automatically. |
| Hermes dashboard unavailable | Hermes descriptor degraded; existing detailed dashboard shows offline; Chat unchanged. | Service retry/systemd status. |
| Messaging permission revoked during runtime output | Abort running work; discard output; pre-send revision check prevents reply. | Audit revocation race without content. |
| Selected runtime removed during host update | Startup health marks selection unavailable and messaging disabled. | Do not silently select another runtime; owner chooses after install/health. |
| Preview lacks route-precedence fix | Provider setup terminal creation fails through deployed bundle despite source branch. | Verify exact release SHA, deploy backend-stack tip, rerun authenticated end-to-end action. |

## Fail-Closed Invariants

- Chat is never stopped, restarted, reconfigured, or gated by messaging-runtime health.
- No switch results in two runtime adapters claiming the same Matrix work.
- No unhealthy target becomes the persisted active runtime.
- No failure automatically weakens authentication, room permission, endpoint validation, or tool policy.
- No raw runtime/provider/service error crosses the client boundary.
- A missing optional runtime is a supported product state, not a gateway boot failure.

## Startup Reconciliation

1. Read the persisted messaging selection with a strict schema.
2. Check for a transition marker; ignore symlinks and reject oversized/malformed files.
3. Probe only fixed runtime services with bounded commands.
4. If selected runtime is healthy, ensure only its delivery adapter can claim new work and remove stale transition state.
5. If transition shows a verified-but-uncommitted target, roll back to persisted selection.
6. If persisted selection is unhealthy and the other runtime is healthy, keep messaging paused and report action-required; never silently switch owner choice.
7. If neither runtime is healthy, disable optional messaging delivery and keep Chat/gateway healthy.

## Mid-Conversation Semantics

A Chat conversation is unaffected because it runs in the kernel. A messaging “conversation” may have queued work associated with a room:

- Queued work remains in Matrix-owned storage and can be claimed by the new runtime only after activation and a fresh permission check.
- Running work is given a 5-second drain. If incomplete, cancellation is requested and any late output is discarded by runtime/transition id and permission revision.
- Draft/approval-required replies remain Matrix-owned. They can be sent after switch only after a fresh permission check and are not regenerated automatically.
- A reply already accepted by the homeserver is recorded as sent; switching cannot retract it.
