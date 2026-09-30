# Implementation plan: standalone Aoede

**Branch:** feat/aoede-rewrite. **Authority:** owner correction 2026-09-30 and spec.md. This replaces the former Chat-mounted delivery plan. No full runtime, paid calls, shared infrastructure/database mutations or publishing are authorized.

## Architecture

One shell-level assistant owner holds visibility, invoking focus target, immutable runtime/account/workspace identity, bootstrap in-flight single-flight request and the one shared media client. It survives Chat/app/presentation switching. Surface hosts supply workspace navigation and nonmodal geometry, not another state machine. Opening never starts media.

A Gateway assistant bootstrap resolves/creates an owner-local canonical backing Chat using idempotent durable identity. Continue reuses it; explicit New uses a stable request ID. End releases only voice resources. Deletion/access loss is surfaced without automatic replacement. Bootstrap cannot choose another owner/runtime or bypass normal provider readiness.

Canonical Chat owns action qualification and execution. Its immutable run policy is persisted and checked at admission, queue/dequeue, steer/retry and actual provider dispatch, including typed turns while assistant ownership applies. A canonical per-tool inventory and operation authority binds exact validated normalized arguments and schema/policy/scope identity. Side effects persist an operation before unique claim; ambiguous dispatch is outcome_unknown with no automatic replay. Delegation carries the same policy/identity. Unqualified native harness paths fail closed; existing unrestricted typed paths do not gain accidental privileges.

Speech/media adapters are restricted to capture/transcription/synthesis. Platform Speech remains credential/funding/metering authority. Add additive bounded streaming synthesis protocol while preserving v1 file APIs and durable funding lifecycle. Interim transcription cadence, if built from bounded rolling file requests, is explicitly identified as provisional polling rather than genuine realtime recognition.

## Design direction

Compact independent assistant, not a window full of Chat. A restrained interference-ring ambient visual is supplementary to literal status. Use existing Matrix font/theme tokens; steel/ink neutral foundation, cool signal accent and distinct warning/error tokens from the shared theme. Scope and microphone state sit directly under Aoede's heading. Current captions precede canonical control cards; control row is stable. Cards appear only for actual approval/input/progress/result records. Settings are progressively disclosed. No general composer/message list, no fabricated animation/progress.

## Delivery units and exclusive ownership

1. **Discovery (lead + read-only specialists):** revalidate dirty baseline, all spec/domain docs, typed execution and version-matched upstream tool boundary. Do not edit until central choices are settled.
2. **Specification/contracts (lead):** revise every spec artifact; create requirement/evidence matrix; freeze assistant bootstrap/presentation/canonical policy/speech streaming interfaces. Lead owns shared contract/migration/composition decisions.
3. **Wave 1 independent implementations:**
   - B: shared standalone presentation only, new packages/ui/src/aoede presentation files and own focused tests; fixture-facing interface, no media/Chat ownership.
   - C: platform/gateway managed speech streaming/cadence and provisioning code/tests. No provider keys in Gateway. No shared contract edits outside lead-approved interface.
   - D: packages/ui/src/voice-session client media/transport/cleanup reliability and focused tests. No presentation/controller ownership collision.
4. **Wave 2:**
   - E: canonical Chat action/operation/policy authority and own tests; no provider adapter or voice engine changes.
   - F after E interface freeze: provider adapters/tool inventory enforcement, native-config isolation/delegation, own tests. No second agent/backend.
   - G: Gateway assistant bootstrap/voice integration/canonical projection, own tests; no action/task/approval authority. Server composition remains lead-integrated.
5. **Wave 3 after G/controller stabilizes:**
   - H: Web Canvas/Desktop shell hosts, built-in identity/icon/palette/launch dispatch and own tests. Remove Chat-mounted session ownership.
   - I: Electron nonmodal/native-view-safe host, icon/palette/runtime fencing and own tests. No modal overlay lease for persistent assistant.
6. **Review/integration (lead):** inspect each full returned diff, batch findings, scoped Conventional Commits. Workers never stage/commit/push or broaden exact assigned paths. Preserve baseline reconnect/Origin/speech changes and remove environment-selected simulator admission bypass.
7. **Verification:** focused tests during implementation, then affected package typechecks, pattern/anti-slop, React Doctor, production shell build, disposable-PG gate, composed fake-speech+fake-model/action path and inspected three-surface screenshots/accessibility. Record failure/skip/artifact paths in evidence matrix. At most one final broader suite after focused work.

## Test design

Tests must differ for wrong implementations: simultaneous icon/palette launch; no Chat mounted; no mic on restore/open; stable backing identity; deleted/access-lost Chat; runtime/account change while async bootstrap/permission/create pending; typed/spoken canonical equality; native tools/plugins/delegation escapes; same policy on queue/claim/steer/retry; exact argument/schema/policy drift; duplicate claims; crash after effect before result; unknown no replay; cancelled audio vs run vs non-cancellable task; asymmetric interrupted history; cleanup rate exhaustion/retry; transport-loss playback stop; AudioContext rejection; device loss; strict reconnect schema and stale epochs.

Real disposable Postgres is required for concurrency/recovery evidence; fake-provider PGlite composition is useful but not process-crash evidence. Fixture composition must assert fake speech AND fake canonical model/action ports before launch. No environment simulator flag grants coding eligibility.

## Security/resources and lifecycle

Existing authenticated Gateway principal and owner-local canonical DB remain authoritative. Every mutation has bodyLimit/Zod/timeout/auth. New binding uses unique scope and transactional ON CONFLICT resolution, no network calls under DB locks. Ephemeral session maps/queues/subscriptions/captions have bounds, TTL/eviction and shutdown drain. Cleanup has separate bounded admission from ordinary session creation. Runtime changes stop media before attaching a new identity. Electron retains exact trusted Origin/CSP, no globally trusted null origin.

## Qualification gates, not authorized here

Real managed STT → actual Codex → managed TTS; real mic/speaker; packaged Electron; production parity provisioning/restart; provider account/retention/funding validation; measured latency/interruption; accessibility/usability cohort; public docs PR in FinnaAI/matrix-os-site and release PR/review. A/B local implementation is tracked separately from C release qualification. No 'finished' claim with disabled product actions or missing requirements.
