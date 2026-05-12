# Implementation Plan: VPS Browser Runtime

**Branch**: `074-vps-browser-runtime` | **Date**: 2026-05-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/074-vps-browser-runtime/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Add a first-party Matrix Browser app that can run inside Canvas or as a standalone Matrix route while the target website renders in a persisted, owner-scoped Chromium session on the user's VPS. The implementation extends the existing `@matrix-os/mcp-browser` Playwright/Chromium control package into a shared browser runtime layer, adds authenticated Hono session/stream/download/profile APIs in the gateway, uses WebRTC as the production viewport/audio media plane with WebSocket control/signaling, adds a Vite React Browser app under `home/apps/browser`, wires `/browser/:target` to the standalone owner-hosted app surface, and provisions a VPS-native hardened `matrix-browser.service`/Chromium capability through the customer host-bundle path.

The design deliberately avoids arbitrary third-party website iframing and generic HTTP response rewriting. The shell iframe hosts only the first-party Browser app; Browser streams the VPS-local Chromium viewport and input channel over owner-authenticated Matrix routes.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 24+, ES modules, React 19
**Primary Dependencies**: Hono gateway + `@hono/node-ws`, WebRTC media support in the VPS Browser service, platform-managed TURN relay credentials, asymmetric handoff-token verification, Zod 4 via `zod/v4`, Kysely/Postgres, existing `@matrix-os/mcp-browser`, Playwright/Chromium runtime, Vite React app conventions for `home/apps/*`, Next.js 16 shell route/handoff layer
**Storage**: Owner-controlled Postgres via Kysely for Browser session metadata, tabs, grants, and audit records; owner filesystem for Chromium profiles, staged downloads, completed downloads, screenshots/thumbnails, and lock files under owner-scoped paths
**Testing**: Vitest unit/contract/integration suites; shell Playwright screenshots/smokes for Canvas and standalone surfaces; focused customer-VPS health smoke where rollout touches host services
**Target Platform**: Customer VPS host services first; local source dev supported through existing gateway/shell dev scripts; no production Docker Compose rollout path
**Project Type**: Web + backend + VPS runtime capability in an existing monorepo
**Performance Goals**: Healthy VPS opens Browser and reaches first interactive viewport in under 15 seconds; input-to-visible viewport updates target sub-250ms p95 on a healthy VPS/client path; media plane supports adaptive quality, bounded bitrate, relay-only ICE, and audio output; idle runtime teardown within 15 minutes by default; no unbounded stream/input/download buffers
**Constraints**: Canvas-first UX; same-origin Browser surfaces on owner VPS hostname; platform `/browser/*` entrypoints are redirect-only handoffs to the owner VPS; no wildcard CORS; no generic target-site reverse proxy; no platform storage/proxying of browser cookies/site data/page/media/download traffic; owner-scoped limits for sessions/tabs/streams/downloads/disk; every external/preflight call has timeout; mutating routes use `bodyLimit`; URL/redirect SSRF protection must cover IPv4, IPv6, DNS resolution, runtime-request hops, and DNS-rebinding protection at Chromium request time; WebRTC signaling must filter local/private candidates
**Scale/Scope**: v1 supports one default owner profile, one live runtime session per owner profile, multiplexed Canvas/standalone surfaces on the same device, explicit take-over prompt for a second physical device, audio output in the media plane, and deferred passkey/WebAuthn/camera/microphone-input/geolocation/clipboard/file-picker/screen-capture features

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Data Belongs to Its Owner**: PASS. Browser cookies, site storage, downloads, session metadata, grants, and audit data remain on the owner VPS/owner database. The platform resolves routing but does not store browser profile data or page contents.

**AI Is the Kernel**: PASS. Browser can later be exposed to agents through explicit permission grants; hidden direct profile-file access is forbidden. Existing MCP browser tooling is reused as a controlled runtime substrate.

**Headless Core, Multi-Shell**: PASS. Browser capability is exposed through gateway contracts and a first-party app; Canvas and standalone routes are renderers over the same owner-scoped session.

**Quality Over Shortcuts**: PASS. Browser is a Vite React first-party app, not a static HTML patch. The target website is rendered by real Chromium, not fragile iframe/proxy rewriting.

**App Ecosystem / Sandboxing**: PASS. Target sites are untrusted content streamed through Browser and never become privileged Matrix apps. Agent/app access requires Browser Permission Grants.

**Multi-Tenancy**: PASS. v1 is personal-owner scoped; organization policy is explicitly deferred but data model leaves owner/org extension room.

**Defense in Depth**: PASS with required tests. The plan includes auth matrix, body limits, Zod boundary validation, same-origin stream auth, redirect-only platform handoff, SSRF/redirect revalidation, DNS-rebinding protection at runtime, safe errors, capped registries, stale stream eviction, shutdown drains, systemd/Chromium hardening, symlink-safe cleanup, and no raw page/cookie logging.

**TDD**: PASS. Implementation tasks must begin with failing tests for auth, owner isolation, URL validation, profile locking, stream cleanup, download scoping, and safe errors.

**Database Standard**: PASS. New structured metadata uses owner Postgres/Kysely. Browser-managed profile files and completed downloads remain owner filesystem data; no new SQLite/ORM is introduced.

## Project Structure

### Documentation (this feature)

```text
specs/074-vps-browser-runtime/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
packages/mcp-browser/
├── src/
│   ├── browser-tool.ts          # Existing MCP actions; extract shared controls/guards
│   ├── session-manager.ts       # Existing single-session manager; refactor into shared runtime/focus/lock contract
│   ├── security.ts              # Existing URL/profile/path guards; harden for runtime streams
│   ├── runtime-service.ts       # Browser runtime session/tab/download/control service
│   ├── media-service.ts         # WebRTC viewport/audio media plane and bounded fallback frames
│   └── stream-protocol.ts       # Shared signaling/input/focus/status protocol types
└── package.json

packages/gateway/
├── src/
│   ├── browser/
│   │   ├── routes.ts            # REST Browser APIs
│   │   ├── ws.ts                # Browser stream WebSocket
│   │   ├── repository.ts        # Kysely metadata/grants/audit access
│   │   ├── profile-store.ts     # Owner filesystem profile/download staging helpers
│   │   ├── url-policy.ts        # Server-side URL and redirect policy wrapper
│   │   └── service.ts           # Orchestration boundary and safe error mapper
│   ├── auth.ts                  # Browser stream auth allowlist/subprotocol validation
│   ├── handoff-token.ts         # Platform-signed handoff token verification
│   ├── turn-credentials.ts      # Short-lived relay-only TURN credentials
│   └── server.ts                # Register Browser routes and shutdown drains
└── package.json

packages/platform/
└── src/
    ├── main.ts                  # Authenticate /browser/* and redirect to owner VPS Browser route
    └── customer-vps-config.ts   # Browser capability version/env surfaced to VPS

shell/
└── src/
    ├── app/browser/[...target]/page.tsx or route equivalent
    ├── lib/open-app-tab.ts      # Reuse standalone app session flow where applicable
    └── lib/proxy-routes.ts      # Include owner-hosted standalone Browser route/handoff path

home/apps/browser/
├── matrix.json
├── package.json
├── vite.config.ts
└── src/
    ├── App.tsx                  # Canvas/standalone Browser UI
    ├── BrowserViewport.tsx
    ├── BrowserToolbar.tsx
    ├── useBrowserSession.ts
    └── browser-protocol.ts

distro/customer-vps/
├── cloud-init.yaml              # Install Chromium/system deps and enable service
└── systemd/
    └── matrix-browser.service   # VPS-native Browser service, no Docker Compose

scripts/
├── build-default-apps.mjs       # Existing default app build must include Browser
└── build-host-bundle.sh         # Include Browser runtime/app/service artifacts

www/content/docs/
└── ...                          # User/developer Browser docs

tests/
├── browser/
│   ├── url-policy.test.ts
│   ├── session-manager.test.ts
│   ├── focus-lease.test.ts
│   ├── media-plane.test.ts
│   ├── turn-policy.test.ts
│   ├── handoff-token.test.ts
│   ├── password-store.test.ts
│   ├── routes.test.ts
│   ├── ws.test.ts
│   └── downloads.test.ts
├── gateway/
│   └── apps.test.ts             # Default app/icon determinism
└── customer-vps/
    └── browser-capability.test.ts

shell/e2e/
└── browser-app.spec.ts          # Canvas and standalone smoke/screenshot coverage
```

**Structure Decision**: Use existing Matrix package boundaries. Browser control/security primitives stay in `packages/mcp-browser`; owner-scoped APIs, stream auth, WebSocket control, and WebRTC signaling live in `packages/gateway`; platform routing is redirect-only owner VPS handoff; the user-facing surface is a default Vite app under `home/apps/browser`; VPS-native provisioning and service hardening live under `distro/customer-vps`.

## Production Hardening Decisions

- `@matrix-os/mcp-browser` must grow a shared-runtime contract before UI implementation: one live runtime per owner profile, many same-device consumers, one focus lease, one bounded action queue, and explicit second-device takeover.
- WebRTC is the production media plane for viewport and audio output. WebSocket carries auth, protocol negotiation, signaling, input, tab/session status, permission prompts, downloads, and safe errors. WebSocket base64 image frames are allowed only as a bounded diagnostic/fallback path.
- The Browser service is the WebRTC offerer. Clients answer with receive-only audio/video transceivers; relay-only ICE and candidate filtering prevent local/private VPS candidate leakage.
- Platform-managed TURN is the v1 relay path. TURN credentials are short-lived and owner/session-bound; TURN relays encrypted SRTP and does not terminate Browser media.
- `stream.hello` includes `protocolVersion`, `surfaceId`, `deviceId`, viewport, and media capabilities. Incompatible versions fail closed.
- Platform `app.matrix-os.com/browser/...` routes authenticate and redirect to the owner VPS Browser route. They use asymmetric handoff tokens verified by public key/JWKS on the owner VPS and do not proxy Browser APIs, WebSockets, WebRTC, Chromium network traffic, page contents, cookies, or downloads.
- URL preflight returns a navigation policy binding. Runtime request/WebSocket interception and host-resolver pinning or equivalent revalidation enforce that binding before Chromium reads response bytes.
- `matrix-browser.service` runs as non-root with no new privileges, private temp, restricted filesystem writes, explicit owner-profile/download carve-outs, bounded CPU/memory/process/file limits, restart policy, and a shutdown drain.
- Chromium uses deterministic v1 password storage, such as `--password-store=basic`, so `savedPasswords` clearing is reliable on headless VPS hosts.
- Audio output is supported and muted by default. Microphone input remains deferred with camera, geolocation, passkeys/WebAuthn, clipboard write, native file picker, and screen capture.

## Complexity Tracking

No constitution violations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |
