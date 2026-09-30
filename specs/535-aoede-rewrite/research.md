# Aoede research and qualification ledger

## Product correction (2026-09-30)

Aoede is standalone presentation over canonical Matrix Chat, not active-Chat voice mode. The former claim that standalone presentation necessarily duplicates transcript/actions was incorrect: presentation, entry point and media ownership can be independent while canonical execution remains shared. Chat visibility is not required. A shell-owned singleton and explicit backing-conversation bootstrap are required.

Scope correction (same date): target surfaces for this delivery are Web Canvas and browser Web Desktop. Electron Desktop is deferred to a separate follow-up; the `electron_desktop` protocol enum value predates this work and remains for backward compatibility only. No Electron host, packaged-app qualification or Electron fixture surface is claimed anywhere below.

## Revalidated local baseline

Read-only git discovery confirms feat/aoede-rewrite at 505b331ad and thirteen modified baseline files listed by the owner. Preserve reconnect strict-response/accepted-resumed epoch and persistent parity Origin/speech changes. The baseline provider-catalog helper previously permitted tool-capable Codex based on MATRIX_VOICE_SIMULATOR; that eligibility bypass has been removed from `packages/gateway/src/chat/provider-catalog.ts`, which now takes a server-owned `qualifiedPolicy` instead (diff-verified this pass; the stale dist build output is not authority). `MATRIX_VOICE_SIMULATOR` remains only as the explicit fake speech-adapter selection in `voice-session/adapter-registration.ts`; simulator speech does not imply fake model/actions.

## Existing canonical authority

turn-admission.ts parses ordinary requests, folds live immutable policy, hashes idempotency, validates actual catalog selection, resolves project scope, selects delivery-aware native resume, persists Chat message/turn/run and dispatches through CanonicalChatOrchestrator. canonical-ports.ts calls this same orchestrator for speech and canonical queue on busy; its voice event labels are lossy and do not suffice for standalone approvals/input/artifacts. Reuse canonical content/event/client APIs for complete projection rather than inventing voice records.

## Managed speech findings

Read packages/platform/src/speech/DOMAIN.md and packages/gateway/src/speech/DOMAIN.md. Current Platform Speech already owns transcription AND completed-payload synthesis, runtime HMAC auth, policy, reserve/claim/settle/cancel and content-free operation metadata. Platform-only OpenAI credentials stay in the platform adapter. Gateway speech/voice-session-ports.ts currently yields a whole buffered PCM payload; this is not streaming. Add bounded streaming sibling API under the same funding/dispatch authority; do not invent Gateway production provider-key authority.

Rolling completed-WAV interim requests, if implemented, must be disclosed as bounded provisional polling and separately metered. They are not proof of genuine streaming recognition or latency. Measured speech quality/latency/account billing/retention remains an authorized-release gate.

## Provider qualification

Version-matched Codex source/schema, official docs and issue/maintainer evidence are required before selecting native enforcement options. Approval IDs, MCP tokens, receipt consumption and prompt instructions do not establish exact-argument authorization or exactly-once effects. Findings are recorded in the requirement/evidence matrix with precise versions and source links; one issue cannot establish upstream impossibility. Hermes activity is not a universal task service; Pi/OpenCode/kernel capabilities must remain qualified, not aspirational.

## Deterministic and live evidence boundaries

Fake-speech + fake-canonical-model/action composition may validate local control flow, no-paid-call invariants and presentation. PGlite is not Postgres process-crash evidence. Disposable real Postgres is required for operation claim/recovery/races. Real managed speech, actual Codex, real devices, production parity and performance/usability are NOT authorized in this pass; Electron Desktop qualification is deferred to the separate follow-up entirely. No prior green test counts are carried forward as current evidence.

## Primary source entry points

- https://developers.openai.com/codex/app-server/
- https://github.com/openai/codex
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/text-to-speech
- Local canonical admission/orchestrator/provider adapters and their pinned app-server schema/source are authoritative for deployed integration.

## Pinned Codex source and issue checks

Lead checks confirmed local `codex --version` reports 0.144.5. The repository launch pin is 0.156.1, while its schema registry reaches 0.158.0. No local/deployed version parity is claimed. GitHub tag rust-v0.156.1 resolves to commit b412ff32c417f855c2b2d1581b77058eed87c84b.

Pinned `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` exposes `environments`, `dynamicTools`, `config` and `ephemeral`. Empty environments explicitly disable environment access. Pinned `core/src/tools/spec_plan.rs` requires an environment plus ShellTool for native shell, and an environment for apply_patch/view_image. update_plan is gated by update_plan_enabled. Core model-specific utility tools may still be present and must not be silently described as an exact empty tool surface.

Pinned `ext/extension-api/src/tool_policy.rs` has an internal startup `allowed_tools` ceiling, but this does not establish a public app-server nativeTools field. No such protocol field is assumed. Canonical dynamic tool calls are the candidate host-executed boundary; inherited native config/plugins/MCP/environment access must be structurally excluded and inspected before qualification.

GitHub issue https://github.com/openai/codex/issues/6049 remains open. Earlier native-allowlist proposals are non-maintainer suggestions, not shipped guarantees. A September 22 report on 0.155.1 documents granular feature controls; it is a useful lead, not sufficient evidence alone. Maintainer-owned merged PR https://github.com/openai/codex/pull/35054 adds tools.update_plan.enabled and registration tests, contradicting the older unconditional-plan assumption. Issue https://github.com/openai/codex/issues/25569 documents approvalPolicy example/schema drift; its report does NOT establish that untrusted is unsupported. Source/schema precedence is required. Retrieved comments in those two issues did not establish a maintainer endorsement of a universal native allowlist.

## Legacy compatibility

Read-only code search found no live desktop vocal-profile read/write path in packages, shell or the shipped home template; historical specs/066-vocal-voice-mode describe system/vocal-profile.json. Existing owner files may survive and are neither read into model context nor imported/deleted by this implementation. Gateway voice/ is a separate telephony path, not the removed desktop voice authority. Keep onboarding out of this rewrite.
