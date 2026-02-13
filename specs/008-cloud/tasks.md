# Tasks: Cloud Deployment + Multi-Tenant Platform

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T130-T136 (single-user), T140-T159 (multi-tenant). T137-T139 reserved.

## User Stories

- **US10** (P1): "The OS runs on a cloud server, always reachable"
- **US21** (P0-hackathon): "Hackathon participants sign up and get their own Matrix OS"

---

## Part A: Single-User Cloud (T130-T136)

- [ ] T130 [US10] Create `Dockerfile` -- multi-stage build: install deps with pnpm, build gateway + shell, copy home template. Single `CMD` starts gateway. Exposes port 4000.

- [ ] T131 [P] [US10] Create `docker-compose.yml` -- gateway service, volume mount for `~/matrixos/` persistence, environment variables for API keys and channel tokens

- [ ] T132 [P] [US10] Create `scripts/matrixos.service` -- systemd unit file for bare-metal/VM

- [ ] T133 [US10] Add auth token middleware to gateway in `packages/gateway/src/server.ts` -- `MATRIX_AUTH_TOKEN` env var, all HTTP/WebSocket require `Authorization: Bearer <token>`, channels exempt

- [ ] T134 [P] [US10] Create `scripts/setup-server.sh` -- installs Node.js 22, pnpm, clones repo, builds

- [ ] T135 [P] [US10] Add `GET /api/system/info` endpoint -- OS version, uptime, connected channels, active modules, disk usage

- [ ] T136 [US10] Write deployment docs in `docs/deployment.md`

---

## Part B: Multi-Tenant Platform (T140-T159)

### Infrastructure

- [ ] T140 [US21] Create `platform/` directory -- separate Node.js/Hono service for the multi-tenant orchestrator. Handles signup, login, container management, social API.

- [ ] T141 [US21] Implement auth service in `platform/src/auth.ts` -- Passkeys (WebAuthn) via `@simplewebauthn/server` + TOTP 2FA fallback via `otpauth`. Registration flow: choose handle -> register passkey/TOTP -> create account. Login flow: passkey challenge -> verify -> JWT.

- [ ] T142 [US21] Implement session management in `platform/src/session.ts` -- JWT (1h) + refresh tokens (7d), HttpOnly secure cookies, token includes handle + container ID.

- [ ] T143 [US21] Implement user database in `platform/src/db.ts` -- SQLite via Drizzle. Tables: `users` (handle, publicKey, totpSecret, createdAt), `containers` (handle, containerId, port, status, lastActive), `usage` (handle, tokensIn, tokensOut, costUsd).

### Container Orchestrator

- [ ] T144 [US21] Implement container orchestrator in `platform/src/orchestrator.ts` -- uses `dockerode` to create/start/stop/destroy containers. Each container gets: unique port, volume at `/data/users/{handle}/matrixos/`, env vars (API key, handle), resource limits (256MB, 0.5 CPU). Containers join `matrixos-net` Docker network.

- [ ] T145 [US21] Implement idle detection + sleep in `platform/src/lifecycle.ts` -- check last activity per container every 5min. Stop containers idle >30min. Wake on next login. Health check loop.

- [ ] T146 [P] [US21] Create `platform/docker-compose.yml` -- Caddy (wildcard TLS), platform service, Conduit Matrix homeserver, shared network `matrixos-net`. Defines the full multi-tenant stack.

- [ ] T147 [US21] Implement Caddy dynamic routing -- Caddyfile with `*.matrix-os.com` wildcard, on-demand TLS, reverse proxy to platform service which looks up container port by subdomain.

### Landing Page + Auth UI

- [ ] T148 [US21] Create landing page at `platform/src/pages/index.tsx` (or static HTML) -- hero section, demo video, "Get Started" button, features grid, live instance counter.

- [ ] T149 [US21] Create signup page at `platform/src/pages/signup.tsx` -- handle picker (availability check), passkey registration, TOTP QR code alternative. On success: create container, redirect to `{handle}.matrix-os.com`.

- [ ] T150 [US21] Create login page at `platform/src/pages/login.tsx` -- handle input, passkey challenge, TOTP fallback. On success: ensure container is running, redirect to subdomain.

### API Key + Quota

- [ ] T151 [US21] Implement API proxy in `platform/src/proxy.ts` -- intercepts Anthropic API calls from containers, tracks tokens + cost per user, enforces quota ($5 free tier), rate limits (5 concurrent invocations).

- [ ] T152 [P] [US21] Implement cost dashboard endpoint -- `GET api.matrix-os.com/usage/{handle}` returns usage stats. Injected into each user's Matrix OS system prompt as "Budget: $X.XX remaining".

### Social + Discovery

- [ ] T153 [US21] Implement social API in `platform/src/social.ts`:
  - `GET /api/users` -- list users (handle, displayName, avatar, online status)
  - `GET /api/users/{handle}/profile` -- public profile (from user's `~/system/profile.md`)
  - `GET /api/users/{handle}/ai-profile` -- AI profile (from `~/system/ai-profile.md`)
  - `GET /api/feed` -- global activity feed (aggregated from all containers)

- [ ] T154 [P] [US21] Implement user discovery in web shell -- show "Community" panel with online users, their AI profiles, ability to message their AI.

### Matrix Homeserver

- [ ] T155 [US21] Deploy Conduit (lightweight Matrix homeserver) on `matrixos-net` -- auto-register users (`@handle:matrix-os.com`, `@handle_ai:matrix-os.com`) on signup. Configure for internal federation only (not public internet).

- [ ] T156 [US21] Wire Matrix client into each Matrix OS container -- `matrix-js-sdk` in gateway, auto-login on boot, send/receive messages via Matrix rooms for AI-to-AI communication.

### Admin + Monitoring

- [ ] T157 [P] [US21] Implement admin dashboard at `platform/src/pages/admin.tsx` -- total users, active containers, resource usage, cost per user, ability to stop/restart containers.

- [ ] T158 [P] [US21] Implement platform health endpoint -- `GET api.matrix-os.com/health` returns: total containers, active containers, RAM usage, disk usage, Matrix homeserver status.

### Deployment

- [ ] T159 [US21] Create `scripts/deploy-platform.sh` -- provisions Hetzner VPS, installs Docker, configures Caddy, sets up wildcard DNS, deploys platform + Conduit, creates admin account.

---

## Checkpoint (Single User)

`docker compose up` on a cloud VM. Web shell at `https://my-matrix-os.example.com`. Telegram bot responds. Data persists.

## Checkpoint (Multi-Tenant)

Visit `matrix-os.com`. Sign up as `@hamed`. Register passkey. Container spins up. Redirected to `hamed.matrix-os.com` -- full Matrix OS desktop. Build an app. Send a message from Telegram. Visit `alice.matrix-os.com` (another user). `@hamed_ai` messages `@alice_ai` via Matrix. Activity shows on global feed.
