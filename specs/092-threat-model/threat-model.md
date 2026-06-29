# Matrix OS — Threat Model

**Version 2 · re-verified against `main` @ `205a8bb0b` (June 2026).**

This is the canonical hub. It defines what the system is, what we're protecting,
who attacks it, and where the boundaries are. The scored, issue-ready list lives
in [`risk-register.md`](./risk-register.md); per-finding detail with file:line and
fixes in [`findings.md`](./findings.md); STRIDE per boundary in
[`stride-analysis.md`](./stride-analysis.md); data/secrets/privacy in
[`data-flows.md`](./data-flows.md).

Everything load-bearing here was traced in code this pass, not guessed. Where a
prior pass disagreed with itself, the disagreement is called out and resolved.

---

## 1. System — what Matrix OS actually is

Matrix OS is two systems sharing one name, and the security story is different for
each. Keeping them straight is the whole game.

**The platform** (`packages/platform`, runs at matrix-os.com on Cloud Run).
Multi-tenant, public internet, Clerk auth, Stripe billing. It provisions and
routes to one VPS per signed-up user. This is the shared front door — **a bug here
hits everyone.**

**The per-user VPS** (`packages/gateway` + `packages/kernel` + the Next.js shell,
shipped as a host bundle). One box per customer. The owner has root on it anyway,
so the interesting boundaries are *inside* one user's machine: untrusted
third-party apps, and prompt injection through the AI kernel. **A bug here hits one
user** — unless it also reaches shared infrastructure (the R2 bucket), in which
case it climbs back up to everyone.

The same class of bug — *"identity comes from a value the caller controls"* — is
CRITICAL on the platform and merely HIGH on the gateway, purely because of blast
radius. The risk scoring (§7) formalizes that intuition.

---

## 2. Component inventory

### Platform (`packages/platform/src`) — multi-tenant, public

| Component | Purpose |
|---|---|
| `main.ts` | HTTP server; mounts all route groups; **global bearer-auth middleware at `:3374`**; host-based session routing to user containers |
| `auth-routes.ts` / `auth-pages.ts` | Clerk device-flow OAuth, checkout/session UI (1171 lines of templated HTML+JS) |
| `session-cookies.ts` | App/code/native session cookie builders (HttpOnly+Secure+SameSite), HMAC native-app proof |
| `request-routing.ts` | Post-auth redirect normalization, runtime-slot selection, device-return validation |
| `clerk-auth.ts` | Clerk JWT verify + session revocation |
| `billing-routes.ts` / `stripe-billing.ts` / `billing.ts` | Stripe checkout/portal/status/webhooks; entitlement projection; VPS provisioning gate |
| `customer-vps-*.ts` (routes, config, cloud-init, auth, r2, schema, fleet) | VPS provision/register/recover/deploy/delete; secret rendering into cloud-init; R2 key scoping |
| `social-api.ts` / `social.ts` | Posts/comments/likes/follows feed (platform copy) |
| `store-api.ts` / `store.ts` | App registry: publish/search/install/rate |
| `internal-sync-routes.ts` | `/internal/containers/:handle/sync/*`; HMAC-handle auth, presign prefix-scoping |
| `db.ts` | Postgres schema + query layer (users, machines, billing, webhooks) |
| `r2-keys.ts` / `r2-client.ts` | Safe R2 key construction (userId prefix), object store client |
| `platform-token.ts` / `sync-jwt.ts` | HMAC platform-verification token; legacy sync JWT |
| `gemini-live-proxy.ts` | WS proxy to Gemini Live (handle-token authed) |

### Gateway (`packages/gateway/src`) — per-VPS, owner-scoped

| Component | Purpose |
|---|---|
| `server.ts` | Main Hono HTTP/WS server (~4400 lines); route + auth-middleware composition (`:1641`); the app bridge (`/api/bridge/*`) |
| `auth.ts` / `request-principal.ts` | Bearer/JWT validation, rate limiting, public-path exemptions; request-identity resolution |
| `path-security.ts` | realpath + per-segment symlink containment for all file ops |
| `app-db*.ts` (db, query, types, registry, kv) | Per-app Postgres schemas + KV; `parseSafeName` identifier allowlist; parameterized SQL |
| `app-publish.ts` / `app-fork.ts` / `app-ops.ts` | Store publish/fork/install (manifest+size validation only) |
| `channels/*` (telegram, manager, push, stream) | Inbound channel adapters; sender allowlists; route to dispatcher |
| `dispatcher.ts` | Marshals every request source into a kernel run; external-content wrapping |
| `cron/*` / `heartbeat/*` | Scheduled + periodic kernel triggers |
| `pty.ts` / `zellij-runtime.ts` | Terminal spawning (full env vs allowlisted env) |
| `preview-manager.ts` | Dev-preview URL validation (private-IP reject, no DNS pin) |
| `postgres-manager.ts` | Per-app Postgres credential file management |
| `integrations/*` | Pipedream connect/call proxy (platform-owned secrets) |
| `system-update.ts` | Update-check + `sudo matrix-update` spawn |
| `security/*` | headers, rate-limiter, timing-safe compare, outbound-queue, `tool-deny.ts` (unused) |
| `ws-message-schema.ts` / `prompt-validation.ts` | WS frame Zod schemas; control-char filtering |

### Kernel (`packages/kernel/src`) — the AI, per-VPS

| Component | Purpose |
|---|---|
| `options.ts` | SDK options: **`permissionMode: bypassPermissions`**, static `allowedTools`, hook registration |
| `kernel.ts` / `prompt.ts` / `soul.ts` | `query()`+`resume` orchestration; system-prompt assembly; SOUL/identity/memory injection |
| `hooks.ts` / `evolution.ts` | PreToolUse safety + protected-file hooks; `createApprovalHook` (defined, **unwired**) |
| `ipc-server.ts` | In-process MCP server: 40+ tools (cron, services, image/voice, fork/install app, memory) |
| `security/external-content.ts` | Untrusted-content wrapping + suspicious-pattern scan (**detect-only**) |
| `agents.ts` / `skills.ts` | Custom sub-agent + skill loading from owner files |
| `memory.ts` / `app-data.ts` / `usage.ts` | SQLite memory (re-injected into prompt), app KV, cost tracking |
| `tools/*` | web-search, web-fetch (SSRF-guarded), integrations |

### Shell (`shell/src`) + app sandbox — per-VPS, browser

| Component | Purpose |
|---|---|
| `components/AppViewer.tsx` | Renders app iframes; **the bridge relay** (envelope validation + verbatim body forward) |
| `components/app-viewer-bridge-policy.ts` | Bridge-fetch **URL** allowlist (new; does not touch `body.app`) |
| `components/app-viewer-helpers.ts` | Sandbox attributes (`allow-scripts allow-forms allow-popups`, no `allow-same-origin`) + injected CSP |
| `lib/os-bridge.ts` | `window.MatrixOS` bridge script injected into apps; postMessage protocol |
| `proxy.ts` / `lib/proxy-routes.ts` | Clerk gate; injects gateway bearer on proxy; host routing |
| `lib/public-origin.ts` | Public-origin resolution (trusts `x-forwarded-*` when no canonical set) |
| `lib/websocket-auth.ts` | Fetches short-lived WS ticket, appends `?token=` on upgrade |
| `lib/shell-metadata.ts` / `lib/pre-vps-shell.ts` | Identity metadata for `<head>`; pre-VPS billing-route detection |

### Infrastructure & supply chain

| Component | Purpose |
|---|---|
| `distro/customer-vps/cloud-init.yaml` | VPS first-boot: writes secret env files (`0640`), installs+starts systemd units |
| `distro/customer-vps/host-bin/matrix-sync-agent` | Polls release channel, downloads bundle, **SHA256-only** verify, apply+rollback |
| `distro/customer-vps/host-bin/matrix-install-linux-tools` | Post-boot Homebrew/gh install (`curl | bash`, no checksum) |
| `scripts/build-host-bundle.sh` / `publish-release.sh` | Build immutable bundle; upload to R2 (`if-none-match=*`) + register metadata |
| `.github/workflows/*` | host-bundle-release, platform-cloud-run (GCP OIDC + Secret Manager), CI gates |

---

## 3. Asset & data register

Sensitivity: **critical** = compromise is unrecoverable/cross-tenant; **high** =
owner's private data; **medium** = degrades trust/integrity.

| Asset | Lives in | Owner | Sensitivity | Boundaries crossed |
|---|---|---|---|---|
| Identity / handle / Clerk user | Platform Postgres | Platform | high | TB-1, TB-2 |
| Billing / Stripe customer | Platform Postgres + Stripe | Platform | high | TB-1 |
| VPS registry & machine state | Platform Postgres | Platform | medium | TB-2 |
| Social posts / follows / likes | Platform + per-VPS Postgres | User | medium | TB-1, TB-3 |
| Store app metadata | Platform Postgres | Author | medium | TB-1 |
| Per-app application data | Per-app Postgres schema (VPS) | User | high | TB-4 |
| App KV blobs | KV store (VPS) | User | high | TB-4 |
| Owner files / home (`$MATRIX_HOME`) | VPS filesystem | User | high | TB-3, TB-6 |
| Synced file backups | R2 `matrixos-sync/{userId}/` | User | high | TB-7 |
| Conversations / memory / SOUL | VPS filesystem | User | high | TB-5, TB-6 |
| Connected-integration tokens | Platform-owned (proxied) | User | high | TB-5, TB-6 |
| **Secrets** (R2 key, DB pw, platform token) | VPS env + config files | Platform/User | **critical** | TB-2, TB-6, TB-7 |

Full secrets table (issuer, at-rest mode, scope, risk) in
[`data-flows.md` §Secrets inventory](./data-flows.md).

---

## 4. Actors & capability matrix

| Actor | Reaches | Cannot (today) | Drives findings |
|---|---|---|---|
| **Internet stranger** | Anything on matrix-os.com not behind auth: health, metrics, bundle manifests, auth/checkout pages, Stripe webhook (signed) | Platform admin routes (bearer-gated), Clerk-authed routes | N1 (mount-order), F9, F10 |
| **Authenticated Matrix user** | Their own shell→gateway; the platform routes the shell proxies to | Other users' VPSes (host-routed by verified Clerk id) | F1/F2 residual, F3, F8 |
| **Malicious / compromised installed app** | Sandboxed JS in owner's shell; the `/api/bridge/*` surface via the relay | Shell DOM/cookies (null-origin), non-bridge URLs (policy allowlist) | **F3**, F8, F14 |
| **Anyone who can put text in front of the kernel** (channel msg, social, fetched web page) | Full kernel toolset under `bypassPermissions`; the confused deputy | — (no per-source gating exists) | **F5**, F6, F12, F14 |
| **A single popped VPS** | The standing full-bucket R2 credential → every user's backups | Platform Postgres, other users' kernels directly | **F4**, F7, F15 |
| **Compromised platform / manifest** | Serves a malicious host bundle (SHA256-only, no signature) to every VPS | — | F10 |

**Out of scope this pass:** a malicious Anthropic/Clerk/Stripe/Hetzner; physical
access; the owner attacking their own box (they have root); pure DoS/resource
exhaustion (financial cost amplification *is* in scope — see F14).

---

## 5. Trust boundaries

```
internet ──▶ [platform @ matrix-os.com] ──▶ provisions/routes ──▶ [user VPS]
                  │  Clerk auth, Stripe (signed ✓)                  │
                  │  GLOBAL bearer middleware @ main.ts:3374         │
                  │  → /api/social, /api/store now gated ✓          ▼
                  │    BUT handlers still trust body.authorId,  [gateway (Hono)]
                  │    and the gate is mount-order-dependent (N1)│ owner JWT / header
                  ▼                                               ▼
            [platform Postgres,                            [per-app Postgres schemas]
             shared R2 bucket]  ◀── every VPS holds the    [KV store]
                                     SAME full-bucket key   [kernel = Agent SDK]
                                     (F4) ✗                       │ bypassPermissions, all
                                                                  │ sources (F5) ✗
                                                                  ▼
                                                            [sandboxed apps]
                                                             iframe null-origin,
                                                             CSP connect-src self ✓
                                                             URL allowlist ✓ (new)
                                                             but body.app forwarded
                                                             verbatim → cross-app
                                                             read (F3) ✗
```

- **TB-1** Internet → Platform
- **TB-2** Platform → VPS (provisioning, routing, internal sync)
- **TB-3** Browser/shell → Gateway (owner-authed API + WS)
- **TB-4** Sandboxed app → Shell relay → Gateway bridge
- **TB-5** External channels / web content → Kernel (prompt-injection surface)
- **TB-6** Kernel/agents → Tools (file, DB, IPC, paid services, cron)
- **TB-7** VPS → shared R2

**Boundaries that hold (do not regress — see §8):** the iframe sandbox, per-tenant
Postgres *databases*, the internal-sync HMAC, Stripe signature checks, the app-proxy
SSRF allowlist, path-traversal defense, and — new this pass — the global
bearer-auth gate that closed the unauthenticated social/store hole.

**Boundaries that leak** are all the same shape: a privileged layer decides *"who am
I acting for"* or *"which app's data is this"* from a value the caller supplies
(`body.authorId`, `body.app`, `x-platform-user-id`) instead of from something it
verified.

---

## 6. The findings that matter — current ranking

Re-verification reshuffled the board. The two original CRITICALs were substantially
mitigated by the auth refactor; the worst live issues are now the app sandbox and
the shared R2 key.

1. **F3 — any installed app reads/writes every other app's data (HIGH, PERSISTENT).**
   The single most important correction this pass. A prior explorer (and one agent
   this pass) called this fixed because the relay pins the message *envelope's* `app`
   to the iframe slug. It is **not** fixed: a malicious app sends a raw
   `os:bridge-fetch` with envelope `app` = its *own* slug (passing the check) and
   `init.body` = `{app:"victim-app", action:"find", ...}`. `handleBridgeFetch`
   forwards `init.body` **verbatim** (`AppViewer.tsx:61`) to `/api/bridge/query`,
   where the gateway reads `body.app` with no ownership check (`server.ts:3162`). The
   new URL allowlist (`app-viewer-bridge-policy.ts`) guards the URL, never `body.app`.
   With a store now shipping installable apps, "install one bad app" is expected
   behavior. **This is the #1 fix.**

2. **F4 — one key opens every user's backups (HIGH, PERSISTENT).** Every VPS is
   handed the *same* full-bucket R2 credential (`customer-vps-config.ts:51`). The
   normal sync path is presign-prefix-scoped (good), but the standing credential on a
   popped box reads/writes `matrixos-sync/<any-user>/` directly. Highest blast radius
   of any live finding: one box → everyone's files.

3. **F5 — the kernel is a confused deputy by design (HIGH, PERSISTENT).** Every
   source — owner chat, a stranger's Telegram message, cron, heartbeat — runs under
   `bypassPermissions` with the identical full toolset (`options.ts:131`,
   `dispatcher.ts`). Untrusted content is wrapped and scanned, but the scan only
   *logs* (`external-content.ts`); nothing blocks. An injected instruction reaches
   `call_service` (email/Slack as the owner), `manage_cron` (persistence that
   outlives the message), `generate_image`/`speak` (uncapped spend), `fork_app`. The
   approval-hook scaffold exists in `hooks.ts` but is unwired; `tool-deny.ts` is dead
   code; the file-protection hook only matches `Write|Edit`, so `Bash` walks around
   it (F6).

4. **F1/F2 — platform social/store still trust the body, but are no longer public
   (downgraded CRITICAL → MEDIUM).** The global middleware at `main.ts:3374` now
   gates `/api/social` (`:3744`) and `/api/store` (`:3738`) behind the platform
   bearer secret, so the "random stranger impersonates anyone" attack is closed. The
   handlers still read `authorId`/`x-user-id` from the body, so any holder of the
   admin secret can still spoof — and the protection is **entirely mount-order
   dependent** (N1): any route added above line 3374 is public. Derive the principal
   from the verified session and delete the body fields; add a test that asserts no
   public route mounts above the gate.

5. **F7 — secrets world-readable and syncable (HIGH, PERSISTENT).** `credentials.json`
   (app DB password) lands `0644` (`postgres-manager.ts:69`), and the sync engine's
   default ignore list omits `.env*`/`credentials.json` (`syncignore.ts`), so a stray
   secret under `$MATRIX_HOME` rides sync up to R2. Two one-liners; closes a quiet
   exfil path that compounds F4.

The long tail (F6, F8–F18, plus new N1/N2) is scored in
[`risk-register.md`](./risk-register.md) and detailed in
[`findings.md`](./findings.md).

---

## 7. How risk is scored

CVSS misfits a multi-tenant system whose severity is really *"who can reach it ×
how many users it hits."* So the register scores two axes and multiplies.

**Likelihood** — how much an attacker needs first:
`3 Exposed` (reachable now, no foothold) · `2 Foothold` (needs an installed app,
channel access, or a popped box) · `1 Chained` (needs another bug or privileged
secret first).

**Blast radius** — how far one success reaches:
`3 All users` (platform or shared R2) · `2 One user` (a whole VPS) · `1 One app`
(within a single VPS).

**Risk = Likelihood × Blast radius** (1–9) → **9 CRITICAL · 6 HIGH · 3–4 MEDIUM ·
1–2 LOW.** This reproduces the original CRITICAL-vs-HIGH split (platform bug =
blast 3; VPS bug = blast 2) without importing a vector string nobody will maintain.

---

## 8. Positive controls — regression guards

Correct today and load-bearing. Call these out in any PR that touches the area.

- **Path traversal:** realpath + per-segment symlink checks on every file op — `path-security.ts`.
- **SQL:** identifiers allowlisted via `parseSafeName`, values parameterized — `app-db-query.ts`.
- **SSRF:** app proxy is a hardcoded host allowlist with `redirect:"error"`; preview fetches reject private resolved IPs — `server.ts:3315`, `preview-manager.ts`.
- **Tenant DB isolation:** each handle gets its own Postgres *database* + HMAC-derived role password — `orchestrator.ts`.
- **Internal sync auth:** handle-derived HMAC, timing-safe compare, keys prefix-scoped before any presign — `internal-sync-routes.ts`.
- **Stripe:** webhook signature verified, events deduped by id — `billing-routes.ts`.
- **Platform auth gate (new):** global bearer middleware closed the social/store hole — `main.ts:3374`. *(Fragile — see N1.)*
- **App sandbox:** null-origin iframe (`allow-scripts allow-forms allow-popups`, no `allow-same-origin`), CSP `connect-src 'self'`, bridge URL allowlist — `app-viewer-helpers.ts`, `app-viewer-bridge-policy.ts`.
- **Session cookies:** HttpOnly + Secure + SameSite; native-app proof is HMAC, timing-safe — `session-cookies.ts`.
- **Supply chain:** `minimumReleaseAge: 10080` (7-day npm hold), frozen lockfiles, CI rejects the example Clerk key, immutable R2 release objects, GCP Secret Manager for platform secrets.

---

## 9. Keeping this model alive

A threat model is only worth the structure if it survives the next 50 PRs. The
process:

1. **Per-PR trigger.** A PR that adds an endpoint, WS channel, IPC tool, channel
   adapter, or touches `body.app`/identity headers/secret distribution must update
   the relevant boundary in [`stride-analysis.md`](./stride-analysis.md) and, if it
   opens or closes a finding, the register. This is a natural extension of the
   existing Spec Quality Gates.
2. **Re-verify on refactor.** When a load-bearing file moves (this pass's trigger was
   the `main.ts` split), re-trace every finding that cited it. Stale file:line in a
   threat model is worse than none — it reads as covered when it isn't.
3. **Fix order = score order.** The register is sorted by `L×B`. F3, F4, F5 first.
4. **Close, don't drift.** When a finding is fixed, move it to §8 as a regression
   guard with the commit that fixed it — don't just delete it. F1/F2's downgrade is
   the template.

### If you fix five things first

1. **F3** — at the relay, overwrite `body.app` with the iframe's real slug before
   forwarding (don't trust it from the app); at the gateway, check the resolved app
   belongs to the owner. The store makes this urgent.
2. **F4** — per-user scoped R2 credentials, or drop the standing key and presign-only.
3. **F5/F6** — per-source `allowedTools` (untrusted channels get a read-only subset),
   wire `createApprovalHook` for the dangerous tools, make the injection scan a
   blocking `PreToolUse` decision, and add a `Bash` arm to the protected-file hook.
4. **F1/F2 + N1** — derive the social/store principal from the verified session, drop
   the body identity fields, and add a test asserting no public route mounts above
   `main.ts:3374`.
5. **F7** — `chmod 0600` credential files; add `.env*`, `credentials.json`, `*.pem`,
   `*.key` to the sync ignore defaults. Two one-liners.

Items 2, 4, 5 are an afternoon each. 1 and 3 are real design work and overlap the
existing `025-security` spec.

---

*AI-assisted threat model, not a substitute for a professional audit. It catches
common patterns and traces concrete paths; it misses subtle ones. For a system
handling user data and payments, get a real pentest before leaning on this as your
only line of defense.*
