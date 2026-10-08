# Implementation plan: standalone Aoede

**Branch:** feat/aoede-product-rebuild. **Base:** `1eafe737b2668a84592eacadb307707e094eb1a7`. **Reviewed checkpoint:** `553fff73d`. **Authority:** owner correction 2026-09-30 and spec.md. This replaces the former Chat-mounted delivery plan. No full runtime, paid calls, shared infrastructure/database mutations or publishing are authorized. **Scope:** Web Canvas and browser Web Desktop only; Electron Desktop is deferred to a separate follow-up and has no worker, fixture surface, gate or completion claim in this plan.

## Architecture

One shell-level assistant owner holds visibility, invoking focus target, immutable runtime/account/workspace identity, bootstrap in-flight single-flight request and the one shared media client. It survives Chat/app/presentation switching. Surface hosts supply workspace navigation and nonmodal geometry, not another state machine. Opening never starts media.

A Gateway assistant bootstrap resolves/creates an owner-local canonical backing Chat using idempotent durable identity. Continue reuses it; explicit New uses a stable request ID. End releases only voice resources. Deletion/access loss is surfaced without automatic replacement. Bootstrap cannot choose another owner/runtime or bypass normal provider readiness.

Canonical Chat owns action qualification and execution. Its immutable run policy is persisted and checked at admission, queue/dequeue, steer/retry and actual provider dispatch, including typed turns while assistant ownership applies. A canonical per-tool inventory and operation authority binds exact validated normalized arguments and schema/policy/scope identity. Side effects persist an operation before unique claim; ambiguous dispatch is outcome_unknown with no automatic replay. At the reviewed checkpoint, this qualifies constrained Codex plus five bounded app tools only. Delegation and non-Codex action policies remain fail-closed; native canonical Codex input/approval delivery is unavailable. Future parity must extend the existing canonical provider path without weakening policy or adding Aoede execution authority.

Speech/media adapters are restricted to capture/transcription/synthesis. Platform Speech remains credential/funding/metering authority. Reuse the implemented additive bounded streaming synthesis protocol while preserving v1 file APIs and durable funding lifecycle. Interim transcription cadence, if built from bounded rolling file requests, is explicitly identified as provisional polling rather than genuine realtime recognition.

## Design direction

Compact independent assistant, not a window full of Chat. A restrained interference-ring ambient visual is supplementary to literal status. Use existing Matrix font/theme tokens; steel/ink neutral foundation, cool signal accent and distinct warning/error tokens from the shared theme. Scope and microphone state sit directly under Aoede's heading. Current captions precede canonical control cards; control row is stable. Cards appear only for actual approval/input/progress/result records. Settings are progressively disclosed. No general composer/message list, no fabricated animation/progress.

## Remaining delivery units and exclusive ownership

1. **Production truthfulness:** reject simulator registration when `NODE_ENV=production`; rename/redefine simulator integration scripts; wire bounded managed STT + streaming-TTS readiness into capability with fail-closed unknown/timeout behavior.
2. **Required capability completion:** ship the spec's complete minimum matrix: standalone canonical provider/model selection and local recovery; constrained Codex conversation plus the five bounded app tools; exact approval and bounded clarification/input; canonical activity/navigation/artifact/result/reconciliation; history; and generation/action cancellation. Delegation and arbitrary native/OS tools remain disabled and are not delivery requirements.
3. **Standalone UX completion:** persisted hands-free/PTT selection, input/output device selection, device removal and permission recovery, batch-final caption truthfulness, palette invoker focus restoration, result/navigation handling and complete nonmodal accessibility states.
4. **Fixture and data evidence:** replace/label the legacy Chat-attached voice fixture; add standalone Web Canvas and Web Desktop Aoede hosts with Chat closed; require fixtures to assert both speech and canonical model/action adapters are fake. Include canonical action concurrency/recovery in disposable-Postgres gating.
5. **Schema and contract consistency:** choose either existing canonical idempotent bootstrap DDL or reviewed migrations as the one schema owner; prohibit route/session-time schema creation. Align API prose and contract-drift tests with common frame identity, resume/correction and generation/action cancellation.
6. **Deferred provider expansion:** after the minimum matrix is complete, additional existing Chat providers/tools/tasks may be qualified only through their canonical adapter boundaries. They do not block this delivery and cannot replace its required constrained-Codex path. Do not create Aoede-native tools/tasks, enable delegation by prompt, or treat projected activity as universal task support.
7. **Review/integration (lead):** inspect each full returned diff, batch findings and create scoped Conventional Commits. Preserve parity-local-development fixes and the standalone/no-Electron boundary.
8. **Verification:** focused tests during implementation, then affected package and repository typechecks, pattern/anti-slop, React Doctor, production shell build, disposable-PG delivery/action gates, composed fake-speech+fake-model/action path and inspected standalone Web Canvas/Web Desktop screenshots/accessibility. Record final-HEAD command/results and artifact paths in the evidence matrix. At most one final broader suite after focused work.

## Test design

Tests must differ for wrong implementations: simultaneous icon/palette launch; no Chat mounted; no mic on restore/open; stable backing identity; deleted/access-lost Chat; runtime/account change while async bootstrap/permission/create pending; typed/spoken canonical equality; native tools/plugins/delegation escapes; same policy on queue/claim/steer/retry; exact argument/schema/policy drift; duplicate claims; crash after effect before result; unknown no replay; cancelled audio vs run vs non-cancellable task; asymmetric interrupted history; cleanup rate exhaustion/retry; transport-loss playback stop; AudioContext rejection; device loss; strict reconnect schema and stale epochs.

Real disposable Postgres is required for concurrency/recovery evidence; fake-provider PGlite composition is useful but not process-crash evidence. The historical JSONB fixture serialization defect is fixed in source but is not current evidence until rerun. Fixture composition must assert fake speech AND fake canonical model/action ports before launch. Simulator selection must be impossible in production, and no simulator flag grants coding eligibility.

## Security/resources and lifecycle

Existing authenticated Gateway principal and owner-local canonical DB remain authoritative. Every mutation has bodyLimit/Zod/timeout/auth. New binding uses unique scope and transactional ON CONFLICT resolution, no network calls under DB locks. Ephemeral session maps/queues/subscriptions/captions have bounds, TTL/eviction and shutdown drain. Cleanup has separate bounded admission from ordinary session creation. Runtime changes stop media before attaching a new identity.

## Qualification gates, not authorized here

Real managed STT → actual Codex → managed TTS; real mic/speaker; production parity provisioning/restart; provider account/retention/funding validation; measured latency/interruption; accessibility/usability cohort; public docs PR in FinnaAI/matrix-os-site and release PR/review. Electron Desktop host/packaged-app qualification is deferred to the separate follow-up, not a gate of this plan. A/B local implementation is tracked separately from C release qualification. No 'finished' claim with disabled product actions or missing requirements.
