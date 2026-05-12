# Feature Specification: VPS Browser Runtime

**Feature Branch**: `074-vps-browser-runtime`
**Created**: 2026-05-12
**Status**: Draft
**Input**: User description: "Add a Matrix Browser app backed by a VPS-local Chromium capability. Users can open a browser inside Matrix canvas as an iframe-hosted Matrix app, or as a standalone browser route like app.matrix-os.com/browser/google.com. The target site itself must render in a real Chromium session running on the user-owned VPS, with persisted login/profile/download state in the owner home, not in the platform. The feature should install/provision one Chromium capability per customer VPS, launch browser sessions on demand through a local browser broker, stream the browser viewport/input to Matrix, enforce owner isolation, session caps, timeouts, resource cleanup, and avoid implementing arbitrary website rendering as a generic HTTP reverse proxy."

## Clarifications

### Session 2026-05-12

- Q: Where does the Browser capability run relative to the owner VPS? → A: A VPS-native `matrix-browser.service` installed from the customer host-bundle path runs on the owner's VPS host, with Chromium profiles mounted from owner-controlled storage. Platform code can version and upgrade the service artifacts, but owner browser data stays on owner storage and is never copied to platform infrastructure.
- Q: How are the Browser stream and standalone Browser route authenticated across origins? → A: Same-origin only. Both Canvas embedding and the standalone Browser route are served from the owner's VPS hostname (e.g., the user's Matrix host) and authenticated by the existing Matrix session. WebSocket upgrades use a short-lived signed token in the subprotocol; no cross-origin cookie sharing, no wildcard CORS.
- Q: What does the public `app.matrix-os.com/browser/...` route do if Browser must be same-origin with the owner VPS? → A: Platform routes may only authenticate, resolve the owner, and issue a short-lived 302/303 handoff to the owner's VPS Browser route. The platform must not proxy Browser streams, APIs, page contents, cookies, or downloads.
- Q: What happens when one owner opens the Browser in Canvas and the standalone route at the same time? → A: A single live runtime session per owner profile is multiplexed across surfaces on the same device. Both surfaces share the runtime and profile lock, but exactly one surface holds the input focus lease at a time. A second physical device opening the same profile is rejected with a recoverable "open elsewhere, take over?" prompt.
- Q: What is the exact scope of "clear Browser profile data"? → A: User chooses subset from: cookies, IndexedDB, LocalStorage/SessionStorage, Cache Storage and Service Workers, site permissions, saved form data/autofill, saved passwords, browsing history, and downloads. Each toggle is independent; "clear all" selects every toggle. Active sessions are closed before clearing.
- Q: Which browser features are deferred from v1 instead of partially supported? → A: Passkeys, WebAuthn hardware authenticators, camera, microphone input, geolocation, clipboard write, native file picker, and screen capture. Audio output is supported by the Browser media plane and starts muted unless the user unmutes. Sites that request deferred features get an "unavailable in Matrix Browser v1" response without crashing the page. Future scope.
- Q: Where does URL validation happen for navigation and redirects? → A: Server-side preflight before the runtime navigates. Redirect chains are intercepted at the runtime and each hop is revalidated against the same policy; the runtime cannot follow a redirect that the preflight would have blocked.
- Q: How does Matrix prevent DNS rebinding between preflight and Chromium navigation? → A: Preflight validation returns a navigation policy binding for the normalized URL, resolved address set, and expiry. The runtime enforces the binding with Chromium request/WebSocket interception and host resolver pinning where available; if a request resolves outside the approved public address set, navigation is blocked before bytes are read.
- Q: How does Browser WebRTC work across NAT without leaking VPS topology? → A: v1 uses platform-managed TURN credentials minted per Browser session with relay-only ICE. STUN/direct host candidates are not exposed to clients. TURN relays encrypted WebRTC packets and must not receive page contents, cookies, downloads, or decrypted media.
- Q: Who initiates the WebRTC offer/answer exchange? → A: The Browser service is the offerer because it owns the server-side Chromium media tracks. The client answers with receive-only audio/video transceivers and sends bounded ICE candidates that pass the relay-only policy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse Inside Matrix Canvas (Priority: P1)

A user opens the Browser app from Matrix and uses a normal website inside a Matrix window while the website runs in their own persisted browser environment.

**Why this priority**: The main value is making the web available as part of the Matrix workspace without depending on whether third-party sites allow iframing.

**Independent Test**: Open the Browser app in Canvas, navigate to a site that commonly blocks direct embedding, sign in or create local browser state, close the Matrix window, reopen it, and verify the browser state remains available for the same owner.

**Acceptance Scenarios**:

1. **Given** a user has an active Matrix session and their VPS supports the Browser capability, **When** they open the Browser app in Canvas, **Then** Matrix displays an interactive browser viewport inside the app window.
2. **Given** the user navigates to a website that would block direct iframe embedding, **When** the site loads through the Browser app, **Then** the page remains usable because the target site is rendered by the user's VPS-local browser session rather than by a direct website iframe.
3. **Given** the user signs in to a website or stores site preferences, **When** they close and reopen the Browser app, **Then** the same owner profile can resume that site state unless the user explicitly clears it.

---

### User Story 2 - Open A Browser Route Outside Canvas (Priority: P1)

A user or agent opens a URL-shaped Matrix route and sees the same persisted browser capability in the user's normal browser tab without the Canvas shell around it.

**Why this priority**: Some workflows need a focused full-tab browser surface while still using Matrix-owned identity, persistence, and routing.

**Independent Test**: Open a route such as `/browser/google.com`, authenticate as a Matrix user, verify it resolves to that user's browser capability, navigate, then open the Browser app in Canvas and confirm the session is available under the same owner profile.

**Acceptance Scenarios**:

1. **Given** a user is authenticated to Matrix, **When** they open a Matrix browser route with a target URL, **Then** Matrix opens the Browser experience as a standalone app surface.
2. **Given** the standalone route targets a hostname without an explicit scheme, **When** Matrix starts navigation, **Then** Matrix normalizes it to a safe web URL before requesting the browser session.
3. **Given** the user is not authenticated, **When** they open a Matrix browser route, **Then** Matrix requires authentication before any owner browser session or target navigation is created.

---

### User Story 3 - Persist Owner Browser Profiles (Priority: P1)

A user can rely on browser logins, cookies, site storage, downloads, and session metadata belonging to their Matrix owner environment rather than the platform.

**Why this priority**: Browser state includes highly sensitive personal data. It must follow Matrix's owner-controlled VPS model.

**Independent Test**: Sign in to a website, download a file, inspect the owner data export/recovery surface, and verify profile and download state are scoped to the user's VPS-owned data and not shared with another owner.

**Acceptance Scenarios**:

1. **Given** two different Matrix owners have Browser capability, **When** both open the same website, **Then** each owner receives an isolated profile and cannot observe the other's cookies, storage, downloads, history, or active tabs.
2. **Given** a user downloads a file through the Browser app, **When** the download completes, **Then** the file is available only in that owner's Matrix files/downloads area.
3. **Given** the user exports or recovers their Matrix-owned state, **When** Browser data is included in scope, **Then** browser profiles, session metadata, and downloads are handled as owner data with clear retention and deletion behavior.

---

### User Story 4 - Manage Browser Sessions Safely (Priority: P2)

A user can create, switch, close, and recover browser tabs or sessions without exhausting the VPS or corrupting browser profile state.

**Why this priority**: A browser is resource-heavy. Matrix must make it reliable on a per-user VPS instead of allowing runaway sessions.

**Independent Test**: Open multiple browser tabs/sessions until configured limits are reached, leave them idle, reload the Matrix shell, and verify limits, idle cleanup, profile locking, and recoverable session state behave predictably.

**Acceptance Scenarios**:

1. **Given** a user opens several browser tabs, **When** the owner session limit is reached, **Then** Matrix prevents additional sessions with a safe recoverable message.
2. **Given** a browser session is idle past the configured timeout, **When** Matrix performs cleanup, **Then** Matrix closes or hibernates the runtime session while preserving durable profile state.
3. **Given** Matrix restarts while a browser session exists, **When** the user returns, **Then** Matrix either reconnects to the session or marks it recoverable without corrupting the browser profile.

---

### User Story 5 - Agent-Assisted Browser Use (Priority: P3)

A user can ask the Matrix agent to open or inspect browser sessions under explicit user control without granting broad access to private browser data by default.

**Why this priority**: Browser capability is valuable to the AI kernel, but browsing credentials and page contents are sensitive and must require explicit boundaries.

**Independent Test**: Ask an agent to open a site in Browser, verify the browser opens for the correct owner, and verify agent access to page state is limited by user-approved permissions.

**Acceptance Scenarios**:

1. **Given** a user asks Matrix to open a website, **When** the agent launches Browser, **Then** the session is created under the user's owner scope.
2. **Given** an agent requests page inspection or control, **When** the user has not granted that access, **Then** Matrix denies the action or asks for explicit permission.
3. **Given** the user grants a scoped browser action, **When** the agent completes it, **Then** Matrix records the action and keeps credentials, cookies, and unrelated tabs out of agent-visible output.

### Edge Cases

- The user's VPS is provisioning, offline, overloaded, or missing the Browser capability.
- A target URL is malformed, uses an unsupported scheme, attempts local/private network access, or redirects to a blocked destination.
- The website blocks automation, requires passkeys or hardware-backed authentication, opens popups, requests downloads, requests camera/microphone-input/location, or uses WebSockets.
- The browser profile is locked, corrupted, too large, or restored from an older backup.
- The user opens the same profile from Canvas and standalone Browser surfaces at the same time (single-session multiplex; see Clarifications).
- The user opens the same profile from a second physical device while a session is live (take-over prompt; see Clarifications).
- A browser session disconnects while a page is loading, downloading, or asking for credentials.
- The owner reaches tab, session, memory, CPU, disk, download, or idle-time limits.
- A user attempts to share, export, delete, or recover Browser data while a session is active.
- A browser viewport stream fails while the underlying session remains alive.
- An agent requests access to page contents, screenshots, downloads, or credentials beyond the user's approved scope.
- A target site requires a deferred feature (passkey/WebAuthn/camera/microphone-input/geolocation/clipboard/file picker/screen capture); the site must remain usable for non-deferred flows.
- A target site uses audio output; the user must be able to hear it after an explicit unmute without granting microphone input.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a first-party Matrix Browser app that opens inside Matrix app windows and supports a standalone full-tab Matrix browser route.
- **FR-002**: The Browser app MUST render arbitrary target websites through a real browser session owned by the user's VPS environment, not by directly iframing the target website.
- **FR-003**: The standalone Browser route MUST authenticate the Matrix user before creating, resuming, or navigating any owner browser session.
- **FR-004**: Browser profile data, cookies, site storage, history where enabled, downloads, and session metadata MUST be scoped to the Matrix owner and stored with owner-controlled state.
- **FR-005**: The platform MUST NOT store or share users' browser cookies, site storage, active page contents, downloads, or browsing credentials.
- **FR-006**: Each customer VPS that supports Browser MUST expose one local Browser capability that can launch and manage owner-scoped browser sessions on demand. The capability runs as a VPS-native `matrix-browser.service` installed and upgraded through the host-bundle/provisioning path, with the owner profile mounted from owner-controlled storage.
- **FR-007**: Browser sessions MUST be launch-on-demand and MUST NOT require a permanently active browser process when no session is in use. Idle sessions are torn down after a configurable idle timeout (default 15 minutes). On reconnect, tabs are restored from saved URLs and tab order; transient in-memory state (unsaved form data, in-flight requests) is not preserved.
- **FR-008**: Users MUST be able to open, navigate, refresh, go back, go forward, close, and resume browser tabs or sessions.
- **FR-009**: Users MUST be able to clear Browser profile data and downloads for their owner scope. The clear surface MUST offer independent toggles for: cookies, IndexedDB, LocalStorage/SessionStorage, Cache Storage and Service Workers, site permissions, saved form data/autofill, saved passwords, browsing history, and downloads. Active sessions MUST be closed before any selected scope is cleared.
- **FR-010**: Browser downloads MUST land in an owner-scoped files/downloads area and MUST be discoverable from Matrix file surfaces. Partial downloads MUST be staged in a runtime-private area and become visible to Matrix file APIs only after successful completion; interrupted downloads MUST be marked failed and cleaned up.
- **FR-011**: Browser sessions MUST support both Canvas app-window use and standalone full-tab use without creating separate uncoordinated profile state. A single live runtime session per owner profile MUST be multiplexed across concurrent surfaces on the same device; a second physical device requesting the same profile MUST receive a recoverable take-over prompt rather than creating a parallel writer.
- **FR-011a**: Multiplexed surfaces MUST use an explicit focus lease for user input. The runtime accepts pointer, wheel, keyboard, IME, and paste input only from the currently focused surface, broadcasts focus changes to all surfaces, and rejects stale input with a safe bounded error instead of merging simultaneous input streams. Agent `automate_input` actions do not claim a UI focus lease; they require an active grant and run through the same bounded serialized action queue as user input.
- **FR-012**: The Browser app MUST show recoverable states for unsupported URLs, missing capability, offline VPS, reached limits, disconnected streams, profile locks, take-over conflicts, deferred-feature requests, and session startup failures.
- **FR-013**: Matrix MUST validate and normalize target URLs before navigation and MUST reject unsafe schemes and blocked network destinations. Validation MUST happen server-side as a preflight before the runtime navigates.
- **FR-014**: Matrix MUST avoid implementing arbitrary website browsing as a generic HTTP reverse proxy that rewrites third-party responses, cookies, scripts, or security headers.
- **FR-015**: Browser sessions MUST enforce owner-level caps for active sessions, tabs, concurrent streams, memory, disk usage, downloads, and idle duration.
- **FR-016**: Browser profiles MUST be protected from concurrent writers that could corrupt the profile. The profile lock MUST be held by the single live runtime session described in FR-011; multiplexed surfaces on the same device share that lock and do not contend.
- **FR-017**: Matrix MUST record enough session metadata for users to resume, close, audit, export, or delete Browser state without exposing sensitive page contents in logs.
- **FR-018**: Agent access to Browser page contents, screenshots, downloads, credentials, and control actions MUST be scoped by explicit user permission.
- **FR-019**: Public and developer documentation MUST explain Browser data ownership, standalone route behavior, limitations, profile persistence, downloads, cleanup, deferred features, and agent-access boundaries.
- **FR-019a**: Documentation MUST explain idle hibernation precisely: reopening a hibernated session restores tabs from saved URLs and durable browser storage, but re-runs page loads, analytics, and page scripts and cannot preserve unsaved in-memory page state.

### Security, Privacy, And Resource Requirements

- **FR-020**: Every Browser HTTP route, WebSocket route, stream route, session action, download action, profile action, and agent action MUST enforce authenticated owner context.
- **FR-021**: Browser WebSocket or streaming routes used from browser clients MUST authenticate via the existing Matrix session plus a short-lived signed token carried in the WebSocket subprotocol. Unauthenticated upgrades, cross-origin upgrades, and wildcard CORS MUST be rejected. The Browser surface (Canvas embed and standalone route) MUST be served same-origin with the owner's VPS hostname.
- **FR-021a**: Platform-owned `app.matrix-os.com/browser/...` entrypoints, if present, MUST authenticate and redirect to the owner VPS Browser route using a short-lived handoff token. They MUST NOT proxy Browser APIs, WebSocket streams, media streams, page contents, cookies, downloads, or Chromium traffic.
- **FR-021b**: Platform handoff tokens MUST be asymmetrically signed by the platform and verified by the owner VPS using a pinned public key or JWKS distributed through the host-bundle/provisioning path. Shared per-VPS HMAC secrets MUST NOT be used for Browser handoff verification.
- **FR-022**: Every Browser mutating endpoint MUST apply request body limits before buffering request bodies.
- **FR-023**: All target URL, route parameter, query parameter, session identifier, profile identifier, download identifier, and action payload values MUST be validated at the boundary.
- **FR-024**: Server-side URL checks MUST block loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), private (10/8, 172.16/12, 192.168/16, fc00::/7), multicast, documentation, broadcast, unspecified, container-network ranges (e.g., Docker bridge), the owner's own VPS hostnames, and Matrix control-plane destinations. IPv4 and IPv6 MUST be checked symmetrically. Hostname-to-IP resolution MUST happen at preflight time and the resolved IP MUST be revalidated, not just the hostname.
- **FR-025**: Redirect handling MUST intercept every hop at the runtime and revalidate the redirected URL against FR-024 before continuing; redirects that would be blocked at preflight MUST also be blocked at hop time, and the runtime MUST surface a generic "blocked redirect" message without exposing chain details.
- **FR-025a**: Runtime navigation MUST enforce DNS-rebinding protection after preflight. The implementation MUST pin or revalidate the destination address set at Chromium request/WebSocket time using host-resolver rules, network interception, or an equivalent mechanism; hostname-only validation is insufficient.
- **FR-026**: Client-visible errors MUST be generic and MUST NOT expose provider names, internal paths, raw browser/runtime errors, stack traces, DNS details, upstream status codes, or sensitive target data.
- **FR-027**: Browser session registries, stream subscriber registries, pending input queues, download trackers, screenshot buffers, and profile locks MUST have explicit caps and cleanup policies.
- **FR-028**: Stale Browser streams and subscribers MUST be evicted even when a network partition skips normal close handlers.
- **FR-029**: Browser runtime shutdown MUST drain or mark active sessions recoverable before destroying dependencies used by authorization, profile state, downloads, or streams.
- **FR-030**: Temporary files, partial downloads, screenshots, crash dumps, and derived thumbnails MUST have symlink-safe recurring cleanup policies.
- **FR-031**: Logs and audit records MUST avoid storing raw page content, cookies, authorization headers, password fields, credential prompts, and unbounded URLs.
- **FR-032**: The implementation plan MUST include tests for auth rejection, owner isolation, URL validation (v4 and v6, hostname-to-IP rebind), redirect blocking, session caps, profile locking, multiplexed surfaces, take-over conflicts, stream cleanup, download scoping (staging vs. visible), deferred-feature responses, and safe error messages.
- **FR-032a**: Browser media MUST use a production media plane with bounded bandwidth, adaptive quality, audio output support, and observable latency. WebSocket base64 full-frame streaming MAY exist only as a bounded diagnostic or fallback path, not as the primary production viewport transport.
- **FR-032b**: Browser WebRTC MUST use relay-only ICE for v1. TURN credentials MUST be short-lived, owner/session-bound, and revocable; local/private/loopback host candidates MUST be filtered from signaling. The client-visible protocol MUST NOT expose VPS private addresses or loopback candidates.
- **FR-032c**: Browser service MUST initiate the WebRTC offer after media tracks are available. Clients answer with receive-only audio/video transceivers and bounded ICE candidates; incompatible or policy-violating candidates are rejected with a generic media error.

### Permission Grants, Audit, and Code Pattern Requirements

- **FR-033**: A Browser Permission Grant MUST identify (a) the granting owner, (b) the requesting app or agent identifier, (c) the scope (read DOM, take screenshot, download, navigate, automate input), (d) the allowed domain or domain set, and (e) an expiry. Default expiry is the earlier of the bound Matrix web session expiry or 8 hours from grant creation unless the user chooses a shorter duration. Grants MUST be persisted under owner-controlled state and MUST be revocable from a Matrix permission surface. Revocation MUST take effect on the next agent action without restarting the session.
- **FR-034**: Browser Audit Events MUST cover at minimum: session.created, session.closed, session.idle_hibernated, session.taken_over, navigation.attempted (target URL only), navigation.blocked (blocked-reason category), download.started, download.completed, download.failed, download.deleted, profile.cleared (selected scopes), permission.granted, permission.revoked, agent.access (action + scope). Audit records MUST be owner-visible and bounded; FR-031 redaction applies. Default audit retention is 180 days unless the owner chooses a shorter retention policy; export/delete flows apply before pruning.
- **FR-035**: Every outbound `fetch()` made by Browser gateway or capability code (URL preflight, redirect revalidation, agent helper calls) MUST carry `AbortSignal.timeout()`. Defaults: 10s for URL preflight and Matrix API calls, 30s for download initialization; per-call timeouts MAY override but MUST NOT remove the signal.
- **FR-036**: Browser session metadata, audit records, and download index updates MUST be written via async `fs/promises` or transactional Postgres writes. Synchronous file APIs (`writeFileSync`, `appendFileSync`) are banned in request handlers. Multi-step state changes that include both a session-registry write and a profile/lock write MUST use a transaction or the equivalent atomic primitive.
- **FR-037**: Any filesystem path derived from owner input (download filename, profile name, export target) MUST be resolved via `resolveWithinHome` (or equivalent owner-scoped resolver) before use. Path traversal, symlink escapes, and absolute-path injection MUST be rejected at the boundary.
- **FR-038**: All Browser tests MUST follow TDD: failing tests for auth, owner isolation, URL validation, profile locking, and stream cleanup are written before the corresponding implementation.
- **FR-039**: The Browser service unit and Chromium launch profile MUST include defense-in-depth hardening: a non-root service user, no new privileges, private temp, restricted filesystem access with explicit owner-profile/download carve-outs, bounded CPU/memory/process/file limits, restart policy, and explicit shutdown drain behavior.
- **FR-040**: Browser stream and control protocols MUST include protocol version negotiation. Clients and servers with incompatible protocol versions fail closed with a generic upgrade-required message.
- **FR-041**: Linux Chromium launch MUST use a deterministic password-store mode for v1, such as `--password-store=basic`, so saved-password persistence and `savedPasswords` clearing are testable on headless VPS hosts without GNOME libsecret or KWallet.

### Key Entities *(include if feature involves data)*

- **Browser Capability**: The VPS-local ability to create and manage owner-scoped browser sessions for Matrix, installed as a VPS-native host service through Matrix provisioning and host-bundle updates.
- **Browser Profile**: Persisted owner-scoped browser state including site storage, cookies, preferences, and related durable data. Stored under owner-controlled storage; never copied to platform infrastructure.
- **Browser Session**: A resumable runtime session that contains one or more tabs and connects Matrix UI surfaces to the owner profile. At most one live runtime session per profile.
- **Browser Tab**: A navigable page within a Browser session with current URL, title, loading state, permission prompts, and recoverability state.
- **Browser Stream**: The interactive viewport and input channel connecting a Matrix app surface to a Browser session. Multiple surfaces on the same device share a single runtime via multiplexed streams.
- **Browser Download**: A file initiated by a Browser tab. Lives in a runtime-private staging area until completion, then moves to the owner-scoped Matrix files/downloads area.
- **Browser Route Target**: A user-provided destination URL or hostname submitted through the standalone Browser route or app navigation bar. Normalized and validated server-side before navigation.
- **Browser Permission Grant**: A user-approved scope (see FR-033) that allows an app or agent to inspect, control, or access part of a Browser session for a bounded domain set and expiry.
- **Browser Audit Event**: A bounded owner-visible event describing security-sensitive Browser actions (see FR-034).

### Assumptions

- The initial scope is personal owner VPS Browser support; organization-managed Browser policies can extend the same model later.
- The target website is untrusted content and never becomes a privileged Matrix app just because it is visible inside Browser.
- Browser state persistence is expected to survive normal Matrix window close/reopen and VPS service restart, but runtime tabs may be marked recoverable instead of kept live forever.
- Matrix provides a single default owner profile in v1; multiple named profiles per owner are a later extension.
- The following features are explicitly deferred and out of v1 scope: passkeys, WebAuthn hardware authenticators, camera, microphone input, geolocation, clipboard write, native file picker, and screen capture. Sites requesting these receive an "unavailable in Matrix Browser v1" response without crashing the page. Each requires an explicit policy decision before being enabled.
- Browser is a first-party Matrix app surface and follows Canvas-first UX and standalone app route conventions.
- The Browser capability service is owned and versioned by the platform but runs on the owner's VPS host; it has no path to platform-side storage for owner browser data.

### Security Architecture

| Surface | Operations | Auth Method | Public? | Authorization / Notes |
|---------|------------|-------------|---------|-----------------------|
| Browser app session | Open Browser inside Canvas or standalone app route | Matrix session | No | Resolves the current owner before any browser session is created. Same-origin with owner VPS hostname. |
| Browser standalone route | Normalize target, create/resume owner session, show Browser surface | Matrix session | No | Route may be easy to share by URL, but it must not be anonymously usable. |
| Browser session API | Create, list, resume, close, clear state | Matrix session or authorized agent delegation | No | Owner scope is mandatory for every operation. |
| Browser stream | Viewport frames, input events, resize, focus, reconnect | Matrix session + short-lived signed token in WebSocket subprotocol | No | Same-origin only. Stream subscribers are owner-scoped, capped, and evicted when stale. No wildcard CORS. |
| Browser navigation | Load URL, redirect, back, forward, refresh | Matrix session or scoped agent grant | No | Server-side URL preflight + per-hop redirect revalidation are required before navigation proceeds. |
| Downloads | Start, complete, list, open, delete | Matrix session | No | Files staged runtime-private, then surfaced into owner-scoped Matrix file/download surfaces on completion. |
| Permission grants | Create, list, revoke | Matrix session (owner only) | No | Grants are domain-scoped, time-bounded, agent-bounded. |
| Agent access | Open, inspect, summarize, control, download access | Explicit owner Permission Grant | No | Default is no page-content or credential access. |
| VPS Browser capability health | Check availability and coarse readiness | Matrix session or internal platform health | No | Client-visible health must be coarse and avoid runtime/provider detail. |
| Platform Browser handoff | Resolve owner VPS route and redirect | Matrix session + short-lived handoff token | No | Platform must redirect only; no Browser proxying or page/media traffic through platform. |
| Browser TURN relay | Relay encrypted Browser WebRTC packets | Short-lived owner/session-bound TURN credentials | No | Relay-only ICE. TURN must not terminate media or receive cookies, page contents, downloads, or decrypted frames/audio. |

### Integration Wiring Requirements

- The Browser app MUST be discoverable as a first-party Matrix app and must work in Canvas before Desktop compatibility is considered complete.
- The standalone Browser route MUST launch the same Browser app experience without Canvas chrome while preserving Matrix authentication and owner resolution. Both surfaces MUST be served same-origin with the owner's VPS hostname.
- Platform Browser entrypoints MUST resolve the authenticated user to their customer VPS and redirect to the owner-hosted Browser route. Browser session work, APIs, WebSocket control, media transport, cookies, downloads, and page contents MUST stay on the owner VPS.
- Browser session creation and streaming MUST happen through the owner VPS capability, not from platform-global browser infrastructure.
- The Browser capability runs as a VPS-native service on the owner VPS host, with the owner profile mounted from owner-controlled storage. The service has no credentials or paths reaching platform-side storage for browser data.
- Browser capability provisioning MUST be part of the customer VPS baseline or an explicit per-VPS upgrade path.
- Existing VPS recovery and owner data export/delete paths MUST include Browser profile, session metadata, and downloads according to the user's selected scope.
- Browser UI surfaces MUST degrade to safe states when the capability is unavailable, provisioning, restarting, overloaded, or blocked by policy.
- Agent/browser integration MUST route through explicit Browser Permission Grants (FR-033) and must not use hidden direct access to browser profile files.

### Failure Modes And Resource Management

- Browser startup failure MUST leave the user with a recoverable message and no partially trusted profile state.
- Profile lock contention MUST prevent concurrent writers across physical devices and allow the user to take over, wait, or recover a session safely. Multiplexed surfaces on the same device share the lock (FR-011/FR-016) and do not contend.
- Takeover MUST notify evicted streams with an explicit taken-over state before closing, so the UI can render a correct recoverable state rather than a generic disconnect.
- Takeover MUST create a `session.taken_over` audit event that identifies bounded session/device metadata without storing page contents or raw device fingerprints.
- Idle sessions MUST be torn down or hibernated according to the FR-007 idle policy while retaining durable owner profile state. On reconnect, tabs are restored from saved URLs; transient runtime state is not preserved.
- Active sessions MUST be bounded by owner-level limits and must release stream subscribers, temporary files, partial downloads, and runtime handles on close.
- Disconnected streams MUST not keep unbounded buffers or live subscribers.
- Downloads interrupted by session close, VPS restart, or network failure MUST be marked partial or failed and cleaned up safely. Partial files MUST remain in the runtime-private staging area and never appear in the owner's Matrix files surface.
- URL validation failures, redirect blocks, blocked permission prompts, deferred-feature requests, and reached resource limits MUST be user-recoverable and must not expose internal diagnostics.
- VPS recovery MUST distinguish persisted profile data, resumable session metadata, and non-resumable live browser processes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can open Browser in Matrix Canvas, navigate to a mainstream site that does not require a deferred feature, and interact with it in under 15 seconds when their VPS is healthy.
- **SC-002**: A user can open a standalone Matrix browser route with a target hostname and reach the authenticated Browser surface without manually opening Canvas.
- **SC-003**: A login or site preference created in Browser remains available after closing and reopening the Browser app for the same owner profile.
- **SC-004**: Two different Matrix owners opening the same site cannot access each other's browser cookies, site storage, downloads, active tabs, or session metadata in tests.
- **SC-005**: Session, tab, stream, download, idle-time, and disk/memory limits are enforced with safe recoverable user messages.
- **SC-006**: Unsafe URLs and unsafe redirects are rejected before navigation with no client-visible internal network or provider details, for both IPv4 and IPv6 destinations and including hostname-to-IP rebind attempts.
- **SC-007**: Browser downloads appear in the owner's Matrix file/download surface only after successful completion and can be deleted with owner data.
- **SC-008**: VPS restart or Matrix service restart preserves Browser profile state and marks non-resumable runtime sessions recoverable rather than silently losing owner data.
- **SC-009**: Security review confirms explicit auth, validation, timeout, resource-limit, cleanup, owner-isolation, same-origin enforcement, no-wildcard-CORS, fs/promises usage, and safe-error policy for every Browser operation before release.
- **SC-010**: Public docs describe how Browser works, where data lives, how to clear it, what standalone routes do, which features are deferred from v1, and what agent access can and cannot see.
- **SC-011**: Canvas and standalone surfaces on the same device attach to one runtime, focus changes are broadcast, stale input is rejected, and a second physical device receives takeover flow with an explicit taken-over notification to evicted streams.
- **SC-012**: Production Browser media uses the WebRTC media plane with audio output, bounded bitrate/frame-rate settings, and measured sub-250ms p95 input-to-visible-update latency on a healthy VPS/client path; WebSocket frame streaming is verified as fallback-only.
- **SC-013**: Production rollout verifies `matrix-browser.service` and Chromium hardening: non-root service user, no new privileges, private temp, restricted writable paths, resource limits, no production `--no-sandbox`, shutdown drain, and recoverable session marking.
- **SC-014**: WebRTC sessions succeed from a client behind NAT using relay-only ICE, expose no private/loopback VPS candidates in signaling, and use short-lived owner/session-bound TURN credentials.
- **SC-015**: Browser handoff tokens are verified on the owner VPS with platform public-key material from the host bundle; tests reject unsigned, expired, replayed, wrong-owner, and HMAC-style shared-secret handoff tokens.
