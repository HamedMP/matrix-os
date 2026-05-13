# Research: VPS Browser Runtime

## Decision: Reuse and extend `@matrix-os/mcp-browser` as the browser control substrate

**Rationale**: The repo already has a Playwright-backed browser package with persistent profile paths, single-session management, action serialization, URL validation, request/WebSocket guards, screenshot/PDF artifact confinement, and kernel MCP registration. Extending this into shared runtime/session primitives avoids a second browser automation stack and keeps agent browsing and user-visible Browser on the same security model.

**Alternatives considered**:
- Build a new browser service from scratch: rejected because it duplicates existing URL/profile/security/session code and increases review surface.
- Embed target sites directly in iframes: rejected because major sites block embedding and because Matrix would not own persistence.
- Reverse-proxy arbitrary sites through `/browser/*`: rejected because response rewriting, cookies, CSP, redirects, WebSockets, and SSRF make it fragile and unsafe.

## Decision: Refactor `@matrix-os/mcp-browser` into a shared-runtime, multi-consumer contract

**Rationale**: The current `SessionManager` is intentionally single-active-session and single-active-page, which is sufficient for agent control but not enough for a user-visible Browser where Canvas and standalone surfaces can attach to the same owner profile. Browser v1 keeps one live Chromium runtime per owner profile, but splits that runtime into explicit concepts: profile lock, runtime session, tabs/pages, UI streams, focus lease, and serialized control actions. Same-device Canvas/standalone surfaces attach as multiple consumers of the same runtime. A second physical device must go through takeover and cannot open another writer against the profile.

The shared-runtime contract must be covered by tests before implementation:
- Same device attaches Canvas and standalone surfaces to one runtime and one profile lock.
- Only the focused surface can send pointer, wheel, keyboard, IME, and paste input.
- Agent actions and user input share one bounded action queue with permission checks at execution time.
- Second-device attach returns takeover-required without launching Chromium.
- Confirmed takeover notifies existing streams before closing them and atomically replaces the old lock/session with the new runtime session in one transaction or compare-and-swap operation; there must be no gap where two writers can launch against the same profile.

**Alternatives considered**:
- Keep `SessionManager` single-owner and create a separate Browser runtime: rejected because agent and user Browser would diverge on profile/security behavior.
- Let every surface own a separate Chromium process and rely on profile locking: rejected because it creates profile corruption risk and confusing user state.
- Merge simultaneous input streams without focus: rejected because two active cursors/keyboards produce nondeterministic browser actions.

## Decision: VPS-native `matrix-browser.service` with system Chromium

**Rationale**: Production Matrix OS is VPS-native per user. Browser should be a host service/capability installed on the customer VPS, managed by systemd, and shipped through the host-bundle/provisioning path. Chromium is installed as a VPS runtime dependency; the Matrix Node service uses Playwright-compatible control against the local browser capability.

The service unit must run as a non-root browser user and include defense-in-depth hardening: `NoNewPrivileges=yes`, `PrivateTmp=yes`, restricted filesystem access with explicit writable owner profile/download/runtime directories, process/file/memory limits, bounded restart policy, and an `ExecStop`/shutdown path that marks sessions recoverable and drains streams before dependencies disappear. Chromium launch flags must preserve Chromium's sandbox where supported; `--no-sandbox` is not acceptable for production. Any fallback needed for a specific VPS kernel must be documented as an explicit degraded mode.

Chromium launch must use deterministic headless-server storage behavior. For v1, saved passwords use a predictable Linux password store such as `--password-store=basic` so the `savedPasswords` clear-data toggle is testable on VPS hosts without GNOME libsecret or KWallet. If a stronger password-store integration is added later, the clear-data contract must be revalidated before release.

**Alternatives considered**:
- Platform-global browser pool: rejected because browser cookies, downloads, and page contents would leave owner-controlled infrastructure.
- Docker Compose browser sidecar for production: rejected because production customer runtime is not Docker Compose.
- Always-on Chromium process: rejected because idle browser memory is too expensive for per-user VPSes.

## Decision: One default owner profile and one live runtime session per profile for v1

**Rationale**: Chromium persistent profiles are not safe with multiple concurrent writers. v1 keeps a single default profile per owner, one live runtime session for that profile, multiplexed across Canvas and standalone surfaces on the same device. A second physical device receives a recoverable take-over prompt.

**Alternatives considered**:
- Parallel runtime sessions against one profile: rejected because profile corruption risk is unacceptable.
- Multiple named profiles in v1: deferred to reduce product and permission complexity.
- Browser-local web storage only: rejected because login/session persistence would not belong to the VPS owner.

## Decision: Store structured metadata in owner Postgres and browser payloads in owner filesystem

**Rationale**: Matrix's data model uses Postgres/Kysely for structured user/app state and owner files for inspectable/exportable file data. Browser profiles and downloads are naturally filesystem-backed browser/file payloads, while sessions, tabs, grants, and audit events need queryable structured state and ownership filters.

**Alternatives considered**:
- Put all browser state in files: rejected because session lists, grants, audit filtering, and cleanup jobs become weaker and less queryable.
- Store Chromium profiles in Postgres blobs: rejected because browser profile data is large, file-oriented, and managed by Chromium.
- Add SQLite or a new ORM: rejected by Matrix constitution and repo rules.

## Decision: Same-origin Browser surfaces plus short-lived stream tokens in WebSocket subprotocol

**Rationale**: Canvas and standalone Browser should be served from the owner's VPS hostname with the existing Matrix session. Browser clients cannot set arbitrary Authorization headers for WebSocket upgrades, and wildcard CORS is forbidden. A short-lived signed stream token bound to owner/session/profile/surface/device, carried in the WebSocket subprotocol, lets the gateway reject unauthenticated upgrades without cross-origin cookies.

Platform-level convenience routes such as `app.matrix-os.com/browser/google.com` are redirect-only handoffs. The platform may authenticate, resolve the owner VPS hostname, mint a short-lived handoff token, and return a 302/303 to the owner VPS Browser route. The platform must not proxy Browser REST APIs, WebSocket control, WebRTC media, page contents, cookies, downloads, or Chromium network traffic.

Handoff tokens use asymmetric signing. The platform signs with a private key; owner VPSes verify with a pinned public key or JWKS distributed in the host bundle/provisioning metadata. Shared HMAC secrets are rejected because they blur the platform/owner boundary and make key rotation harder to reason about.

**Alternatives considered**:
- Query-token WebSocket auth: existing Matrix routes use it, but this spec explicitly chooses subprotocol tokens for Browser to avoid URLs/logs carrying stream tokens.
- Cross-origin stream host: rejected because it forces CORS/cookie complexity and weakens the owner-host boundary.
- Cookie-only WebSocket auth: rejected because explicit per-stream tokens simplify revocation and stale connection eviction.
- Platform proxy for `/browser/*`: rejected because it violates the owner-host same-origin boundary and risks moving page/media traffic through platform infrastructure.

## Decision: Server-side URL preflight plus runtime request/redirect interception

**Rationale**: The existing browser security package already blocks local/private/link-local/multicast/documentation/internal destinations by parsing and resolving hostnames. Browser v1 must harden that model for user-visible navigation: normalize target URLs, block unsafe schemes/destinations before navigation, install runtime request/WebSocket guards, and intercept every redirect hop for revalidation.

Preflight must produce a bounded navigation policy binding: normalized URL, allowed scheme, hostname, resolved public address set, expiry, and blocked-destination categories. Runtime request and WebSocket interception must compare each request against the active binding and revalidate redirects before bytes are read. Where Chromium supports it, Browser should add host resolver pinning for the preflight address set; if interception remains hostname-based for a hop, the implementation must document the residual DNS-rebinding risk and keep the request blocked unless a fresh safe resolution succeeds.

**Alternatives considered**:
- Browser-only navigation blocking: rejected because the first navigation can still hit unsafe destinations before policy code observes it.
- DNS preflight only: rejected because DNS rebinding and runtime redirects still need request-time enforcement.
- Allow all public browser traffic because Chromium is "just a browser": rejected because Matrix Browser runs server-side on the owner VPS and can reach local networks unless explicitly blocked.
- Trust Chromium DNS resolution after preflight: rejected because the address can change between preflight and connection.

## Decision: WebRTC media plane plus WebSocket control/signaling

**Rationale**: A production browser needs adaptive viewport transport, audio output, backpressure, and latency that full-frame base64 JPEG over WebSocket cannot reliably provide. Browser v1 uses WebRTC as the primary media plane for viewport frames and audio output, while the authenticated Browser WebSocket remains the control plane for stream auth, protocol negotiation, WebRTC signaling, input events, tab/session status, permission prompts, downloads, and safe errors. WebSocket image frames are allowed only as a bounded diagnostic or fallback path with explicit lower quality and rate limits.

The Browser service must publish media budget defaults: max viewport resolution, max frame rate, max bitrate, audio muted-by-default behavior, max concurrent media streams, and p95 input-to-visible-update telemetry. Input-to-viewport target remains sub-250ms p95 on a healthy VPS and healthy client network.

For v1, Matrix uses platform-managed TURN with relay-only ICE. TURN credentials are short-lived, owner/session-bound, and minted by the owner VPS through platform-owned TURN configuration. The relay handles encrypted SRTP packets only; it does not terminate media or receive cookies, page contents, downloads, or decrypted frames/audio. Local, loopback, private, and link-local ICE candidates are filtered from signaling even if the browser or WebRTC stack generates them.

The Browser service is the WebRTC offerer because it owns the Chromium video/audio tracks. It adds bounded send tracks, creates an offer, sends `media.offer` over the authenticated WebSocket, and accepts a client `media.answer` with receive-only audio/video transceivers. Client ICE candidates are accepted only if they satisfy the relay-only policy.

**Alternatives considered**:
- Raw CDP exposed to the app: rejected because it exposes too much browser power to the UI and makes auth/permissions hard to reason about.
- Polling screenshots over HTTP: rejected because input latency and bandwidth would be poor.
- Full-frame base64 JPEG over WebSocket as primary transport: rejected because bandwidth and latency scale poorly and there is no audio output path.
- Full desktop/noVNC stream: viable later, but it exposes a broader desktop surface than a Browser-specific runtime needs.
- Per-VPS coturn in v1: rejected because it adds provisioning, firewall, certificate, abuse-prevention, and monitoring burden to every fresh customer VPS.
- Direct ICE/STUN candidates: rejected because they leak VPS topology and fail for many client NATs.

## Decision: Focus lease and protocol versioning are part of the stream contract

**Rationale**: Multiplexed Browser surfaces need deterministic input behavior. Every stream handshake includes `protocolVersion`, surface id, device id, viewport, and media capabilities. The server replies with supported protocol version, session metadata, and the current focus lease. Focus changes are explicit messages and are broadcast to every attached surface. Pointer, wheel, keyboard, IME, and paste input from non-focused surfaces is rejected with a bounded stale-focus error. Incompatible protocol versions fail closed with a generic upgrade-required error.

Agent `automate_input` is not a UI surface and does not take the focus lease. It requires an active Browser Permission Grant and runs through the same bounded serialized action queue as user input, so user and agent actions cannot interleave inside one Chromium step. The UI may surface that an agent action is running, but the focused surface remains unchanged unless the user changes it.

**Alternatives considered**:
- Let every attached surface send input: rejected because simultaneous pointer/key events produce nondeterministic browser behavior.
- Infer focus only from browser tab focus: rejected because Matrix Canvas and standalone surfaces need UI-level focus semantics before events reach Chromium.
- Ignore protocol versioning until later: rejected because Browser has independently deployed shell/app/service pieces through host bundles.

## Decision: Defer native device/browser features from v1

**Rationale**: Passkeys, WebAuthn hardware authenticators, camera, microphone input, geolocation, clipboard write, native file picker, and screen capture require explicit UX and security policy. Sites requesting them should receive a safe "unavailable in Matrix Browser v1" response without crashing the page. Audio output is not a device permission grant and is supported through the media plane, initially muted until the user unmutes.

**Alternatives considered**:
- Partial best-effort support: rejected because silent permission failures or accidental device access are worse than explicit deferral.
- Blanket deny without UI: rejected because users need to understand why a site flow cannot continue.

## Decision: Downloads use private staging then atomic publish into Matrix files

**Rationale**: Downloads should not appear in Matrix file surfaces until complete. Runtime-private staging prevents partial files from leaking into user workflows. On successful completion, Matrix atomically moves the file into the owner downloads area and indexes it. Interrupted downloads are marked failed and cleaned up.

**Alternatives considered**:
- Browser writes directly into visible downloads: rejected because partial files and unsafe filenames become user-visible.
- Keep downloads only in Chromium profile: rejected because users expect Browser downloads to appear in Matrix Files and exports.

## Decision: Documentation and rollout are part of the feature, not follow-up

**Rationale**: Browser changes affect user expectations, data ownership, security boundaries, VPS provisioning, and host-bundle rollout. User docs must explain where data lives, how to clear it, why some features are deferred, and what agents can see.

**Alternatives considered**:
- Code-only Browser MVP: rejected because privacy and persistence behavior would be opaque.
- Developer-only docs: rejected because normal users need clear controls for data clearing, downloads, and agent access.
