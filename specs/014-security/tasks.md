# Tasks: Security -- User Instance Auth + Access Control

**Task range**: T600-T619

## User Stories

- **US30**: "Only I can access my Matrix OS instance"
- **US31**: "My AI assistant is not accessible to unauthorized users"

---

## Auth for User Instances (T600-T609)

### T600 [US30] Clerk JWT verification on subdomain proxy
- [ ] Platform subdomain middleware verifies Clerk session token (cookie or header)
- [ ] Only the instance owner (matching clerkUserId) can access their subdomain
- [ ] Unauthenticated requests get redirected to matrix-os.com/login
- [ ] /health endpoint remains public (for monitoring)
- **Output**: Subdomain access gated by Clerk auth

### T601 [US30] Session token passthrough from dashboard to instance
- [ ] Dashboard "Open Matrix OS" link includes auth context (Clerk session cookie)
- [ ] Cross-domain cookie strategy (matrix-os.com -> hamedmp.matrix-os.com)
- [ ] Alternative: short-lived signed URL or token exchange
- **Output**: Seamless login from dashboard to instance

### T602 [US30] WebSocket auth
- [ ] WS upgrade requests carry auth token (cookie or query param)
- [ ] Platform WS proxy verifies token before proxying
- [ ] Invalid/expired tokens get disconnected
- **Output**: Authenticated WebSocket connections only

### T603 [US31] Container network isolation
- [ ] User containers cannot reach each other directly
- [ ] Cross-instance messaging goes through platform social API only
- [ ] Container-to-internet access scoped (proxy only for API calls)
- **Output**: Network-level isolation between user instances

### T604 [P] Rate limiting on subdomain proxy
- [ ] Per-handle request rate limits (HTTP + WS messages)
- [ ] Abuse detection (excessive API calls, large payloads)
- **Output**: Protection against abuse

### T605 [P] CORS and security headers
- [ ] Strict CORS on subdomain proxy
- [ ] CSP, X-Frame-Options, HSTS headers
- **Output**: Browser security hardening

---

## API Security (T610-T619)

### T610 [P] Platform admin API audit
- [ ] Review all admin endpoints for auth bypass
- [ ] Add request logging for audit trail
- **Output**: Hardened admin API

### T611 [P] Secrets management
- [ ] PLATFORM_SECRET rotation without downtime
- [ ] Per-container auth tokens (not shared)
- **Output**: Better secrets hygiene
