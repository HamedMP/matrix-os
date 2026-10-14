# Shared Chrome native harness verification

Status: live verification pending. Unit fixtures prove registration/transport/cleanup, not native provider readiness or actual model execution.

## Fixed transport

The gateway registers `{ownerId, chatId, runId, harness}` from canonical admission and passes only an expiring opaque run bearer to native adapter code. Tools POST strict `SharedBrowserActionSchema` arguments to the configured owner-local gateway port and fixed `/apps/browser-lab/api/agent-action` path. Agents never supply a CDP endpoint, owner, Chat, run identity or browser profile. Bearers, password-manager pages and authentication content must not appear in logs or evidence.

## Matrix Pi

Use a personal full-access Chat with the shared-browser dependency configured. The bot worker catalog must contain `shared_browser` mapped to `browser.action`; the existing gateway broker resolves exact runtime/generation/owner/Chat/run before dispatch. Verify a real worker model call to snapshot the synthetic invoice fixture, download observed invoice links, and report only hash/provenance-confirmed artifacts. Pause/takeover must leave queued mutations undispatched, permit fresh observation after Resume, and not turn a known no-effect refusal into an unknown-effect checkpoint. Stop must revoke the binding and keep visible Chrome running. Each owner wait is capped at 300 seconds or the remaining run lifetime. Browser actions have a 360-second shared deadline; outer Pi/Hermes transports allow 390 seconds for the response. Other tool deadlines remain unchanged.

## Hermes

Source compatibility inspected at `d337b736aa1e8ebecfab043842d13e4a2d2f48a3` (host installer pin). Verify actual installed revision before the spike. `openHermesSharedBrowserRun` returns the fixed Python bootstrap and run-only environment. The bootstrap wraps both `hermes_cli.config.load_config` and `load_config_readonly`, deep-copies returned configuration, adds a dedicated `matrix_shared_browser` MCP child and disables the native `browser` toolset. The child is the host-bundled `packages/integrations-mcp/dist/shared-browser-cli.js`; its server env explicitly receives the run bearer because Hermes filters inherited child environment.

Run native `tui_gateway.entry` through these exact generated arguments, preserving owner profile/model/login. Do not change owner config or auth files. Create/resume the selected native session, set its exact execution root and session configuration, and inspect `session.info`:

- Match the exact native session ID; ignore lazy and other-session events.
- Require `mcp__matrix_shared_browser__shared_browser` in the native tool catalog.
- Reject any remaining native `browser_*` tool.
- Confirm selected provider/model using the existing native route gate.
- Only then submit the synthetic model prompt. Catalog discovery alone is not an invoice-workflow pass.

Exercise Pause, Take over, Resume with a new snapshot, cancellation during an outstanding tool, and completion cleanup. Confirm owner configuration content is unchanged and Chrome process/profile survives. The existing restricted Jev profile remains separate and receives no shared-browser capability.

## OpenClaw

Source compatibility inspected at `v2026.7.1` (host installer pin). The native agent RPC's `idempotencyKey` is its runtime `runId`; `before_tool_call` context supplies trusted run/session/tool-call IDs, whereas the tool factory alone provides no run ID.

Install/enable only the host-bundled Matrix plugin in the disposable test runtime. The compiled entry is `packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js`; it exports `OPENCLAW_SHARED_BROWSER_MANIFEST` for the adjacent `openclaw.plugin.json`. A contained plugin-root `index.mjs` re-exports that fixed compiled entry; `package.json` declares `openclaw.extensions: ["./index.mjs"]`. The manifest intentionally enables startup activation so protected bind RPC is registered before inference. Configure the real gateway port through trusted plugin configuration, then restart only the scoped native OpenClaw service. Preserve/restore owner plugin configuration and do not alter authentication profiles.

Host activation is complete through `matrix-configure-openclaw-shared-browser.mjs`, invoked by the owner gateway wrapper before the native process starts and by the optional installer only while the native service is stopped. `MATRIX_BROWSER_LAB=true` is a trusted host flag; it permits exactly `matrix-shared-browser`, while feature-off keeps the zero-plugin policy. The helper writes only the Matrix slot, preserves owner model/settings/other entries, rejects extra native allowlist/load-path overrides, and does not read authentication profiles. Existing explicit entry/global/deny opt-outs and the root-owned harness uninstall marker stay authoritative. The native linked-path install record enables owner CLI uninstall; its retained source wrapper and a separate managed-install marker prevent silent reactivation after uninstall.

Configuration remains the native persisted `openclaw.json`, with no temporary overlay. A bounded cooperative helper lock serializes installation writes; symlink-safe bounded reads and fingerprint rechecks reject detected owner edits before replacement. This is not a cross-native-writer compare-and-swap: running the helper concurrently with native configuration writes is unsupported, so service-stop/startup coordination is required. Linux production pins relative operations to verified directory descriptors. Temporary files are deleted after use and stale regular temporary/lock files are swept on subsequent helper invocation. Interrupted setup may leave bounded inert Matrix wrapper files; it must not replace a newer owner config. Owner-customized Matrix source files are preserved and setup fails closed instead of overwriting them.

Verify native plugin inspection and `shared_browser` catalog, then run the actual canonical Chat adapter. It calls `matrix.browser.bind` with canonical run ID, trusted session key and opaque broker lease; the plugin authenticates the bearer using a fixed status call before registering. Both bind/revoke RPC require `operator.admin`. The adapter fails before model inference when the native plugin is unavailable. Browser-bound native runs have a bounded 30-minute total budget so a five-minute human pause fits; normal/supervised defaults and explicit overrides remain unchanged.

Before each native `shared_browser` call, the hook checks actual runtime run/session/tool-call context and injects a random one-use ticket. Execution consumes that exact ticket, revalidates its input/session and forwards only the strict action. Native browser is blocked for browser-bound runs. Exec/process are blocked only after the first non-status shared-browser call begins; general coding tools remain available before browser use and in other runs. This is an owner-controlled integration, not a sandbox against a malicious local operator, modified harness or arbitrary installed plugin.

Exercise an actual model-driven invoice fixture run, protected lease rejection, current observation checks, Pause/Take over/Resume, cancellation and terminal cleanup. Native run/session acceptance must match the registered binding. Plugin leases and tickets have caps/TTL plus revoke/agent-end/shutdown cleanup. Gateway cancellation revokes browser authority even when the native RPC cleanup fails. Verify the same Chrome process as Browser throughout.

## Completion evidence

Record native versions, actual admitted harness/model, fixture URLs, action counts, original document hashes and owner-contained manifest path. Save only public synthetic page previews. A pass requires actual native tool invocation, verified artifacts, visible takeover behavior and no queued/stale action replay; mocks or advertised tools alone cannot satisfy it. Keep any unverified harness or credential test explicitly pending.
