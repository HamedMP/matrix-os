# Linux Computer Use qualification probe

Local experimental draft against main `f875f29ea3a39eb6bf1930f359e8cca89b53c3ae`.
See [`specs/637-computer-use-qualification/spec.md`](../../../specs/637-computer-use-qualification/spec.md).
Nothing imports this probe into Gateway, provisioning, customer tools or UI.

The probe separates screenshot capture/input execution from model decisions and
from KasmVNC viewing. It exposes one MCP **stdio** tool and returns an actual
`image/png` content block alongside observation metadata. It does not implement
another agent/model loop. Protocol tests use synthetic PNG bytes; they do not
prove a model saw the pixels or an OS GUI was controlled.

## Operator gate — not production authentication

The original main.mjs entrypoint remains Preview-only. Do not run it on the operator's physical host, Main, production, another user's runtime, a signed-in/shared browser profile, or an unknown display. No execution
is authorized until the user identifies the nonproduction target, the existing
vision model connection, synthetic-only scope and evidence-retention policy.
Component installation and system permission changes are separately authorized;
this probe performs neither.

The manual trusted launch requires all of:

- Linux, a non-root UID, `MATRIX_COMPUTER_QUALIFICATION=synthetic-only`.
- `MATRIX_COMPUTER_QUALIFICATION_GRANT_FILE`: an absolute regular owner-only file
  (0600) containing strict JSON fields `ownerId`, `chatId`, `runId`, `targetId`,
  `display`, `modelRoute`, `syntheticOnly`, `expiresAt`. It must name the exact
  `pv-<PR>-<eight lowercase hex>` target, fixed display `:7`, `syntheticOnly:true`
  and an expiry no more than ten minutes away. A grant is not a model argument.
- The runtime's existing `MATRIX_HANDLE`, `MATRIX_RUNTIME_SLOT` and
  `MATRIX_CLERK_USER_ID` must match that target/owner. These are manual experiment
  preconditions, not a replacement for authenticated platform proof.
- An inherited **operator-owned FIFO at FD 3**, separate from model MCP stdin.
  Its only messages are `presence\n` and `stop\n`; unknown/oversized input, EOF
  or error stops the session. Send presence at least once per second only while
  the owner is actually present. The model cannot renew presence through tools.
- Approved prerequisites already present: `/usr/bin/xdotool`, `/usr/bin/python3`
  and `mss==10.2.0` importable by isolated Python. Native input/capture are fixed
  to `DISPLAY=:7`; there is no shell, model-selected binary, endpoint or display.

Only then launch `node scripts/spikes/computer-use/main.mjs` through the existing
harness's separately reviewed MCP configuration, preserving FD 3. No network
listener is created. Do not paste a grant, key or unrelated environment into Chat.
Missing prerequisites fail closed; there is no install, sudo or permission prompt.

This config is trusted local launch data; it is **not production authorization**.
Do not run Browser agent/CDP work concurrently on the display. The operator must
establish a clean synthetic desktop/profile and approved egress first. The probe
has no shared Browser lease, app sandbox, focus/sensitive-page detector, signed
consent service or VNC input gate. It must never be used as a Browser policy
fallback. Production integration remains blocked on those mechanisms.

## Actions and lifecycle

`observe` returns a bounded root-display PNG, observation ID, dimensions, origin,
scale, geometry revision and lease epoch. `click`, `drag`, `scroll`, `type` and
`key` require that fresh observation plus unique action ID. Every mutation consumes
the observation and returns another image. Coordinates stay within the actual
frame. Changed geometry, expired presence/grant, stale epochs/frames, duplicate
IDs and competing calls are refused. There is one active request and no queue.
`status` returns coarse state; it does not capture.

Input is explicit mouse/key down/up; there is no persistent raw key-down action.
Typing supports **US-ASCII test layout only**, uses tracked per-character keys,
and accepts no newline (use a separate Return chord). This avoids assuming that a
killed `xdotool type` subprocess releases its internally generated modifiers.
Other layouts, IME, Unicode, clipboard and multi-monitor behavior remain unqualified.

Stop, expiry/presence loss, MCP transport close/error, stdin/operator-pipe closure and process termination
revoke the epoch, reject future work, cancel active child input, discard late
capture and release only tracked agent-held keys/buttons. Subprocess cancellation
waits for actual child exit. Failed cleanup latches the session unavailable; it
cannot be resumed with another heartbeat. Restart requires a new explicit grant.
SIGKILL/host crash cannot execute in-process cleanup; independent supervisor-level
recovery must be qualified before product exposure. Already-issued OS effects
cannot be undone or retried automatically.

Bounds: image edge 1600 px, encoded PNG 2 MiB, validated chunks/checksums and bounded
pixel decompression; stdio input 32 KiB and queued encoded replies under 6 MiB;
text 4000 printable ASCII characters;
chord eight keys; scroll 20 ticks; drag 120 points/two seconds with cancelable delay
segments no larger than 250 ms; action IDs 256; frame/presence five seconds; child
process two-second timeout plus kill escalation and bounded output. Gesture limits
are requested bounds, not measured real-X11 timing guarantees. Key-release failure
must remain unavailable, never report successful human handover.

## Privacy and evidence limits

No screenshot file or normal image/text telemetry is written by the probe. Its
image result travels through MCP to the approved existing model connection.
**That does not establish ephemeral end-to-end processing.** Matrix's current
Codex artifact path can persist image tool results to owner artifact storage;
native session logs and provider retention need separate verification/disclosure.
Until that is resolved and explicitly accepted, use only synthetic pixels/screens.
Do not send screenshots to Jev, OpenDots, analytics, a second model or public URLs.

Actual GUI acceptance is still **unrun**: real screenshots and mouse/keyboard must
open example.com, open the visible Linux Terminal through the GUI, type exactly
`printf 'COMPUTER_USE_OK\n'`, press Return and confirm independent visible output.
No CDP/Playwright navigation, background shell or server-side Terminal launcher can
substitute. Also qualify drag/scroll/chords, takeover, denied grants, explicit Stop,
real disconnection/blackhole, restart, sensitive focus and Browser coexistence.
Record exact code/bundle/Electron/OS/display/dependency/harness/model versions,
metadata-correlated screenshots/recording and cleanup deadline outside Git. Healthy
stop ≤2 seconds and silent presence-loss cleanup ≤6 seconds are future acceptance
targets, not current real-runtime claims.

## Local deterministic checks

`pnpm exec vitest run tests/spikes/computer-use-protocol.test.ts tests/spikes/computer-use-session.test.ts tests/spikes/computer-use-process.test.ts --maxWorkers=1 --no-file-parallelism`

- Real SDK MCP client/server boundary, valid synthetic PNG: image typing/geometry,
  malformed-image refusal and refusal of a model-selected display. Actual SDK
  stdio error/oversize and output-backpressure paths stop admission. No model call
  or screenshot.
- Real session lifecycle, simulated X11 transport: abort/release, stale/changed
  geometry, duplicate actions, no concurrency, unsupported target/OS and cleanup
  failure latch and in-flight operator-presence watchdog. This does not prove
  actual XTest behavior.
- Real harmless Node subprocess: cancellation waits for exit, stdout limit enforced;
  no native input/capture. Temporary PID file is deleted in `finally`.

Offline test toolchain reused through an ignored `node_modules` symlink to the
existing checkout: MCP SDK 1.30.0, Zod 4.4.3, Vitest 4.0.18, Node 25.5.0. No package
manifest/lockfile changed and no installation ran. This is not a frozen-install or
Linux runtime qualification. `node --check` and Python `compile(...)` validate
syntax without importing mss or capturing any screen.

## Separately authorized isolated Main experiment

ENG-399 records the owner's explicit approval on 2026-10-27 to use Main as a host for an isolated synthetic desktop with the existing Codex connection. This does not authorize Main's existing desktop, Chrome profile, credentials or production changes. `isolation/guardian.mjs` is a separate manually launched factory; it does not remove the Preview guard.

Prerequisites are pre-existing Bubblewrap/KasmVNC/Chrome/Openbox/Terminal, verified reviewed user-space dependencies, a digest manifest, a fresh owner-only state directory and strict MainIsolatedGrant. No apt/pip/system install, privilege-policy change, existing service restart or public listener. The synthetic desktop runs in private namespaces with no effective capabilities, Main data or operator controls. Chrome sandbox remains enabled. The only outbound destination is example.com.

The guardian's loopback viewer is reached using authenticated Matrix forwarding. Owner Enable/presence/Take over/Stop are outside model tools and outside the desktop namespace. Agent control gates VNC human input; stop/loss/expiry drains the run, and reconnect never resumes it. Test service lifetime/resource caps and actual namespace receipts must be verified on the exact runtime.

Existing native Codex authentication is used without copying it. Before real inference, enforce native tool restrictions and inspect both top-level tools and additional_tools. The actual current CLI still publishes native view_image/apply_patch and collaboration tools under the tested overrides; the model lane is blocked. A connected MCP catalog alone does not qualify tool isolation. This is a qualification of the native Codex execution lane, not a claim that Matrix Chat's image persistence or multi-shell product integration is solved. Optional QA evidence is synthetic-only, capped at24 PNGs outside Git with a seven-day deletion deadline; provider retention follows the existing connection.

Source tests do not establish real RFB, model vision, GUI input or stop timing. Record these separately, together with code/bundle/dependency/runtime versions and before/after Main service/X7 checks.
