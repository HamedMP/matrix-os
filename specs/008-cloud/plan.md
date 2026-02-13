# Plan: Cloud Deployment + Multi-Tenant Platform

**Spec**: spec.md
**Depends on**: Phase 3 (complete), 005-soul-skills, 006-channels, 007-proactive

## Part A: Single-User Cloud

Simple. 7 tasks (T130-T136), mostly parallelizable. Dockerfile, docker-compose, systemd, auth middleware, setup script.

## Part B: Multi-Tenant Platform

### Phase B1: Core Infrastructure (T140-T147)

**Goal**: Users can sign up, get a container, access their instance via subdomain.

1. Platform service (Hono) with SQLite user DB
2. Auth: Passkeys + TOTP 2FA
3. Container orchestrator (dockerode)
4. Caddy wildcard reverse proxy
5. Idle detection + sleep/wake

### Phase B2: Landing + Auth UI (T148-T150)

**Goal**: Polished signup/login flow.

1. Landing page (hero, demo video, features)
2. Signup (handle picker, passkey registration)
3. Login (passkey challenge, redirect to instance)

### Phase B3: Quota + Social (T151-T154)

**Goal**: Cost management and user discovery.

1. API proxy with per-user quota tracking
2. Cost dashboard
3. Social API (user list, profiles, feed)
4. Community panel in web shell

### Phase B4: Matrix Integration (T155-T156)

**Goal**: AI-to-AI communication via Matrix protocol.

1. Deploy Conduit Matrix homeserver
2. Wire matrix-js-sdk into each container

### Phase B5: Admin + Deploy (T157-T159)

**Goal**: Monitoring and one-click deployment.

1. Admin dashboard
2. Health endpoint
3. Deployment script

## Critical Path for Hackathon

```
T130 (Dockerfile) --> T140 (platform) --> T141 (auth) --> T144 (orchestrator)
  --> T147 (Caddy) --> T148 (landing) --> T149 (signup) --> Deploy
```

B1 and B2 are sequential (infra before UI). B3, B4, B5 can run in parallel after B2.

## Tech Stack for Platform Service

- **Framework**: Hono (same as gateway -- consistent codebase)
- **Auth**: `@simplewebauthn/server` + `otpauth`
- **Docker**: `dockerode` (Node.js Docker Engine API client)
- **Database**: SQLite via Drizzle (same as kernel)
- **Proxy**: Caddy (automatic HTTPS, wildcard certs, on-demand TLS)
- **Matrix**: Conduit (Rust, lightweight) + `matrix-js-sdk` (TypeScript client)
- **Landing page**: Static HTML or minimal React (keep it fast)

## Files to Create

```
platform/
  package.json
  src/
    index.ts          # Hono server
    auth.ts           # WebAuthn + TOTP
    session.ts        # JWT + refresh tokens
    db.ts             # Drizzle + SQLite
    schema.ts         # users, containers, usage tables
    orchestrator.ts   # Docker container management
    lifecycle.ts      # Idle detection, sleep/wake
    proxy.ts          # API key proxy + quota
    social.ts         # User discovery, profiles, feed
    pages/
      index.html      # Landing page
      signup.html     # Signup flow
      login.html      # Login flow
      admin.html      # Admin dashboard
  Caddyfile           # Wildcard TLS + reverse proxy
  docker-compose.yml  # Full platform stack
```
