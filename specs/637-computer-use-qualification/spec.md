# Computer Use qualification spike

Status: local experimental draft; not installed, enabled or production-ready.
Route A was approved on 2026-10-27. Baseline: main `f875f29ea3a39eb6bf1930f359e8cca89b53c3ae`.
Tracking: ENG-399. On 2026-10-27 the owner explicitly authorized isolated testing on Main using the existing Codex connection, preserving Browser/VNC and the existing Chrome profile.

## Goal and scope

Determine whether an existing Matrix Chat harness/model can consume actual Linux desktop image tool results and whether an X11 input executor can cancel safely. Preserve Browser Use, its current policy and KasmVNC. Do not build a new agent loop, Chat/Bot service, public control endpoint or UI.

Only a manually launched, default-denied experiment is in scope. It is never registered by Gateway startup, installed by provisioning, or offered to customer agents. Local deterministic checks are preparation; actual model/GUI qualification requires a specifically authorized synthetic target. Main is authorized only as the host of a new isolated desktop; its real desktop is outside the grant. No physical-host capture/input, system permission changes, global installation or paid provisioning is authorized here. Verified dependency bytes may be extracted into the owned test bundle without installation.

## Current facts

- Shared Browser defaults to Matrix's CDP driver: `packages/gateway/src/shared-browser/runtime.ts:14-16`.
- Shared Browser snapshot is DOM text/refs, not desktop pixels: `packages/gateway/src/shared-browser/cdp-driver.ts:250-266`.
- Native browser MCP results currently serialize JSON as text: `packages/integrations-mcp/src/shared-browser.ts:25-26`.
- Managed Pi tool success is text-only: `packages/contracts/src/bots/broker.ts:117-123`.
- Existing cloud X11 display and KasmVNC services are defined in `scripts/spikes/browser-vps/runtime-services.json`; the viewer and model-action paths are separate.
- Viewer disconnect clears the viewer claim, not automatically the agent run: `packages/gateway/src/browser-lab/routes.ts:295-300`.
- xdotool executes input, mss captures pixels. Neither supplies model decisions or a separate model service. X11 execution is broad authority, not an application sandbox.

## Qualification seams

1. A real MCP client/server exchange delivers an image content block with bounded, correct pixels and observation geometry; it must not present a path/base64 JSON text as a vision result. This proves protocol plumbing only until a selected model demonstrably sees it.
2. The actual adapter subprocess boundary stops accepting work after revoke/timeout, cancels in-flight input, releases only tracked agent-held keys/buttons and rejects stale observations/epochs. Tests may simulate X11 binaries for deterministic fault injection, but must disclose that boundary and do not qualify real desktop input.
3. Later, on the authorized Linux target, actual root-desktop pixels and mouse/keyboard actions open example.com and a visible GUI Terminal, type `printf 'COMPUTER_USE_OK\n'`, and visibly show the output. CDP, Playwright, background shell or the server-side Terminal launcher cannot substitute for the GUI steps.

## Security and lifecycle

| Boundary | Authority | Requirements |
|---|---|---|
| Experiment launch | Explicit trusted test grant naming owner, target, display, run, expiry and selected model recipient | Default deny, Linux only; refuse unknown/production target or expired/incomplete launch configuration |
| MCP stdio | Local trusted launch and same current run grant | No listener; no model-selected endpoint, DISPLAY, executable, raw shell or arbitrary OS command |
| Input dispatch | Current grant/epoch + fresh image/geometry | Strict action schema, bounds, one active action, no blind retries; invalidate after each action/control/layout change |
| Screenshot | Same capture grant | Fixed authorized display, bounded pixels/bytes, in-memory result; no automatic disk image or telemetry upload |
| Executor child | Fixed executable/argv or bounded stdin | Timeout, output limits, non-root, cancellation, explicit cleanup; inherited environment minimized |
| Revocation / presence loss | Local watchdog independent of model/Gateway | Reject queue/late results, stop capture and input, release tracked state; restart defaults disabled |

The experiment does not provide production authentication. It must never bypass Browser Use denials, inspect signed-in owner profiles/password managers, expose control ports or operate unknown apps. The first real target must contain only synthetic data with approved egress and an exact harmless Terminal-command grant. Browser/Computer simultaneous operation is forbidden during qualification. A future shared display lease and reviewed browser mediation/isolation are prerequisites to product integration.

Action limits follow the approved plan: screenshot longest edge ≤1600 pixels and ≤2 MiB encoded; text ≤4000 characters; chord ≤8 keys; scroll ≤20 ticks; drag ≤120 points/2 seconds in ≤250 ms cancellable segments; fresh observation ≤5 seconds; at most one in-flight action. No persistent key-down tool. Every child/temp resource has timeout/cleanup; no unbounded in-memory registry.

Healthy Stop/takeover aims for ≤2 seconds; silent presence loss must stop input within five seconds plus at most one second cleanup. These are future acceptance limits, not observed guarantees. Failure to confirm release remains unavailable; do not acknowledge human control early. Already-dispatched effects cannot be undone or blindly replayed.

## Screenshots and privacy

Approved image path is target → Matrix executor/tool transport → selected existing model connection. No secondary judge/model service, analytics, public URLs or automatic evidence upload. Screenshot memory is bounded and discarded after use/stop; native harness session persistence and provider retention must be separately verified/disclosed before real screen data. Sensitive/unknown screens pause capture and require manual handoff; OCR is not reliable containment.

No real screen is captured during local development. Synthetic test images and dependency-injected input transports must be labeled. Later QA screenshots/recordings live outside Git with explicit consent, a recorded retention deadline (proposed seven days) and deletion. Normal receipts include metadata/digests, never image bytes or typed text.

## Acceptance matrix

| Actor/state | Action | Required observable outcome | Failure/recovery | Evidence lane |
|---|---|---|---|---|
| Local developer, no grant or non-Linux host | Start experiment | No capture/input; explicit refusal | No permission request/fallback | Deterministic negative tests |
| Synthetic MCP client | Request observation | Actual image content and correct bounded geometry | Reject invalid/oversized image | Real MCP protocol; synthetic pixels |
| Simulated X11 subprocess | Cancel chord/drag | Child drained, tracked state released, no late action | Failed cleanup denies further work | Real adapter lifecycle; simulated OS |
| Owner on named synthetic Linux target | Screenshot → click/type/chord/drag/scroll | Actual desktop change and fresh returned pixels | New observation after changes | Real executor/model GUI qualification |
| Owner during active input | Take over / Stop / disconnect | Input and capture stop; cleanup before handover | No replay after reconnect/restart | Real target fault injection + recording |
| Browser-denied request | Attempt visual fallback | Remains denied | Owner review, no alternate path | Security qualification |

The spike changes no user-visible Web Canvas, Web Desktop, Electron Desktop, Web Mobile or Native Mobile surface. Per-surface consent/status/stop parity is deferred to a later product integration proposal, not claimed passed by this experiment. Required future shared UI tests and running-surface evidence remain in the approved planning artifacts.

## Integration, rollback and follow-up

Start sequence: validate trusted configuration and Linux target → check input/capture prerequisites → establish bounded grant/watchdog → expose only stdio tool → observe/action/result → revoke/drain/release on every termination. No product startup import/export is added. Unexpected partial dispatch returns uncertain; no repeat. Shut down input/capture before disposing transport.

Rollback is stopping the manually launched process and revoking the experimental grant. Preserve the existing Chrome/profile, owner files and Browser/VNC services. Any installed test-only dependency requires a separately approved installation/cleanup plan.

After real qualification, document exact SHA/bundle/Electron/OS/display/harness/model/dependency versions, named tests and actual results. Only then propose the minimal product integration. A separate documentation PR in `FinnaAI/matrix-os-site/content/docs/` must explain actual supported targets, enablement, permissions, stop/recovery and retention before customer exposure. No production deployment, merge, fleet rollout or VNC replacement is part of this spike.

## Authorized Main isolation amendment — 2026-10-27

The original Preview entrypoint and Preview target guard remain intact. A separate manually launched test guardian accepts an exact owner/Main/run/expiry grant and validates bundle file digests. Main is hosting a synthetic Linux desktop rather than exposing its existing X11 display. A nested Bubblewrap boundary uses private network, mount and PID namespaces, UID999 and no effective capabilities; Main home, credentials, Chrome profile, X7 and operator sockets are absent. The outer namespace temporarily brings up its own loopback and then drops authority. No host policy or system component changes.

The temporary user service is capped at ten minutes, 1536MiB, 128 tasks and one CPU. Existing binaries and reviewed user-space xdotool/libxdo/mss bytes are reused. Chrome keeps its native sandbox; startup failure cannot fall back to --no-sandbox. Test browser egress uses a fixed example.com proxy with public DNS validation and IP pinning. HTTPS CONNECT restricts destination rather than inspecting encrypted HTTP methods. No signed-in accounts or sensitive data are allowed.

The host guardian alone owns presence, Enable/Take over/Stop, the exact target grant and the MCP socket. The desktop cannot reach these via its filesystem or PID namespace. Kasm viewer access uses a new test credential, clipboard disabled and a temporary host-loopback listener reached through authenticated Matrix forwarding to local loopback. No public route is added. Agent control disables viewer input with verified VNC parameters; takeover drains agent state before enabling human input. Visibility or transport loss stops the run. Reconnection does not resume it.

The intended model path uses existing native Codex authentication and ephemeral execution. Actual app-server metadata confirms an ephemeral thread and a connected qualification MCP with its complete action schema. This does not establish that only this tool is available: request capture found native tools in an additional_tools input item, including view_image and apply_patch, despite the tested feature overrides. Checking only top-level tools was insufficient. No real inference or desktop image delivery is allowed until native tool authority is enforceably restricted or the model worker is independently isolated from Main data. The native Codex vision/input lane and canonical Matrix Chat integration remain unqualified; Matrix Chat also has an existing image-artifact persistence path. No additional model service or authentication copy.

Actual screenshots are restricted to this synthetic desktop. Optional QA saves at most 24 PNGs outside Git with an explicit seven-day deletion deadline; raw Codex JSON/image results and typed text are not retained. Provider-side retention follows the existing Codex connection and is not controlled by this executor. Main service health and existing X7 identity are recorded before/after. GUI, model reception, human control and stop timing still require actual acceptance evidence; source review and namespace receipts alone do not establish them.
