# Computer Use qualification — 2026-10-27

**Result: blocked before real model/GUI acceptance.** Existing Browser Use, VNC and Chrome profile are preserved. No production deployment, system installation, OS permission change, real inference or desktop screenshot delivery occurred. Tracking: [ENG-399](https://linear.app/matrix-os/issue/ENG-399/qualify-computer-use-on-the-vps-cloud-desktop).

## Recommended route and reuse

Start with a synthetic Linux desktop on the existing VPS; keep user-local control as a separate later capability. The VPS already has X11/KasmVNC, owner routing, current agents and browser handoff infrastructure. Local physical control additionally requires per-platform capture/input permissions, device grants, multi-monitor/scale support and a separate trusted local executor; Electron webContents thumbnails and inference-device connections do not provide these.

| Route | Reusable / missing | Cost and permission boundary |
|---|---|---|
| A: existing VPS desktop | Reuse agents, owner/run identity, connection and viewing; add actual desktop PNG delivery, fixed X11 executor and shared-display arbitration | Smaller initial OS surface; synthetic isolation is independently testable. The primary host is usable only when isolation gates pass, not as an unrestricted real display |
| B: user's physical Matrix Desktop device | Reuse session/device identity where compatible; existing device inference/cancel and webContents thumbnails lack a desktop-control grant/executor | Native capture/global input consent, per-platform packaging, focus, scale/monitors, offline revocation and privacy substantially increase scope; do not assume macOS |

Browser Use remains the DOM/CDP executor for browser semantics. Computer Use would capture OS pixels and execute bounded X11 mouse/keyboard actions. KasmVNC is viewing/human-input transport; replacing it is unnecessary. The historical agent-browser/browser-use comparison is a browser-driver proposal, not the desktop architecture or proof those libraries are deployed.

A Matrix-owned adapter over xdotool input plus python-mss capture is the narrow Linux/X11 candidate. The existing vision-capable agent/model decides actions; the executor supplies no separate model service. Retain existing Chat/run/session/device identity rather than introduce another Chat/Bot. A future shared display lease must arbitrate Browser/Computer input if they ever target one display; the qualification instead uses a separate synthetic display namespace.

| Candidate | License / verified status | Fit |
|---|---|---|
| [xdotool](https://github.com/jordansissel/xdotool) + [python-mss](https://github.com/BoboTiG/python-mss) | BSD-3-Clause + MIT; active upstream checks on 2026-10-27 | Small TS subprocess/input adapter and Python screenshot helper; X11 qualification first; no native Wayland or macOS input claim |
| [PyAutoGUI](https://github.com/asweigart/pyautogui) | BSD-3-Clause; older public maintenance | Cross-platform API, but primary-monitor/layout and screenshot dependencies need qualification |
| [nut.js](https://github.com/nut-tree/nut.js) | Apache-2.0 public source; current prebuilt packages require paid subscription | TS-friendly, but native/Electron ABI and distribution cost make it a later option |
| [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots) | MIT, active alpha template | Ownership/isolation/permission reference; pinned OpenBot uses browser Playwright plus shell and does not prove native GUI Terminal control; full adoption duplicates Matrix systems |

## Minimal proposed action chain

Existing Chat/run selects an image-capable existing model connection → trusted owner/device/display lease → fixed desktop capture using mss → bounded PNG MCP image plus observation/geometry/epoch → model chooses one strict action → fixed xdotool XTest execution for click/drag/scroll/text/chord → fresh PNG and action result. The host watchdog handles cancellation, tracked key/button release and failure; model tool arguments cannot select a device, executable, endpoint or renew permission. Product integration would reuse agent/session/control semantics while adding the image-capable adapter and a desktop lease. No new Chat/Bot system or UI refactor is required for qualification.

## Exact evidence versions

- Research/code base: main `f875f29ea3a39eb6bf1930f359e8cca89b53c3ae`, isolated branch `codex/computer-use-spike`.
- Tested primary runtime: `v2026.10.24-1890`, installed commit `be6cce1404bfd6db3392c535bca2e0def32ec577`.
- Native Codex `0.162.1`; selected existing default `gpt-6.1-sol` lists text/image support. No actual inference was performed.
- Main Node `24.18.0`, MCP SDK `1.30.0`, Zod `4.4.3`, Bubblewrap `0.9.0`.
- Qualification bytes: Ubuntu xdotool/libxdo `1:3.20160805.1-5build1` and mss `10.2.0`, extracted only into owned scratch; no apt/pip/global install. This distro xdotool is older than upstream v4.
- Final executed bundle: SHA256 `df3d94c9d6d396dc8954ef2304d634ed2bb6f28c001c3376a6ae04826fa271f5`, 149895 bytes, 16 manifest-listed code/dependency files. Subsequent local-only source updates add a socket-client JSDoc typing annotation and preserve classified Xvnc diagnostics without changing first-failure attribution; they were locally checked but were not part of that executed bundle.
- Dependency digests: xdotool deb `58a202c74bce31ca2d72d4d514942a5ab6191932696adc5d21d909c9216b13cb`; libxdo deb `3506c2824a74255439813f824a1629387452d52c6efd6d7916b8b54e458175e8`; mss wheel `e79f428899280e7e64e38365b5bfed683851ebea807eeaeadaf06eb8e0d67197`.

## What actually passed

1. Authenticated, bounded Matrix MCP commands reached the owner-authorized primary runtime; no persistent Terminal tab, public port or credential copy.
2. Actual nested Bubblewrap preflight: outer namespace root maps only the existing non-root host user; inner UID/GID999, effective capabilities0, distinct PID/mount/network namespaces, private loopback, no Main home or original X7. No host sysctl/AppArmor changes.
3. Temporary user-service resource controls were accepted: 1536MiB, 128 tasks, 100% CPU, maximum ten minutes, group termination, no restart.
4. Native app-server returned ephemeral=true and connected qualification MCP metadata. Real discovery now exposes the complete action schema. Earlier top-level Zod union silently published an empty parameter object; an object envelope `{input: Action}` fixes it, protected by a semantic RED/GREEN discovery regression.
5. Local focused suites: **64/64 across seven files, zero skipped**, including six existing Codex artifact regressions. Real MCP/Unix socket/process boundaries are tested; pixels and X11 action subprocesses are synthetic in these suites.
6. Scoped ESLint with `shell/eslint.config.mjs` passed (existing Next pages-directory advisory), standalone scoped TypeScript passed, Python syntax checked. Root Bun commands could not run because Bun is absent. The equivalent Bash pattern scanner completed with zero violations and five existing warnings; its packages/shell scope does not cover these spike files. Full root typecheck/unit gates remain unrun; no dependency install attempted. This is not a full release-parity/CI pass.
7. After shutdown all six owned units were inactive, no test process remained, no saved screenshot existed, and owned remote scratch was removed. All six existing Browser/VNC/Gateway/shell service PIDs and the original X7 device/inode exactly matched the before snapshot.

## Real blockers

### Desktop startup

Actual startup initially failed because `/usr/bin/Xvnc` and `/usr/bin/vncconfig` depend on absent `/etc/alternatives` links inside the deliberately minimal namespace. Pinning the already-installed `/usr/bin/Xkasmvnc` and `/usr/bin/kasmvncconfig` fixes this without expanding mounts.

The final bounded attempt reached desktop-app startup, then the first observed required failure was Xvnc exit1. The cause remains unclassified. No ready desktop, viewer session, mss screenshot or XTest action was established. Startup diagnostics preserve the original failure before cleanup; a later terminated healthy child cannot overwrite it. Do not attribute this to Chrome, AppArmor, permissions or memory without further evidence.

### Native model authority

A dummy loopback provider with a dummy token captured requests without real inference. Initial inspection of top-level tools alone was incomplete: this Codex version advertises native tools through an `additional_tools` input item. Under the tested feature overrides, it still declares view_image, apply_patch and collaboration tools. A connected one-tool MCP catalog therefore does not establish a one-tool model session. The tested `tools.view_image=false` setting is ignored.

No real model turn or screenshot delivery was attempted. Before continuing, verify an enforceable native tool allowlist, or independently isolate the model worker from Main data while keeping existing authentication in its proper trusted boundary. Do not silently add another model/key or weaken the desktop sandbox. Existing Matrix Chat Codex artifact handling can persist image results and remains a separate integration/privacy gate.

## Security requirements retained

Exact owner/device/run/model-recipient/expiry grant; explicit owner Enable; trusted viewer visibility/connection; exclusive agent/human input; Stop/takeover drains tracked keys/buttons before acknowledgment; transport/visibility loss revokes; reconnect needs a new grant and never replays actions. Screen/web content cannot authorize actions or bypass Browser policy. No screen-recording/accessibility grants are requested silently.

The test desktop has only synthetic data, its own profile, no Main credentials/home/operator socket/PID access, no clipboard sharing, fixed example.com proxy egress with public DNS validation and pinned IP. HTTPS CONNECT constrains destination, not encrypted inner methods. Viewer HTTP assets come from trusted installed host files; the writable desktop socket carries WebSocket data only. Writable state aliases cannot replace the host-side X11 source parent. No broader public control route.

Actual screenshots would go only through the explicitly selected existing model connection. Provider retention follows that connection. Optional QA would retain at most 24 synthetic PNGs outside Git with a seven-day deletion deadline; this run captured none. Normal receipts contain metadata, not image bytes, typed text, secrets or raw program errors.

## Remaining real acceptance

After both blockers are resolved in an approved environment, record exact code/bundle/runtime/model/dependency versions and a visible screenshot/recording sequence:

1. Owner refuses permission: no screenshot/input; then explicitly enables a fresh grant.
2. Selected existing model receives an actual desktop image and grounds mouse/keyboard actions from fresh observations.
3. Through GUI mouse/keyboard, open example.com and confirm visible page.
4. Through GUI launcher/menu, open a visible Terminal; type exactly `printf 'COMPUTER_USE_OK\n'`, press Return and confirm a separate visible output line. No background shell/CDP substitute.
5. Verify click, drag, scroll, text and chords with visible before/after states. Reject stale geometry/observations and duplicate actions.
6. Verify operator takeover via viewer, immediate Stop, permission denial, viewer/model disconnect, silent heartbeat loss, process crash and fresh-grant recovery. Measure actual stop/drain timing; do not promote unit-test timing to real-X11 guarantees.
7. Recheck Main service/display/profile preservation and remove owned processes/files. Label every unrun condition explicitly.

No product integration, UI refactor, production deployment, VNC replacement or physical-local/macOS support is included. A later product proposal must cover shared control leases, model/image persistence, consent/status/stop parity and a separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/` before customer exposure.
