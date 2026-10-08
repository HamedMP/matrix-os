# Aoede ownership and data model

The 2026-09-30 standalone correction supersedes active-Chat mounting, not canonical backend ownership. Target surfaces are Web Canvas and browser Web Desktop; the Electron Desktop host is deferred to a separate follow-up, so no Electron surface state is modeled here.

## Assistant binding

Owner-local PostgreSQL canonical metadata resolves one assistant backing conversation for authenticated owner + immutable runtime + stable workspace/project scope. A unique scope prevents racing icon/palette launches creating multiple conversations. Bootstrap is server-idempotent. Explicit New binds a stable request ID to replacement intent; historical Chats remain normal canonical records. Continue after End/reload resolves the binding. Missing/deleted/inaccessible backing records are reported, not silently replaced. Scope changes require explicit restart/new binding; ambient selected-Chat changes never retarget.

The binding is a pointer, not another transcript/provider/memory/task store. Export/deletion of conversation content remains canonical Chat. Runtime and owner come from trusted server identity, not request-asserted identity.

## Shell assistant owner

One shell-level, bounded ephemeral controller contains: immutable runtime/account identity; workspace scope; bootstrap request/generation and in-flight single-flight promise; canonical chatId/selection/readiness; visible/hidden state and invoking focus target; current captions and bounded canonical projection; one media client/session. Restore never restores permission/capture. Closed Chat does not own or dispose it. Dismiss stops media, not canonical actions. End ends ephemeral session, not conversation. Runtime/account teardown fences late work and releases capture/socket/playback/subscriptions.

## Canonical execution policy and tool inventory

Persist an immutable canonical run policy comprising source/provenance, memory/checkpoint policy and qualified execution inventory/revision/scope. One server decision applies to voice and typed turns during assistant ownership, queued/claimed/steered/retried turns and dispatch. Delegation is currently false/fail-closed; it may be enabled only when the existing canonical provider/task path propagates and enforces the same policy and operation identity. Session-only remains unsupported until all paths including provider retention and restart enforce it.

Each canonical tool declares normalized schema identity/revision, bounded validated arguments, risk, permission/scope, exact approval binding, idempotency/reconciliation strategy and cancellation granularity. conversation_only grants no tools; safe_reads grants individually verified bounded read/open tools; canonical_actions grants only individually qualified effects. Harness-native tool/config/plugin/network/delegated execution is excluded unless independently enforced.

## Canonical operation and authorization

Operation identity is owner/Chat/run/action/tool/schema/policy/scope-bound and persisted before dispatch. Normalized validated arguments produce an exact digest; approval previews redact secret values without losing intelligible effect. Authorization binds that digest and is revalidated/atomically consumed at dispatch. Argument/tool/schema/policy/scope mutation invalidates it.

States: proposed → waiting_for_approval → authorized → running → succeeded | failed | cancelled | timed_out | outcome_unknown. Unique claim prevents concurrent replay. Network effects happen outside transactions. Crash after possible commit/before result leaves unknown until downstream reconciliation verifies an outcome; unknown never automatically redispatches. Cancellation intent is distinct from confirmed cancellation and rollback. If delegation is later qualified, it uses the same policy and action identities, not a voice queue.

Navigation, artifacts and reconciliation outcomes require canonical durable representation rather than opaque tool-output JSON. An open-app result must identify a validated app/navigation intent; a file-apply result must identify bounded artifact references; outcome_unknown and later reconciliation must remain visible after Aoede dismiss/reopen and in canonical history. Aoede projects those canonical records and never parses arbitrary tool text as authority.

Current table ownership is the canonical Chat repository's idempotent initialization (`chat_action_operations`, `aoede_bindings`, `aoede_bootstrap_requests`). The implementation must either retain that single bootstrap owner and forbid route/session-time DDL, or move all three through a reviewed migration. It must never add a second schema creator.

## Existing voice session, turn, delivery and transport

Reuse existing bounded ephemeral VoiceSession/VoiceTurn records and canonical chat_voice_deliveries. Capture localOrder/finality/request ID maps once to canonical cturn/qturn/run identity. Provisional revisions never execute. Persist a non-empty pending manifest before playback, extend under revision/epoch fences, and require contiguous whole-segment acknowledgements. Unknown/crash/unheard suffixes are excluded conservatively from later spoken/typed context. Native checkpoints carry provenance and history boundary; unavailable eligibility disables unsafe native resume.

Relayed transport tickets are short-lived, one-time, path/principal/Chat/session/generation/epoch-bound. Reconnect rotates; Gateway restart cannot resurrect ephemeral media. Completed tracking/resources evict. Raw audio is transient and never persisted by default.

## Platform speech stream

Existing speech_operations and funding reservation/settlement remain authoritative. Add streaming synthesis as a compatible sibling to completed JSON synthesis: strict bounded NDJSON audio chunks, terminal end or safe error, mono 24kHz PCM S16LE with byte-derived durations. Total audio max 8MiB, frame max 64KiB, monotonically ordered chunks. Partial delivery/failure conservatively settles under existing policy, never silently repeats synthesis. Gateway sees runtime-scoped credentials only, not provider keys.

## Legacy data

Existing vocal-profile state is inspected only by explicit non-destructive compatibility/read paths. No silent import/delete, no new voice-owned memory writes. Preferences never grant permission or provider readiness.
