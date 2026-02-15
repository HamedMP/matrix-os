# Tasks: Cloud Deployment + Multi-Tenant Platform

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T130-T136 (single-user), T140-T159 (multi-tenant). T137-T139 reserved.

## User Stories

- **US10** (P1): "The OS runs on a cloud server, always reachable"
- **US21** (P0-hackathon): "Hackathon participants sign up and get their own Matrix OS"

---

## Part A: Single-User Cloud (T130-T136)

- [x] T130 [US10] Create `Dockerfile` -- multi-stage build: install deps with pnpm, build gateway + shell, copy home template. Single `CMD` starts gateway. Exposes port 4000.

- [x] T131 [P] [US10] Create `docker-compose.yml` -- gateway service, volume mount for `~/matrixos/` persistence, environment variables for API keys and channel tokens

- [x] T132 [P] [US10] Create `scripts/matrixos.service` -- systemd unit file for bare-metal/VM

- [x] T133 [US10] Add auth token middleware to gateway in `packages/gateway/src/auth.ts` -- `MATRIX_AUTH_TOKEN` env var, all HTTP/WebSocket require `Authorization: Bearer <token>`, /health exempt. 8 tests.

- [x] T134 [P] [US10] Create `scripts/setup-server.sh` -- installs Node.js 22, pnpm, clones repo, builds

- [x] T135 [P] [US10] Add `GET /api/system/info` endpoint -- OS version, uptime, connected channels, active modules, skills count. 5 tests.

- [ ] T136 [US10] Write deployment docs in `docs/deployment.md`

---

## Part B: Multi-Tenant Platform (T140-T159)

NOTE: Actual implementation diverged from original spec. Auth uses Clerk (not Passkeys/TOTP), provisioning uses Inngest (not direct), landing page is in `www/` (Next.js on Vercel, not in platform). Tasks updated to reflect reality.

### Infrastructure (DONE)

- [x] T140 [US21] Create `packages/platform/` -- Hono service (:9000) for multi-tenant orchestrator. SQLite/Drizzle DB, container management, social API.

- [x] T141 [US21] Auth via Clerk (replaces Passkeys/TOTP) -- Clerk handles signup/login in `www/`, Inngest webhook provisions containers on `clerk/user.created` event. Platform API protected by `PLATFORM_SECRET` bearer token.

- [x] T142 [US21] Session management via Clerk -- Clerk handles JWTs/cookies in `www/`. Platform API uses shared secret (not user sessions).

- [x] T143 [US21] Platform database in `packages/platform/src/db.ts` -- SQLite via Drizzle. Tables: `containers` (handle, clerkUserId, containerId, port, shellPort, status, lastActive), `port_assignments` (port, label).

### Container Orchestrator (DONE)

- [x] T144 [US21] Container orchestrator in `packages/platform/src/orchestrator.ts` -- dockerode, provision/start/stop/destroy. Each container: unique gateway+shell ports, volume at `/data/users/{handle}/matrixos/`, resource limits (256MB, 0.5 CPU), `matrixos-net` network.

- [x] T145 [US21] Lifecycle manager in `packages/platform/src/lifecycle.ts` -- check every 5min, stop containers idle >30min. Wired into gateway startup.

- [x] T146 [P] [US21] `distro/docker-compose.platform.yml` -- platform service, Cloudflare Tunnel (replaces Caddy), shared network.

- [ ] T147 [US21] Subdomain routing -- Cloudflare Tunnel + platform `/proxy/:handle/*` endpoint handles `{handle}.matrix-os.com` traffic. Needs cloudflared config for host-header-to-path rewriting.

### Landing Page + Auth UI (DONE via www/)

- [x] T148 [US21] Landing page at `www/` (Next.js on Vercel) -- hero, features, agent showcase, whitepaper link.

- [x] T149 [US21] Signup via Clerk components in `www/` -- handle = Clerk username, Inngest `provisionUser` function auto-provisions container on signup.

- [x] T150 [US21] Login via Clerk in `www/` -- dashboard shows instance status, manual provision fallback button.

### Inngest Provisioning (DONE)

- [x] T149a [US21] Inngest function `provision-matrix-os` -- triggered by `clerk/user.created`, provisions container via platform API, verifies health, PostHog tracking.

- [x] T149b [US21] Dashboard server action `provisionInstance()` -- manual fallback for failed auto-provision, same endpoint with auth.

### API Key + Quota

- [x] T151 [US21] API proxy in `packages/proxy/` -- Hono :8080, intercepts Anthropic API calls, tracks usage per handle, enforces limits.

- [ ] T152 [P] [US21] Cost dashboard endpoint -- usage stats injected into system prompt as "Budget: $X.XX remaining".

### Social + Discovery (DONE)

- [x] T153 [US21] Social API in `packages/platform/src/social.ts`:
  - `GET /social/users` -- list users
  - `GET /social/profiles/{handle}` -- public profile
  - `GET /social/profiles/{handle}/ai` -- AI profile
  - `POST /social/send/{handle}` -- cross-instance messaging

- [ ] T154 [P] [US21] User discovery in web shell -- "Community" panel.

### Matrix Homeserver

- [ ] T155 [US21] Deploy Conduit on `matrixos-net` -- auto-register `@handle:matrix-os.com`.

- [ ] T156 [US21] Wire `matrix-js-sdk` into each container for AI-to-AI communication.

### Admin + Monitoring (DONE)

- [x] T157 [P] [US21] Admin dashboard in `www/src/app/admin/` -- user list, container status, actions.

- [x] T158 [P] [US21] Platform health endpoint -- `GET /health` returns status.

### Deployment

- [ ] T159 [US21] Production deployment script -- VPS provisioning, Docker, Cloudflare Tunnel, wildcard DNS.

### Security Hardening (added post-review)

- [x] T160 Platform API auth middleware -- `PLATFORM_SECRET` bearer token on all routes (except /health). Fail-open when unconfigured (dev mode).

- [x] T161 Inngest 409 idempotency -- treat "container already exists" as success on retry.

- [x] T162 Lifecycle manager wired into startup -- was imported but never started.

- [x] T163 PostHog flush in serverless -- call `shutdownPostHog()` before function exit.

- [x] T164 Verify-running health check -- actually hits container gateway `/health` instead of just reading DB status.

---

## Checkpoint (Single User)

`docker compose up` on a cloud VM. Web shell at `https://my-matrix-os.example.com`. Telegram bot responds. Data persists.

## Checkpoint (Multi-Tenant)

Visit `matrix-os.com`. Sign up as `@hamed`. Register passkey. Container spins up. Redirected to `hamed.matrix-os.com` -- full Matrix OS desktop. Build an app. Send a message from Telegram. Visit `alice.matrix-os.com` (another user). `@hamed_ai` messages `@alice_ai` via Matrix. Activity shows on global feed.
