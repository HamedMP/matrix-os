# 008: Cloud Deployment + Multi-Tenant Platform

## Part A: Single-User Cloud (Original)

### Problem

Matrix OS runs locally. To be "always on, always reachable" it needs to run on a cloud server.

### Solution

Single Docker container running gateway + shell. Channels connect outbound.

### Architecture (Single User)

```
Cloud VM
  +-- Docker Container
       +-- Gateway (Hono, port 4000)
       |    +-- Web Shell, Channel Adapters, Cron, Heartbeat
       +-- Volume: ~/matrixos/ (persistent data)
```

---

## Part B: Multi-Tenant Hackathon Platform (NEW)

### Problem

For the hackathon demo, we want participants (and up to 1000 people) to sign up on matrix-os.com, get their own Matrix OS instance, and start using it immediately. They should be able to build apps, connect channels, interact with each other's AIs, and experience the full Web 4 vision.

### Solution

A multi-tenant platform on a single VPS where each user gets an isolated Docker container managed by an orchestrator.

### Architecture (Multi-Tenant)

```
matrix-os.com (Hetzner AX52 or similar, 128GB RAM)
  |
  +-- Caddy (reverse proxy, wildcard TLS)
  |    |-- matrix-os.com           -> Landing page / auth service
  |    |-- hamed.matrix-os.com     -> User's container (port dynamically assigned)
  |    |-- alice.matrix-os.com     -> User's container
  |    |-- api.matrix-os.com       -> Platform API (orchestrator)
  |
  +-- Platform Service (Node.js / Hono)
  |    |-- Landing page (signup / login)
  |    |-- Auth service (Passkeys/WebAuthn + TOTP 2FA)
  |    |-- Container orchestrator (Docker Engine API)
  |    |-- User database (SQLite or Postgres)
  |    |-- Cost/quota management
  |    |-- Admin dashboard
  |
  +-- Docker Network: matrixos-net
  |    |
  |    +-- Container: hamed (Matrix OS instance)
  |    |    +-- Gateway :4001 -> hamed.matrix-os.com
  |    |    +-- Volume: /data/users/hamed/matrixos/
  |    |    +-- Env: ANTHROPIC_API_KEY, MATRIX_HANDLE=hamed
  |    |
  |    +-- Container: alice (Matrix OS instance)
  |    |    +-- Gateway :4002 -> alice.matrix-os.com
  |    |    +-- Volume: /data/users/alice/matrixos/
  |    |
  |    +-- Container: conduit (Matrix homeserver, shared)
  |    |    +-- Federated identity: @user:matrix-os.com
  |    |    +-- AI-to-AI rooms on the internal network
  |    |
  |    +-- ... up to 1000 users
  |
  +-- /data/users/        (persistent volumes per user)
  +-- /data/platform/     (platform DB, auth, config)
```

### User Journey

1. **Visit matrix-os.com** -- see landing page with demo video, signup button
2. **Sign up** -- choose handle (`@hamed`), register passkey (WebAuthn) or set up TOTP 2FA
3. **Container spins up** -- orchestrator creates Docker container, assigns `hamed.matrix-os.com`
4. **Redirect to instance** -- user lands on their Matrix OS web shell at `hamed.matrix-os.com`
5. **First boot** -- home directory created, SOUL loaded, kernel says hello with their handle
6. **Use it** -- build apps, chat with the OS, configure channels
7. **Connect channels** -- add Telegram/Discord/Slack tokens in config.json
8. **Social** -- `@hamed_ai:matrix-os.com` can message `@alice_ai:matrix-os.com` via Matrix protocol on the Docker network
9. **Idle** -- after 30min of no activity, container sleeps (stopped, not removed)
10. **Return** -- login again, container wakes up instantly, all state preserved

### Authentication

**Primary: Passkeys (WebAuthn)**
- Passwordless, phishing-resistant
- Biometric (fingerprint, Face ID) or security key
- Supported by all modern browsers and phones
- Registration: `navigator.credentials.create()` -> store public key server-side
- Login: `navigator.credentials.get()` -> verify signature server-side
- Library: `@simplewebauthn/server` + `@simplewebauthn/browser`

**Fallback: TOTP 2FA**
- For devices that don't support WebAuthn
- Standard TOTP (Google Authenticator, Authy, etc.)
- QR code on signup, 6-digit code on login
- Library: `otpauth` or `speakeasy`

**Session management:**
- JWT tokens (short-lived, 1h) + refresh tokens (7 days)
- HttpOnly secure cookies
- Token includes: handle, container ID, expiry
- Caddy validates token before proxying to container

### Container Orchestration

**Lifecycle:**
- `create`: Pull Matrix OS image, create container with unique port + volume, register in platform DB
- `start`: Start container on login (if sleeping)
- `stop`: Stop container after 30min idle (data persists in volume)
- `destroy`: Remove container + volume on account deletion (with confirmation + grace period)

**Resource limits per container:**
- CPU: 0.5 cores (burst to 2)
- Memory: 256MB (burst to 512MB)
- Disk: 1GB per user (expandable)
- Network: rate limited to prevent abuse

**Capacity planning (1000 users):**
- Assume 10% concurrent (100 active containers)
- 100 containers x 256MB = 25GB RAM
- VPS: Hetzner AX52 (128GB RAM, 12 cores, 2TB NVMe) -- ~$80/mo
- Leaves plenty of headroom for platform service, Caddy, Matrix homeserver

**Implementation:**
- Use `dockerode` (Node.js Docker client) for Docker Engine API
- Or shell out to `docker` CLI for simplicity
- Health check loop: ping each running container, stop unresponsive ones
- Auto-cleanup: remove containers inactive for 30 days

### API Key Management

Users don't bring their own API key (friction-free signup). The platform provides:

**Shared API key with quota:**
- Single `ANTHROPIC_API_KEY` injected into all containers via env var
- Platform proxy tracks usage per user
- Free tier: $5 of AI usage (enough for ~10 complex builds or ~100 simple queries)
- Rate limit: max 5 concurrent kernel invocations per user
- When quota exhausted: user can add their own API key, or request more

**Cost tracking:**
- Platform proxy intercepts API calls, logs tokens + cost per user
- Dashboard: "You've used $2.30 of $5.00 free credits"
- Alerts at 80% and 100% of quota

### Inter-Container Communication

All containers are on the same Docker network (`matrixos-net`):

**Docker DNS:**
- Each container is reachable by name: `hamed.matrixos-net`, `alice.matrixos-net`
- Direct HTTP between containers for AI-to-AI messages

**Shared Matrix homeserver (Conduit):**
- Lightweight Matrix homeserver on the same network
- All users get Matrix IDs: `@hamed:matrix-os.com`, `@hamed_ai:matrix-os.com`
- AI-to-AI rooms created on demand
- End-to-end encryption between instances

**Social feed:**
- Platform service aggregates activity from all containers
- `GET api.matrix-os.com/feed` -- global activity feed
- `GET api.matrix-os.com/users` -- discover other users
- `GET api.matrix-os.com/users/hamed/profile` -- view someone's public profile

### URL Scheme

**Subdomain-based (recommended):**
- `matrix-os.com` -- landing page, signup, login
- `hamed.matrix-os.com` -- user's Matrix OS instance
- `api.matrix-os.com` -- platform API
- Requires: wildcard DNS (`*.matrix-os.com -> VPS IP`) + wildcard TLS (Caddy handles this)

**Direct access:**
- Users can also access `hamed.matrix-os.com` directly
- Login redirects to their subdomain
- Mobile: bookmark `hamed.matrix-os.com` to home screen (PWA)

### Landing Page

Simple, compelling:
- Hero: "Matrix OS -- Your AI-Powered Operating System"
- Demo video (30s loop)
- "Get Started" button -> signup flow
- Features grid: build apps, multi-channel, AI personality, multiplayer games
- "Live now: 847 instances running" counter
- Footer: GitHub link, docs, Matrix protocol badge

### Security Considerations

- **Container isolation**: each user is in their own container, can't access others' files
- **Network isolation**: containers can only reach each other via Matrix protocol (not raw HTTP to other containers' gateways)
- **API key protection**: key injected via env var, not accessible to the shell/kernel
- **Rate limiting**: per-user rate limits on API, container creation, AI invocations
- **Abuse prevention**: allowlist for shell commands (no crypto mining, no outbound spam)
- **Data deletion**: users can request full data export + deletion

## Dependencies

- Phase 3 (Kernel) -- complete
- 005-soul-skills (SOUL for first-boot personality)
- 006-channels (channel adapters)
- 007-proactive (cron + heartbeat)
- Domain: matrix-os.com (owned)
- VPS: Hetzner AX52 or similar
