# Aoede research and qualification ledger

## Product correction (2026-09-30)

Aoede is standalone presentation over canonical Matrix Chat, not active-Chat voice mode. The former claim that standalone presentation necessarily duplicates transcript/actions was incorrect: presentation, entry point and media ownership can be independent while canonical execution remains shared. Chat visibility is not required. A shell-owned singleton and explicit backing-conversation bootstrap are required.

Scope correction (same date): target surfaces for this delivery are Web Canvas and browser Web Desktop. Electron Desktop is deferred to a separate follow-up; the `electron_desktop` protocol enum value predates this work and remains for backward compatibility only. No Electron host, packaged-app qualification or Electron fixture surface is claimed anywhere below.

## Revalidated local baseline

High-mode read-only validation covered `1eafe737b2668a84592eacadb307707e094eb1a7..553fff73d` on `feat/aoede-product-rebuild` (37 commits, 249 changed files). The old `feat/aoede-rewrite` dirty checkout is an archive, not the implementation baseline. Preserve reconnect strict-response/accepted-resumed epoch and persistent parity Origin/speech changes from the parity base.

The former provider-catalog tool-eligibility shortcut based on `MATRIX_VOICE_SIMULATOR` is removed, and simulator isolation is now structural: `voice-session/adapter-registration.ts` evaluates the production check first, so `MATRIX_VOICE_SIMULATOR=1` is denied and logged in production and can never fabricate, mask, or replace the managed/direct decision; the simulator still discards captured audio while synthesizing deterministic bytes outside production. `dev:voice:simulator` is simulator composition, not real managed-speech integration. A standalone dual-surface fixture now exists at `tests/fixtures/aoede/ui-fixture` (Web Canvas and Web Desktop, Chat closed); the older `tests/fixtures/voice-session/ui-fixture` is labeled legacy Chat-attached and is not Aoede evidence.

## Existing canonical authority

turn-admission.ts parses ordinary requests, folds live immutable policy, hashes idempotency, validates actual catalog selection, resolves project scope, selects delivery-aware native resume, persists Chat message/turn/run and dispatches through CanonicalChatOrchestrator. canonical-ports.ts calls this same orchestrator for speech and canonical queue on busy; its voice event labels are lossy and do not suffice for standalone approvals/input/artifacts. Reuse canonical content/event/client APIs for complete projection rather than inventing voice records.

Current capability is narrower than canonical ownership: constrained Codex is the only consequential path with deterministic qualification, with five bounded app tools. Delegation is rejected and non-Codex frozen action policies fail closed. The coding adapter admits correlated bounded clarification under validated `canonical_actions` with delegation disabled; native approval and steering still fail closed. Activity projection is not a universal task service. Canonical detail now projects safe navigation, app-qualified file results and reconciliation state from persisted operations. Cross-app/traversal results are rejected; the newest bounded operations are retained. Fake consequential composition and disposable-Postgres crash tests prove these local boundaries, not actual paid Codex behavior.

## Managed speech findings

Read packages/platform/src/speech/DOMAIN.md and packages/gateway/src/speech/DOMAIN.md. Current Platform Speech owns transcription and streaming/completed synthesis, runtime HMAC auth, policy, reserve/claim/settle/cancel and content-free operation metadata. Platform-only OpenAI credentials stay in the platform adapter. A bounded readiness probe exists for transcription plus streaming synthesis. Production server composition now wraps the managed capability port with it (`speech/managed-readiness.ts` + `server.ts`): capability is unavailable until the probe reports transcription, synthesis and streaming synthesis ready; timeout, malformed responses and configured-but-unready states fail closed. Results are cached with bounded TTLs (positive ~30s, negative ~5s) under single-flight; simulator and direct adapters bypass the gate entirely.

Provisional recognition is currently unavailable. Any future rolling completed-WAV interim requests must be disclosed as bounded provisional polling and separately metered. They are not proof of genuine streaming recognition or latency. Measured speech quality/latency/account billing/retention remains an authorized-release gate.

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

## Constrained Codex refresh (2026-10-07)

The ordinary transport pin advanced to 0.161.0 while constrained execution still rejected everything except 0.156.1. The actual launcher-to-qualified-config test reproduced this startup failure. Constrained qualification now uses exact `rust-v0.161.0`, commit `979011409de0a60b52f179721948e65531d26144`, alongside the already-qualified 0.161.0 exec/app-server schema. Unknown versions and native checkpoint reuse remain rejected.

Reviewed official immutable sources: [feature registry](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/features/src/lib.rs), [configuration](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/config/src/config_toml.rs), [tool planner](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/core/src/tools/spec_plan.rs), and [thread contract](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server-protocol/src/protocol/v2/thread.rs). In this version, `orchestrator.skills` is a legacy no-op; explicitly disable `cloud.skills.enabled`. Also disable the now-default daemon auto-start. The existing native shell, MCP, plugin, delegation, memory, browser, image and plan exclusions remain, with empty environments, ephemeral threads and exact server-owned dynamic tool inventory. Unexpected native requests continue to be rejected by the owned runner.

A no-account probe against the official darwin-arm64 0.161.0 binary successfully completed strict configuration parsing, `config/read` with verified source layers, and `thread/start` with `ephemeral: true` and no environments. It made zero inference turns and reused no owner credentials. This revealed that Codex reports canonical filesystem paths: normalize the isolated parent with `realpath` so macOS temporary-directory aliases cannot make the sanctioned config layer look foreign. The regression preserves symlink/ownership/mode checks and rejects foreign source layers.

This configuration-only probe is distinct from model execution or physical voice acceptance. Fake-child runner tests verify isolated launch, dynamic-call binding and rejection of native approval/MCP/plugin/delegation requests. Full Linux CI and physical media qualification remain separate gates.
