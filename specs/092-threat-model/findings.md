# Matrix OS — Findings & Fixes

Companion to [`threat-model.md`](./threat-model.md) and the scored
[`risk-register.md`](./risk-register.md). Each finding: where it is, who exploits
it, the attack in one breath, the fix, and a **re-verification verdict** against
`main` @ `205a8bb0b`.

**Status:** `PERSISTENT` (path re-traced this pass, still open) · `CHANGED`
(behavior shifted since v1) · `FIXED` · `MOVED` · `NEW` (found this pass).
Severity reflects blast radius on the real architecture: a **platform** bug hits
everyone; a **VPS** bug hits one owner unless it reaches shared R2.

> **The one that flipped:** F3 was reported "fixed" by one explorer this pass. It
> is not. The relay pins the message *envelope's* `app` to the iframe slug, but the
> gateway makes its data-access decision from `body.app` inside `init.body`, which
> the relay forwards verbatim. Envelope check, wrong field. Traced by hand below.

---

## 🟠 HIGH — fix first

### F3 — App bridge: any app reads/writes every other app's data
- **Status:** `PERSISTENT` (re-traced end-to-end this pass) · **Risk:** HIGH (L2×B2, top priority)
- **Where:** gateway `server.ts:3162` + `ensureAppProvisioned` `:703`; relay `shell/src/components/AppViewer.tsx:48-73` (forward) + `:177-186` (envelope check); URL policy `app-viewer-bridge-policy.ts:8-11`; bridge `os-bridge.ts:140-164,275-349`
- **Who:** a malicious / supply-chain-compromised installed app
- **Attack:** the app does not have to use `window.MatrixOS.db.*` (which honestly
  bakes its own slug into `body.app` at `os-bridge.ts:277`). It runs arbitrary JS
  and posts a raw envelope:
  ```js
  const ch = new MessageChannel();
  window.parent.postMessage({
    type: "os:bridge-fetch",
    app: "<my-own-slug>",                       // envelope app = self → passes the check
    payload: { url: "/api/bridge/query", init: { method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ app:"victim-app", action:"find", table:"notes", filter:{} })
    }}
  }, "*", [ch.port2]);
  ```
  Relay (`AppViewer.tsx:177-186`) checks `data.app === appName` — true, attacker set
  it to its own slug. `isAllowedBridgeFetchUrl(appName, "/api/bridge/query")` — true,
  it starts `/api/bridge/`. `handleBridgeFetch` then does
  `fetch(url, { body: requestInit.body })` (`:61`), forwarding `init.body`
  **verbatim**. Gateway reads `const rawSlug = body.app` = `"victim-app"`
  (`server.ts:3162`); `ensureAppProvisioned` only confirms the schema exists
  (`:703`), never that the caller owns it. Victim app's rows come back.
- **Why HIGH not CRITICAL:** one VPS = one user, so this is cross-*app* within the
  owner's own box, not cross-user. Still the top gateway risk: with a store, installing
  apps is normal usage, and this reads/writes/deletes notes, journal, finance — every app.
- **Why the "fixed" read was wrong:** the envelope pin (`data.app === appName`) and the
  new URL allowlist are both real controls, but they guard the envelope `app` and the
  URL — not the `body.app` field that actually selects the schema. The two are
  independent fields; pinning one does nothing to the other.
- **Fix:** at the relay, after the URL passes the allowlist, parse `init.body` and
  **overwrite `body.app` with the iframe's real slug** before forwarding (or refuse
  bodies whose `app` ≠ slug). At the gateway, validate the resolved app belongs to the
  authenticated owner. Longer term: a manifest-declared permission model
  (`storage.tables` an app may touch) enforced at query time.

### F4 — Shared full-bucket R2 credentials on every VPS
- **Status:** `PERSISTENT` · **Risk:** HIGH (L2×B3 = 6)
- **Where:** `customer-vps-config.ts:51-52`; distribution `customer-vps-cloud-init.ts`; presign scoping `internal-sync-routes.ts` (`keyAllowedForUser`)
- **Who:** a single compromised VPS
- **Attack:** every customer box gets the identical R2 access key + secret, full-bucket
  scope. Platform presign is prefix-scoped (good — protects the normal path), but the
  standing credential on a popped box reads/writes `matrixos-sync/<any-user>/...`
  directly. One compromise → all users' synced files. Highest blast radius of any live
  finding.
- **Fix:** per-user scoped credentials, or remove the standing key and route all object
  access through platform presign (the VPS already calls the platform anyway).

### F5 — Kernel runs all sources under `bypassPermissions`, no per-source gating
- **Status:** `PERSISTENT` · **Risk:** HIGH (L3×B2 = 6)
- **Where:** `options.ts:131`; dispatch `dispatcher.ts:180-207`; scan-only `security/external-content.ts:104-120`
- **Who:** anyone who can put text in front of the kernel (channel message, social, web fetch)
- **Attack:** owner chat and a stranger's Telegram message get the same full toolset
  (`allowedTools` static at `options.ts:135-149`, no `disallowedTools`, no per-source
  override). External content is wrapped + scanned, but the scan only logs
  (`dispatcher.ts:181-190`) and the message still runs. Injected instructions reach
  `call_service` (email/Slack/Discord as owner), `manage_cron` (persistence),
  `generate_image`/`speak` (spend), `fork_app`. Per-VPS, but owner-impersonated email +
  a persistent cron job from one message is cheap.
- **Fix:** per-source `allowedTools` — untrusted channels get a safe read-only subset;
  dangerous tools require owner origin or go through the approval hook
  (`createApprovalHook` in `hooks.ts` exists, unwired). Make the injection scan a
  blocking `PreToolUse` decision, not a log line.

### F7 — Secrets written world-readable, and `.env*` not excluded from sync
- **Status:** `PERSISTENT` · **Risk:** HIGH (L2×B2 = 4)
- **Where:** `postgres-manager.ts:69` (`writeFileSync`, no mode → `0644`); `packages/sync-client/src/lib/syncignore.ts:5-21`
- **Who:** any local-read foothold; the sync path turns it into exfil
- **Attack:** `credentials.json` (app DB password) lands `0644`, readable by any
  process/user on the box. Separately, the sync default ignore list omits `.env*` and
  `credentials.json`, so a secret file under `$MATRIX_HOME` rides sync up to R2 — where,
  via F4, any popped box can read it.
- **Fix:** write credential files `0600`; add `.env`, `.env.*`, `credentials.json`,
  `*.pem`, `*.key` to `DEFAULT_PATTERNS`. Both one-liners.

---

## 🟡 MEDIUM

### F1 — Platform social API trusts the body (no longer internet-facing)
- **Status:** `CHANGED` ↓ (was CRITICAL) · **Risk:** MED (L1×B3 = 3)
- **Where:** handlers `social-api.ts:75-115`; mount `main.ts:3744`; gate `main.ts:3374-3386`
- **What changed:** `/api/social` is now mounted *after* the global bearer-auth
  middleware (`main.ts:3374`), so the unauthenticated "impersonate anyone from the
  internet" attack is closed. The handlers still read `authorId` from the body and
  `userId`/`x-user-id` for like/follow/delete (`social-api.ts:108-114`), so any holder
  of the platform admin secret can still spoof, and correctness depends on mount order
  (**N1**). Note a *second* social surface exists per-VPS (`server.ts:4262`), owner-scoped.
- **Fix:** derive the principal from the verified session; drop `authorId`/`userId`/
  `followerId` from the request contract. Add the N1 mount-order test.

### F2 — Platform store API trusts the body (no longer internet-facing)
- **Status:** `CHANGED` ↓ (was CRITICAL) · **Risk:** MED (L1×B3 = 3)
- **Where:** `store-api.ts:65-100`; mount `main.ts:3738`; gate `main.ts:3374`
- **What changed:** same as F1 — `/api/store` is behind the bearer gate now. `POST /apps`
  still takes `authorId` from the body. Pairs with F8 (a store app is a foothold on every
  installer's VPS via F3).
- **Fix:** derive `authorId` from the session, never the body.

### N1 — Platform public/private split is mount-order-dependent
- **Status:** `NEW` · **Risk:** MED (L1×B3 = 3)
- **Where:** `main.ts:3374-3386`
- **Attack:** the only thing separating public from admin-only on the platform is the
  position of `app.use('*', requireBearer...)` at line 3374. Every route registered
  *above* it is public; everything below needs the secret. A future PR that mounts a
  sensitive route earlier (or reorders) silently exposes it, with no compile-time or
  test signal. Also: when `platformSecret` is unset the gate returns `503 "Platform
  admin not configured"`, leaking config state vs a flat 401.
- **Fix:** prefer explicit per-group auth middleware over one positional gate; at
  minimum add a test that enumerates mounted routes and asserts the intended public set
  is exactly `{health, metrics, *-self-upgrade, …}`. Return a uniform 401/403.

### F6 — File-protection hook bypassable via Bash; denylist is dead code
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B2 = 3, amplifier for F5)
- **Where:** `evolution.ts:22`; registration `options.ts:159-160`; unused `packages/gateway/src/security/tool-deny.ts`; unwired `approval.ts` (`createApprovalHook`)
- **Attack:** the hook protecting `constitution.md`, kernel, and gateway source only
  matches `Write|Edit` (`evolution.ts:22` early-returns for anything else). `Bash`
  (`cat`, `sed -i`, `cp`, selective `rm`) isn't checked, so injected instructions read
  or modify "protected" files anyway. `DEFAULT_DENY_LIST` in `tool-deny.ts` is never
  called (verified via grep); `createApprovalHook` is defined but never registered in
  `options.ts`.
- **Fix:** add a `Bash` arm that resolves file arguments to absolute paths and applies
  the same protected-path check; wire the denylist and approval hook into the kernel, or
  delete the dead code so it stops reading as a control that exists.

### F8 — Store apps run with no review, scan, or permission model
- **Status:** `PERSISTENT` · **Risk:** MED (L2×B2 = 4, amplifier for F2+F3)
- **Where:** `app-publish.ts:24-52`, `app-fork.ts:30-90`
- **Attack:** publish/fork validates manifest presence + size only. No code scan, no
  declared-permission model, no install-time consent. A published app runs on every
  installer's VPS with full bridge access — which, via F3, is every other app's data.
- **Fix:** fixing F2+F3 de-fangs this. Add at least a permission manifest + install
  consent before treating the store as untrusted-author.

### F9 — Gateway trusts `x-platform-user-id` for identity
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B3 = 3)
- **Where:** `request-principal.ts:126-134`, `server.ts:1126-1219`
- **Attack:** prod identity comes from the `x-platform-user-id` header the reverse proxy
  sets; the gateway validates the user *exists*, not that the caller is them. If any route
  reaches the gateway without the proxy overwriting/stripping that header, identity is
  forgeable.
- **Fix:** confirm the proxy unconditionally sets/strips it on every path; better, verify
  a signed token rather than a bare header. Document the residual trust.

### F10 — Host bundles verified by SHA256 only, no signature
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B3 = 3)
- **Where:** `distro/customer-vps/host-bin/matrix-sync-agent:178-189`
- **Attack:** the update checksum is fetched from the same manifest endpoint as the
  bundle, so a compromised platform/manifest serves a malicious bundle with a matching
  hash. If `sha256` is absent the agent logs a warning and installs anyway (`:188`).
- **Fix:** sign bundles (minisign/cosign), pin the public key on the VPS, fail closed when
  signature or hash is missing.

### F12 — IPC/MCP server has no per-caller auth
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B2 = 2, compounds F5)
- **Where:** `ipc-server.ts:64+`
- **Attack:** the in-process MCP server exposes `manage_cron`, `call_service`,
  `send_message` etc. with no caller identity check (`from: "agent"` hardcoded). Any
  sub-agent or anything reaching the socket calls any tool. The cron `message` field is
  later re-injected into the kernel (`server.ts` `onTrigger`).
- **Fix:** tag tools with a required role; check caller origin in the tool handler.

### F14 — LLM cost amplification via injected loops
- **Status:** `PERSISTENT` · **Risk:** MED (L2×B1 = 2, financial — not DoS)
- **Where:** `ipc-server.ts:648-787` (`generate_image`, `speak`)
- **Attack:** cost is tracked *after* the call, never checked before. An injected
  "generate 100 images" loop burns real Gemini/ElevenLabs credits in minutes.
- **Fix:** per-source/day quota on paid tools; require owner origin for high-cost calls.

### F15 — Secrets distributed via cloud-init user-data
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B2 = 2; B3 if R2 key counts)
- **Where:** `customer-vps-cloud-init.ts:29-35`
- **Attack:** R2 keys, platform token, Postgres password ride cloud-init user-data, which
  Hetzner may retain/log and expose via the metadata API/console. Redaction is applied to
  *our* logs, not the provider's. At rest on-box the env files are `0640` (good).
- **Fix:** fetch secrets post-boot over an authed channel instead of baking them into
  user-data; rotate anything shipped this way.

### F17 — PTY inherits full `process.env`
- **Status:** `PERSISTENT` · **Risk:** MED (L1×B2 = 2, chains with F5)
- **Where:** `pty.ts:55` (`env: { ...process.env }`) vs allowlisted `zellij-runtime.ts:130-138`
- **Attack:** terminal sessions get `MATRIX_AUTH_TOKEN`, `DATABASE_URL`,
  `PIPEDREAM_CLIENT_SECRET`, etc. The owner has shell access anyway, so on its own this is
  low — but the kernel can spawn a PTY, so prompt injection (F5) → terminal → secret read
  is a real chain.
- **Fix:** match the zellij allowlist approach for the raw PTY path.

---

## ⚪ LOW

### N2 — `public-origin.ts` trusts forwarded host/proto
- **Status:** `NEW` · **Where:** `shell/src/lib/public-origin.ts:26-31`
- When `NEXT_PUBLIC_MATRIX_APP_URL` is unset it builds the origin from
  `x-forwarded-host`/`x-forwarded-proto`. Used for auth-redirect construction → host-header
  injection if the perimeter doesn't sanitize those headers. **Fix:** set the canonical
  origin env in prod; treat forwarded headers as untrusted otherwise.

### F13 — WebSocket tokens in the URL query string
- **Status:** `PERSISTENT*` (intentional, mitigated) · **Where:** `auth.ts:223-231`
- Browsers can't set WS auth headers, so the token rides `?token=` where it can land in
  access/proxy logs and `Referer`. Mitigated by timing-safe compare + rate limiting and
  short-lived tickets. **Fix (hardening):** keep tickets single-use + short-TTL; scrub
  from long-lived logs.

### F16 — `curl | bash` at provisioning
- `scripts/setup-server.sh:9` and `matrix-install-linux-tools:98-105` pipe NodeSource /
  Homebrew installers to bash with no checksum. Provisioning-time only. Pin + verify, or
  vendor the step.

### F18 — Preview-manager DNS not pinned
- `preview-manager.ts:151-183` validates the resolved IP against private ranges but
  fetches by hostname, leaving a small DNS-rebinding window. Dev-preview feature, low. Pin
  the resolved address for the actual fetch.

### F11 — `/vps/register` auth (downgraded)
- **Status:** `CHANGED` ↓ · **Where:** `customer-vps.ts:599-601`
- The registration token is now validated with a timing-safe hash compare inside
  `service.register`, not left implicit. Still belongs at the route boundary for
  defense-in-depth, but no longer an open gate. **Fix:** add a boundary check in
  `customer-vps-routes.ts:110-122` too.

---

## Positive controls (regression guards)

Correct today and load-bearing — call them out in PRs that touch the area.

- Path traversal: realpath + symlink checks — `path-security.ts`
- SQL identifier allowlist (`parseSafeName`) + parameterized values — `app-db-query.ts`
- App proxy SSRF allowlist + `redirect:"error"` — `server.ts:3315`
- Per-tenant Postgres database + HMAC-derived role password — `orchestrator.ts`
- Internal sync: handle HMAC, timing-safe compare, prefix-scoped keys — `internal-sync-routes.ts`
- Stripe webhook signature + event dedupe — `billing-routes.ts`
- **Platform bearer gate (new)** closed the unauthenticated social/store hole — `main.ts:3374` *(fragile: N1)*
- App sandbox: null-origin iframe, CSP `connect-src 'self'`, bridge URL allowlist — `app-viewer-helpers.ts`, `app-viewer-bridge-policy.ts`
- Session cookies HttpOnly+Secure+SameSite; HMAC native-app proof — `session-cookies.ts`
- GCP Secret Manager for platform secrets; bundle/sync bucket separation check — `platform-cloud-run.yml`
- `minimumReleaseAge: 10080`, frozen lockfiles, example-key CI rejection, immutable R2 release objects

---

*AI-assisted scan. Not a professional audit — get a real pentest before production reliance.*
