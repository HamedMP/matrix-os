# Quickstart: VPS Browser Runtime

## Prerequisites

- Node.js 24+, pnpm 10.33.4, bun
- Matrix OS dependencies installed from repo root:

```bash
pnpm install
```

- Local development Browser capability requires Chromium/Playwright browser availability. For local dev only:

```bash
pnpm --filter @matrix-os/mcp-browser exec playwright install chromium
```

Production customer VPSes must get Chromium through the VPS-native provisioning/host-bundle path, not Docker Compose rollout.

## Build The Default Browser App

The Browser app is a first-party Vite app under `home/apps/browser`.

```bash
node scripts/build-default-apps.mjs home/apps
```

Expected result:
- `home/apps/browser/dist/index.html` exists.
- `home/apps/browser/matrix.json` uses `runtime: "vite"` and a shipped icon in `home/system/icons/`.

## Run Local Development

```bash
bun run dev
```

Open Matrix shell locally, switch to Canvas, and launch Browser from the app list or direct app path.

Standalone route to check:

```text
/browser/google.com
```

Expected behavior:
- Unauthenticated users are routed through Matrix auth.
- Authenticated users see the Browser app without Canvas chrome.
- The target website renders through the Browser runtime, not through a direct target-site iframe.
- On platform hosts, `/browser/...` performs only an authenticated redirect to the owner VPS Browser route. Browser APIs, WebSockets, WebRTC media, page contents, cookies, and downloads do not proxy through the platform.

## Focused Test Gates

Write failing tests first, then implement.

Core Browser unit/contract tests:

```bash
bun run test -- tests/browser/url-policy.test.ts
bun run test -- tests/browser/session-manager.test.ts
bun run test -- tests/browser/focus-lease.test.ts
bun run test -- tests/browser/media-plane.test.ts
bun run test -- tests/browser/turn-policy.test.ts
bun run test -- tests/browser/handoff-token.test.ts
bun run test -- tests/browser/password-store.test.ts
bun run test -- tests/browser/routes.test.ts
bun run test -- tests/browser/ws.test.ts
bun run test -- tests/browser/downloads.test.ts
```

Default app/icon coverage:

```bash
bun run test -- tests/gateway/apps.test.ts
```

Pattern review:

```bash
bun run check:patterns
```

Typecheck:

```bash
bun run typecheck
```

## Manual Smoke

1. Open Browser in Canvas.
2. Navigate to `https://example.com`.
3. Open the standalone route for the same profile.
4. Confirm both surfaces attach to the same session on the same device.
5. Click each surface and confirm `surface.focused` changes and only the focused surface can type/click.
6. Confirm viewport media uses WebRTC, audio output is muted by default, and unmuting allows site audio without microphone access.
7. Confirm WebRTC signaling uses server-offer/client-answer, `iceTransportPolicy: "relay"`, and no local/private/loopback candidates are visible in Browser client logs.
8. Start a download and confirm it appears in Matrix Files only after completion.
9. Try blocked destinations:

```text
http://127.0.0.1:4000
http://10.0.0.1
http://[::1]/
```

Expected result:
- Each blocked target returns a generic blocked destination message.
- Hostname preflight and runtime navigation disagree/rebind attempts are blocked before response bytes are read.
- No DNS details, internal path, provider/runtime error, or upstream status is visible to the client.
- Browser handoff tokens from platform routes verify with platform public key/JWKS material on the owner VPS; expired, replayed, wrong-owner, unsigned, or shared-secret tokens are rejected.

## Customer VPS Rollout Check

For production-facing Browser changes, use the customer VPS host-bundle path:

```bash
set -a
source .env
set +a
./scripts/build-host-bundle.sh
sha256sum dist/host-bundle/matrix-host-bundle.tar.gz
```

Publish:

```text
system-bundles/$CUSTOMER_VPS_IMAGE_VERSION/matrix-host-bundle.tar.gz
system-bundles/$CUSTOMER_VPS_IMAGE_VERSION/matrix-host-bundle.tar.gz.sha256
```

Refresh an existing VPS in place and restart host services:

```bash
sudo systemctl restart matrix-browser.service matrix-gateway.service matrix-shell.service
```

Health checks:

```bash
curl -fsS http://localhost:9000/health
systemctl status matrix-browser.service matrix-gateway.service matrix-shell.service --no-pager
```

Service hardening checks:

```bash
systemctl cat matrix-browser.service
systemctl show matrix-browser.service -p User -p NoNewPrivileges -p PrivateTmp -p ProtectSystem -p MemoryMax -p TasksMax
```

Expected result:
- `matrix-browser.service` runs as a non-root user.
- No new privileges and private temp are enabled.
- Filesystem writes are restricted to explicit owner profile/download/runtime paths.
- CPU, memory, process, and file limits are configured.
- Chromium does not use `--no-sandbox` in production mode.
- Chromium uses deterministic v1 password storage, for example `--password-store=basic`, so `savedPasswords` clearing works on headless VPS hosts.

## Review Checklist

- Browser profile data stays on owner VPS storage.
- Platform routes never store cookies, site storage, screenshots, page HTML, or downloads.
- Platform `/browser/*` routes are redirect-only handoffs to the owner VPS, not Browser proxies.
- Platform handoff tokens are asymmetric: platform private key signs, owner VPS public key/JWKS verifies; no shared HMAC for Browser handoff.
- Every mutating route has `bodyLimit`.
- Every boundary input is Zod-validated.
- Every external/preflight `fetch()` has `AbortSignal.timeout()`.
- URL validation covers IPv4, IPv6, DNS resolution, runtime DNS-rebinding protection, redirects, WebSockets, private/internal ranges, and Matrix control-plane destinations.
- WebSocket auth is same-origin and token-bound; no wildcard CORS.
- WebRTC is the primary viewport/audio media plane; WebSocket frame streaming is fallback/diagnostic only.
- WebRTC uses platform-managed TURN with short-lived owner/session-bound credentials and relay-only ICE candidate filtering.
- Stream protocol versioning, focus lease behavior, takeover notifications, and stale-focus rejection are verified.
- Agent `automate_input` requires an active grant and runs through the serialized action queue without taking the UI focus lease.
- `session.taken_over` appears in audit events; audit retention defaults to 180 days unless the owner chooses shorter retention.
- Runtime registries and queues have caps, stale eviction, and shutdown drains.
- systemd and Chromium hardening are verified before production rollout.
- Temp files, partial downloads, screenshots, and crash artifacts have symlink-safe recurring cleanup.
- Safe errors are verified for blocked URL, redirect, missing capability, profile lock, limit reached, and runtime failure.
