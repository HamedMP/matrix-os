# Aoede Rewrite Development Quickstart

This is the target workflow the implementation must provide. Commands marked **planned** do not exist until their delivery slice lands.

## 1. Database-free UI fixture — normal daily loop

**Planned command**:

```bash
bun run dev:voice:fixture
```

Expected properties:

- Starts a lightweight shell/voice preview without QEMU, OrbStack, production provider credentials, or any database.
- Uses seeded canonical Chat views, scripted speech/media, and a fake canonical harness/catalog/policy/admission/delivery implementation.
- Offers scenarios for permission, listening, thinking, tool activity, speaking, interruption, approval, reconnect, quota, device loss, and failure.
- Supports virtual or accelerated time so recovery and timeout states are reproducible.
- Displays a local URL and leaves the development server running for browser inspection.

Minimum review scenarios:

1. Normal two-turn conversation with a typed message between spoken turns.
2. Stop speaking during the first response segment.
3. Barge in before the first audio frame.
4. Tool proposal requiring approval.
5. Tool failure and outcome-unknown recovery.
6. Disconnect during assistant speech, then restore.
7. Permission denied and input-device removed.
8. Reduced-motion and keyboard-only operation.

This mode validates presentation and client lifecycle only. It is intentionally not evidence for canonical persistence, locking, crash recovery, or real provider behavior.

## 2. Fake-canonical and PGlite integration

**Planned commands**:

```bash
pnpm exec vitest run tests/contracts/voice-session.test.ts
pnpm exec vitest run tests/gateway/voice-session
pnpm exec vitest run tests/gateway/chat-voice
pnpm exec vitest run tests/ui/voice-session
pnpm exec vitest run tests/shell/voice-session
pnpm exec vitest run tests/desktop/voice-session
```

Use direct `vitest run <path>` when a workspace wrapper ignores the path filter. Tests use scripted events, virtual time, and either the fake canonical boundary or PGlite for ordinary repository behavior; they must not make provider calls.

**Planned interactive command**:

```bash
bun run dev:voice:integration
```

This starts the minimum real Gateway and shell path with the simulator adapter. It validates authenticated session creation, ordered canonical Chat admission, canonical event projection, approvals, synthesis playback, post-run delivery writes, and cleanup without the production platform or VM.

Acceptance:

- Voice and typed turns land in one seeded Chat.
- The canonical Chat stream—not the voice media channel—delivers durable messages and tool state.
- Refreshing the shell restores Chat history but not stale microphone/provider state.
- A second transport cannot mutate the first session.
- Interrupted/restarted spoken and typed continuation both exclude unheard content.
- Session-only policy reaches adapters/tools/checkpoints rather than existing only in the UI request.

## 3. Disposable PostgreSQL crash and concurrency suite

PGlite is not evidence for database locking or process-crash behavior. The implementation must provide an isolated disposable-PostgreSQL suite for those contracts.

**Planned command**:

```bash
bun run test:voice:postgres
```

Required cases:

- `pending` delivery persisted before playback, crash before acknowledgement, and conservative `unknown` recovery;
- acknowledged heard/interrupted boundary survives restart with stable segment/time-to-text mapping;
- duplicate/reordered voice finals race typed admission without duplicate runs;
- one-time ticket atomic consume, lost-create-response generation rotation, replay, concurrent reconnect, and credential-less create retry after prior consumption;
- session-only policy and native-checkpoint eligibility survive process restart;
- disconnect-after-action-commit reconciles or remains outcome unknown without replay.

The suite creates and destroys only its own database/schema and uses no production bypass.

## 4. Optional real-provider and packaged-transport conformance

Provider credentials remain outside repository files and are read only through existing approved configuration. Never paste or export keys into commands, logs, fixtures, or screenshots.

**Planned command**:

```bash
bun run test:voice:provider --adapter <adapter-id>
```

Run only when the relevant environment is configured. The same conformance cases execute against each candidate adapter:

- connect and first-audio latency;
- provisional/final transcript correction;
- normal and early interruption;
- cancellation acknowledgement;
- disconnect/reconnect and stale-event fencing;
- context/budget limit;
- graceful end and resource cleanup.
- composed STT → actual canonical harness → clause TTS cadence and latency;
- interrupted/restarted delivery-aware continuation on each eligible harness;
- packaged Electron Gateway-relayed transport under the current CSP.

Direct provider WebRTC is not part of the default path. Test it only after a separate spike proves narrow signaling/control, credential scope, usage metering, budget enforcement, and CSP behavior.

Store only redacted timings, bounded event metadata, and pass/fail results. Do not commit private recordings or transcripts.

## 5. Visual and accessibility verification

Run the applicable Web Canvas, Web Desktop, and Electron Desktop surfaces. Capture current evidence for:

- permission explanation;
- listening and push-to-talk;
- using-tool with canonical activity;
- speaking with Stop speaking;
- approval pending;
- reconnecting;
- recoverable failure;
- session-only memory mode;
- reduced motion and high contrast.

For React changes run:

```bash
npx react-doctor@latest packages/ui
npx react-doctor@latest shell
npx react-doctor@latest desktop
```

Run only for projects actually changed by the slice. Inspect every captured screenshot; a capture alone is not validation.

## 6. Repository gates

After the final edit in each stack layer:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

When `shell/` changes, also run:

```bash
bun run build:shell:production
```

Use focused checks during development; run these repository-required checks only when the layer is ready, not after every small edit.

## 7. Final production-parity verification

Only after deterministic, integration, provider, and visual checks pass:

```bash
bun run dev:full --reuse-bundle
```

Verify runtime auth, platform credential routing, microphone permissions, packaged networking, provider connection, canonical Chat persistence, interruption, cleanup, and restart behavior. This is a release gate, not the ordinary development loop.

## Current setup caveats

- The current branch is based on unmerged local-development PR #2040 so the production-parity fixes remain available.
- Graphite is not installed in this environment. Repository rules require Graphite for stacked PR operations; install/authenticate it before creating or publishing the implementation stack.
- A prior `dev:source` attempt in the parent checkout returned shell module-resolution errors. Diagnose that separately before relying on `dev:source`; the deterministic voice fixture must not depend on that unresolved path.
