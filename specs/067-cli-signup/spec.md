# 067: CLI Signup — Create a Matrix OS Instance From the Terminal

## Overview

`matrix login` on a fresh machine today only authenticates an existing Matrix OS
account. If the user has never signed up, the CLI prints "Sign up at
app.matrix-os.com first" and exits. This spec covers the flow that lets a new
user create the Clerk account, provision the Hetzner container, seed a first-
boot package set, and drop into a working sync — all from the terminal.

This is follow-up PR 4 of the `066-file-sync` deployment plan
(`specs/066-file-sync/deployment-plan.md`). PRs 1–3 (backend sync, client UX,
distribution) must be shipped and stable before this one starts: signup changes
the Clerk + orchestrator integration surface, which is the highest-risk
component on the critical path. Splitting it out keeps file sync shippable on
its own and lets us dogfood 1–3 while the signup surface is designed.

## Motivation

- **Zero-touch onboarding for power users.** `brew install matrix` then
  `matrix onboard` should be the whole thing — no browser context switch.
- **Unlocks CLI-first distribution channels.** Raycast extension, VS Code
  extension, and scripted installs all need a programmatic signup endpoint.
- **Reference for the mobile app signup.** Same `POST /api/signup` endpoint
  will back the Expo app (spec 027).
- **Package selection is the "personalize at boot" moment.** Choosing `claude-
  code`, `hermes`, `moltbot`, etc. at signup is a better UX than a freshly
  provisioned empty home that the user has to populate manually.

## Goals / Non-Goals

### Goals

1. `matrix onboard` interactive flow: email → handle → package picker → ready
   in ≤ 60s wall clock.
2. Non-interactive `matrix onboard --email ... --handle ... --packages ...`
   variant for scripted installs.
3. Single platform endpoint `POST /api/signup` backs both CLI and future web
   "quick signup" entry points.
4. Package registry with a central catalog at `app.matrix-os.com/api/packages/
   catalog` and a per-user manifest at `~/system/packages.json` that the
   gateway reads on first boot.
5. Abuse prevention: per-IP + per-email rate limits, Cloudflare Turnstile at
   the HTTP boundary, email verification, cooldown on failures.
6. Hard quota: 1 container per Clerk user (enforced at signup and orchestrator
   level).

### Non-Goals

- **Billing / paid tiers.** v1 is free only; billing hooks land in a follow-up
  spec. We define the data shape so `POST /api/signup` can accept `plan`
  later without a schema break, but no charge happens at v1.
- **Team/org signup.** Spec 030-settings and the constitution's multi-tenancy
  principle cover org provisioning; this spec is personal-only.
- **SMS verification.** Email-only. SMS is a later abuse-prevention layer if
  email proves insufficient.
- **Custom regions.** Containers go to Hetzner Nuremberg (nbg1) per existing
  orchestrator config; region picker is a later feature.
- **Handle reservation with queue.** First-come-first-served. Reserved / vanity
  handles are a manual admin process.

## UX Flow

### Interactive (`matrix onboard`)

```
$ matrix onboard
Welcome to Matrix OS.
Let's set up your Matrix instance. (takes ~30s)

Email:            hamed@example.com
Handle:           hamed
  -> Checking availability...
  -> @hamed is available.

We'll send a 6-digit code to hamed@example.com. [Enter to send]
Sent. Paste the code:
Code:             123456

Select packages to install (space to toggle, enter to confirm):
  [x] claude-code       Claude Code integration (recommended)
  [x] hermes            Hermes personal agent (recommended)
  [ ] moltbot           Multi-channel messenger bot
  [ ] calendar          Calendar + scheduling
  [ ] notes             Markdown notes
  [ ] --- empty ---     Skip packages, start with an empty home

Creating your Matrix instance...
  [OK] Clerk account created
  [OK] Container provisioned (Nuremberg, cx22)
  [OK] Home directory seeded
  [OK] Packages installed: claude-code, hermes

Ready.
  Handle:     @hamed:matrix-os.com
  Gateway:    https://app.matrix-os.com
  Synced to:  ~/matrixos

Open with:    matrix open
Shell:        matrix shell
```

Failure modes render inline — handle collision, rate limited, CAPTCHA required,
email verification timeout, container provisioning failed. See "Failure Modes"
below for the exact copy + exit codes.

### Non-Interactive (`matrix onboard --email ... --handle ... --packages ...`)

```
$ matrix onboard \
    --email hamed@example.com \
    --handle hamed \
    --packages claude-code,hermes \
    --accept-tos \
    --turnstile-token <from-prompt-or-web-flow>

# Exit codes:
#  0  success
#  2  validation error (bad email, bad handle, invalid packages)
#  3  handle taken
#  4  email already has an account
#  5  CAPTCHA / abuse check failed
#  6  email verification timeout (code never submitted)
#  7  provisioning failed (container never came up)
#  8  rate limited
#  9  service unavailable
```

Non-interactive mode still requires email verification: after `POST /api/
signup`, the CLI polls `POST /api/signup/verify` with the 6-digit code that
landed in the inbox. Scripts must either pipe the code in with `--code` (for
fully automated flows against a test inbox) or present the prompt to a human.
For CI, `MATRIXOS_SIGNUP_TEST_CODE` bypass is ONLY honored when
`NODE_ENV=test` and `SIGNUP_TEST_MODE=true` server-side.

### Edge Cases

| Scenario | Behaviour |
|---|---|
| Email already has a Clerk account | `matrix login` instead, with link to app.matrix-os.com for password reset. Exit 4. |
| Handle taken by another account | Inline re-prompt in interactive mode; exit 3 in non-interactive. Suggest `<handle>1`, `<handle>-ai` etc. |
| Handle taken but by the same Clerk user's existing container | Treat as "already signed up" — print the "you already have an instance" message, prompt to run `matrix login`. |
| User hits Ctrl-C after email sent | `auth.json` not written, no DB row persisted beyond the pending signup row. Pending row TTLs out in 24h. |
| User never submits verification code | Same — pending signup TTLs out. `matrix onboard` re-run from scratch. |
| User submits wrong code 5 times | 10-minute cooldown. Exit 5. |
| Network failure mid-provision | Signup row marked `provision_failed`. User re-runs `matrix onboard` (same email + handle) — server detects the failed row, retries provisioning once, then errors out if it still fails. |
| Container provisioned but package install crashed | Container stays up, signup row marked `ready_no_packages`. User sees "Packages failed to install. Your instance is ready but empty. Run `matrix packages install <name>` to try again." Exit 0 (instance IS usable). |
| Rate limit hit mid-flow | Exit 8 with retry-after seconds. |
| User is on a fresh machine with no config at all | `matrix onboard` works without a prior `matrix login`; writes `auth.json` + `config.json` on success. |

### Alternative: `matrix login` entry point

If a user types `matrix login` and gets the existing 404 "no account" error
(spec 066, PR 1 decision), the message grows a third line:

```
You're signed in, but there's no Matrix instance for this account yet.

Run `matrix onboard` to create one now, or sign up at
https://app.matrix-os.com.
```

The `matrix login` flow itself does NOT silently kick into signup — always an
explicit separate command. (Rationale: `login` vs `signup` is a load-bearing
UX distinction; conflating them has burned us in prior specs.)

---

## Platform Endpoint Design

All signup traffic lands on `app.matrix-os.com` (no new subdomain per the
deployment plan).

### `POST /api/signup`

Verifies Turnstile, creates the pending signup row, rate-limits, and sends the
verification email. Public (no auth), CAPTCHA-gated.

**Request (Zod 4)**

```typescript
const SignupRequestSchema = z.object({
  email: z.string().email().max(320),           // RFC 5321 max
  handle: z.string().regex(HANDLE_PATTERN),     // [a-z][a-z0-9-]{2,30}
  displayName: z.string().min(1).max(100).optional(),
  packages: z.array(z.string().regex(PACKAGE_SLUG_PATTERN)).max(20).default([]),
  acceptTos: z.literal(true),
  turnstileToken: z.string().min(1).max(2048),  // Cloudflare Turnstile response
  clientId: z.string().min(1).max(256),         // e.g. "matrixos-cli/0.2.0"
});
```

**Response 201**

```json
{
  "signupId": "su_01J...",
  "verificationExpiresAt": 1745540800000,
  "resendAvailableAt": 1745540860000
}
```

**Response 4xx**

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Request body failed schema validation |
| 400 | `invalid_email` | Email rejected by Clerk backend |
| 400 | `invalid_handle` | Handle regex failed / reserved word / contains Clerk userid lookalike |
| 403 | `captcha_failed` | Turnstile token rejected |
| 409 | `handle_taken` | Handle already exists in `containers` table |
| 409 | `email_taken` | Email already has a Clerk user |
| 429 | `rate_limited` | IP or email or global rate limit hit. Honor `Retry-After` header. |
| 503 | `service_unavailable` | Clerk or Hetzner down; pending signup NOT persisted |

Errors never include raw Clerk / Turnstile / Postgres messages — those go to
`console.error` with the request id for correlation.

### `POST /api/signup/verify`

Submits the 6-digit email code, completes Clerk user creation + container
provisioning. Public, throttled per signupId.

**Request**

```typescript
const VerifyRequestSchema = z.object({
  signupId: z.string().regex(/^su_[A-Za-z0-9]{24,40}$/),
  code: z.string().regex(/^[0-9]{6}$/),
});
```

**Response 200**

```json
{
  "accessToken": "eyJhbGciOi...",            // same Sync JWT issue as device flow
  "expiresAt": 1745540800000,
  "userId": "user_2abc...",                  // Clerk sub
  "handle": "hamed",
  "gatewayUrl": "https://app.matrix-os.com",
  "packageStatus": "ok" | "partial" | "failed"
}
```

`packageStatus`:

- `ok` — all requested packages installed.
- `partial` — some packages installed, some failed. CLI prints which.
- `failed` — container up, no packages installed. CLI prints "you can retry
  with `matrix packages install <name>`".

**Response 4xx**

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_code` | Code mismatch. Count toward cooldown. |
| 404 | `unknown_signup` | `signupId` not in DB (expired / never existed) |
| 410 | `signup_expired` | 24h TTL hit, row deleted |
| 423 | `verification_locked` | Too many wrong codes, 10m cooldown |
| 500 | `provision_failed` | Container creation crashed. Safe to retry; see "Partial Provisioning Rollback". |
| 502 | `clerk_unavailable` | Clerk backend errored. Signup row kept; user can retry. |

### `POST /api/signup/resend`

Rate-limited resend of the email verification code.

**Request**

```typescript
const ResendRequestSchema = z.object({
  signupId: z.string().regex(/^su_[A-Za-z0-9]{24,40}$/),
  turnstileToken: z.string().min(1).max(2048),
});
```

60s cooldown between resends. 5 resends per signup before it locks. 200 OK or
429 `rate_limited`.

### `POST /api/signup/check-handle`

Lightweight availability check for the interactive flow.

**Request**

```typescript
const CheckHandleSchema = z.object({
  handle: z.string().regex(HANDLE_PATTERN),
  turnstileToken: z.string().min(1).max(2048).optional(),
});
```

If `turnstileToken` is present, the platform validates it and may require it
adaptively once the per-IP limiter starts seeing abuse. The default happy path
keeps handle checks lightweight and rate-limit-only.

**Response 200**

```json
{ "available": true, "suggestions": [] }
```

Or, if taken:

```json
{
  "available": false,
  "suggestions": ["hamed1", "hamed-ai", "hamedp"]
}
```

Rate-limited per IP (30/min). Does NOT leak Clerk existence — returns
`available: false` for both handle-taken and handle-reserved, with the same
payload shape.

### Auth Matrix

| Route | Method | Auth | Public? | Rate limit |
|---|---|---|---|---|
| `/api/signup` | POST | Turnstile + client fingerprint | Public | 3/hour/IP, 5/hour/email, 100/hour global |
| `/api/signup/verify` | POST | signupId + 6-digit code | Public | 5 wrong codes = 10min lockout per signupId |
| `/api/signup/resend` | POST | signupId + Turnstile | Public | 60s cooldown, 5 resends per signup |
| `/api/signup/check-handle` | POST | Rate limit, plus optional Turnstile under abuse | Public | 30/min/IP |
| `/api/packages/catalog` | GET | None (ETag-cached CDN) | Public | Cached 60s upstream |

No existing admin bearer is needed. These are the FIRST public write endpoints
on the platform other than the device flow; they inherit the device flow's
rate-limiter pattern (`packages/platform/src/auth-routes.ts:37-63`).

---

## Package Registry

### Central Catalog

`GET app.matrix-os.com/api/packages/catalog` returns a static JSON of every
installable package. File lives in the monorepo at
`packages/platform/data/packages/catalog.json`; checked in so diff review
enforces what users can install. CDN-cached 60s.

```json
{
  "catalogVersion": 1,
  "updatedAt": "2026-04-22T00:00:00Z",
  "packages": [
    {
      "slug": "claude-code",
      "name": "Claude Code",
      "tagline": "Claude Code integration",
      "description": "Pre-configures Claude Code with your Matrix OS soul and skills.",
      "category": "agents",
      "default": true,
      "version": "0.1.0",
      "installer": {
        "type": "git",
        "url": "https://github.com/matrix-os/pkg-claude-code",
        "ref": "v0.1.0",
        "commit": "abc123def456..."
      },
      "entrypoint": "install.mjs",
      "permissions": ["files:agents", "files:system"],
      "size": 12345,
      "sha256": "..."
    },
    {
      "slug": "hermes",
      "name": "Hermes",
      "tagline": "Your personal agent",
      "default": true,
      "installer": {
        "type": "builtin",
        "source": "hermes"
      }
    }
  ]
}
```

Installer types:

- `builtin` — copies files from the user-container image at a known path. No
  network required at install time. Used for first-party packages.
- `git` — clones a pinned commit. Git clone uses `AbortSignal.timeout(60_000)`
  and is restricted to an allowlist of hosts (`github.com`, `gitlab.com`).
- `registry` — downloads a tarball from `registry.matrix-os.com` (future).

### Per-User Manifest

On first boot the gateway reads `~/system/packages.json`:

```json
{
  "manifestVersion": 1,
  "installed": [
    {
      "slug": "claude-code",
      "version": "0.1.0",
      "installedAt": "2026-04-22T10:00:00Z",
      "commit": "abc123...",
      "status": "ok"
    }
  ],
  "pending": [],
  "failed": []
}
```

File is the source of truth per the constitution (Principle I). The gateway
reconciles it on boot: anything in `pending` gets installed, anything already
in `installed` is skipped (idempotent), failures move entries from `pending`
to `failed` with error text.

Manifest mutations are atomic writes (tmp + rename — see `writeManifest` in
`packages/gateway/src/sync/manifest.ts` for the pattern to copy).

### First-Boot Install Flow

1. Platform `POST /api/signup/verify` creates the container (orchestrator
   `.provision(handle, clerkUserId, displayName)`), writes the initial
   `~/system/packages.json` with `pending: [...requestedSlugs]`.
2. Gateway boots. Existing startup path detects unready home and seeds it
   (`packages/gateway/src/sync/home-mirror.ts`).
3. New startup step: `packages/gateway/src/packages/installer.ts` reads
   `~/system/packages.json`, for each `pending` slug fetches the catalog entry
   from platform's internal URL, runs the installer, moves entry to `installed`
   or `failed`.
4. Install budget: 120s total per signup; each package gets 30s max. Overshoot
   = partial failure, user can retry.
5. Installer returns a partial-status back through the internal HTTP channel
   so `/api/signup/verify` can report `packageStatus` accurately.

### Package Verification

Every `installer.type=git` package entry includes a `commit` SHA. The
installer clones by commit, not by ref, so tag rewrites can't swap code
underneath us. Package manifest `sha256` is verified against the downloaded
tarball for `registry`-type packages.

---

## Input Validation

### Email

- Max 320 chars (RFC 5321).
- Zod `.email()` (RFC 5322-ish).
- Reject `+` addressing for abuse prevention? NO — too aggressive, breaks
  legitimate users. We rely on Clerk's duplicate-detection instead.
- Normalize to lowercase before dedupe check.

### Handle

- Regex `^[a-z][a-z0-9-]{2,30}$` — matches existing `HANDLE_PATTERN` in
  `packages/platform/src/main.ts:40`.
- Reserved words (rejected server-side): `admin`, `root`, `api`, `app`,
  `auth`, `www`, `mail`, `support`, `help`, `dev`, `staging`, `test`,
  `matrix`, `matrixos`, `system`, `null`, `undefined`, `user`, `users`,
  `me`, `you`, `ai`, `bot`, plus anything that looks like a Clerk userid
  (`user_` prefix).
- Uniqueness check: Postgres UNIQUE on `containers.handle` enforces the
  invariant at the storage layer. `POST /api/signup/check-handle` and the
  verify step both check but the UNIQUE constraint is the actual guarantee.
- Reserved list is versioned in `packages/platform/data/reserved-handles.json`
  (checked in; diff review mandatory).

### Package Slugs

- Regex `^[a-z][a-z0-9-]{1,40}$` (similar to handles, a bit longer and with
  hyphens allowed).
- Max 20 packages per signup request (limits install-time blast radius).
- Each slug must exist in the fetched catalog — unknown slugs are rejected
  in `POST /api/signup` before the signup row is created.

### Display Name

- 1..100 chars, Zod default trim.
- No newlines, no NULL bytes, no control characters.
- Not used in filesystem paths, URLs, or SQL identifiers — rendered only.

### CSRF

All four POST endpoints are JSON; `signup` and `resend` always require
Turnstile, and `check-handle` can require it adaptively under abuse. No
cookie-based auth, so traditional CSRF doesn't apply. Browsers that might host
signup (future "quick signup" web form) use Clerk's built-in CSRF via
`same-origin` fetch from `matrix-os.com`.

---

## Abuse Prevention

### Rate Limits

Built on the existing `createRateLimiter()` pattern from `auth-routes.ts`,
with named window helpers (per-IP, per-email, global). Map size capped at
10_000 per bucket with FIFO eviction (consistent with existing limiter).

| Bucket | Limit | Window | Notes |
|---|---|---|---|
| Per-IP | 3 signups | 1 hour | IP from `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` first entry → `127.0.0.1`. |
| Per-email | 5 signups | 1 hour | Normalized lowercase email. |
| Global | 100 signups | 1 hour | Safety valve. Exceed = 503 to EVERY caller, paging operators. |
| Per-IP `check-handle` | 30 requests | 1 min | Prevent handle enumeration. |

Rate-limit responses always include `Retry-After` in seconds.

### Cloudflare Turnstile

- Site key + secret provisioned in Cloudflare account, stored in platform
  `.env` as `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`.
- CLI prompts the user to open `app.matrix-os.com/signup/captcha?signupId=
  pending` in a browser, solve the challenge, paste the resulting token back
  into the terminal. Same UX pattern as `matrix login` today.
- For the fully automated non-interactive case, `--turnstile-token` accepts a
  pre-solved token. `POST /api/signup/check-handle` may also accept an
  optional token when the platform decides to challenge suspicious callers.
- Test environments set `NODE_ENV=test` and `SIGNUP_TEST_MODE=true`
  server-side to enable the `MATRIXOS_SIGNUP_TEST_CODE` bypass; either flag
  missing keeps the bypass disabled.
- Validation: server-side `POST https://challenges.cloudflare.com/turnstile/
  v0/siteverify` with 5s timeout. Fail-closed — any error path treats the
  token as invalid (403).

### Email Verification

- 6-digit numeric code, 10-minute TTL.
- Delivered via Clerk backend API (`users/{id}/verification_attempts` or
  the equivalent signup-verification endpoint). Clerk handles SPF/DKIM/
  DMARC and bounces.
- Wrong code counter per signupId: 5 attempts → 10-minute cooldown.
- Resend: 60s cooldown, 5 resends max before signup row is locked.

### Cooldown After Failure

Three failure dimensions get separate cooldowns (stored on the signup row,
not in memory — survives platform restart):

| Counter | Limit | Cooldown | Reset on |
|---|---|---|---|
| `wrong_code_count` | 5 | 10 min | Successful verification |
| `resend_count` | 5 | Row-level lock | New signupId |
| `provision_attempts` | 2 | Row-level fail | New signupId with same email |

### Disposable Email Detection

v1: NOT implemented. Cost / false-positive ratio is poor; Clerk's own signup
flow already refuses the worst offenders. v2 (tracked as follow-up) can wire
in `disposable-email-domains` package or a Cloudflare Email Routing policy.

---

## Quota Policy

### Per-User Limits

| Resource | Limit | Enforcement |
|---|---|---|
| Containers per Clerk userId | 1 | `containers` UNIQUE on `clerk_user_id` (schema-level); orchestrator refuses a second `.provision()` call. |
| Storage (R2) | 10 GB | Soft-enforced in gateway commit path — over-quota = 507 Insufficient Storage. v1 tracks but doesn't block. |
| Files in manifest | 10_000 | Matches existing target in spec 066 — hard-stop at gateway. |
| Installed packages | 50 | Enforced by `packages/gateway/src/packages/installer.ts`. |
| CPU / memory | 50000 CPU quota, 2 GB RAM | Docker-enforced via orchestrator (existing). |
| Inbound API rate (sync) | 200 rps | Existing gateway middleware. |
| Signup rate per user | n/a (1 container ⇒ at most 1 signup) | Enforced by UNIQUE. |

### Billing Integration Hooks

`POST /api/signup` accepts an optional `plan` field (Zod `.enum(["free"])`
for v1). Clerk user metadata carries the plan. When billing lands,
`containers.plan` column + Stripe customer id go on the same row. For v1:

- `plan` defaults to `"free"`.
- Future `plan: "pro"` adds a stripe checkout redirect between
  `POST /api/signup` and `POST /api/signup/verify` — the signup row is
  parked until Stripe fires a `checkout.session.completed` webhook.
- Quotas are keyed off `plan` at enforcement time so upgrades raise
  quotas without needing a data migration.

No billing code ships in v1; the data shape just doesn't foreclose it.

---

## Security Architecture

### Auth Matrix

See the full table under "Platform Endpoint Design → Auth Matrix" above.

### Input Sanitization

- All free-form fields (email, handle, displayName) go through Zod validators
  before touching DB or Clerk.
- Handle is the ONLY value that flows into filesystem paths (container name
  `matrixos-<handle>`, data bind `/data/users/<handle>`) and Postgres database
  identifiers (`matrixos_<handle>`). The regex + `assertSafeDbIdentifier`
  in `orchestrator.ts:79` is the backstop.
- Display name is rendered only in React / CLI output, never in SQL / paths /
  URLs / logs. Log entries use handle, not display name.
- Turnstile token is length-capped (2048) to prevent "megabyte of JSON eaten
  by Zod before rejection" class of DoS.
- Every signup POST route applies Hono `bodyLimit` before `c.req.json()`,
  including `/api/signup`, `/api/signup/verify`, `/api/signup/resend`, and
  `/api/signup/check-handle`.

### Error Handling

- All catches log the real error to stderr with the request id and a short
  tag (`[signup]`, `[verify]`, etc.).
- Response bodies never contain raw Clerk/Turnstile/Postgres messages.
- Error enum is stable and documented (above) — CLI can switch on it without
  regex-parsing message strings.

### CSRF

N/A for the signup endpoints (JSON + Turnstile, no cookie auth). The
eventual web-form frontend will use Clerk session cookies + `same-origin`
fetch from `matrix-os.com`; CSRF handled by Next.js (`proxy.ts` / `cookie-
check`) per existing project conventions.

### Secret Handling

- `TURNSTILE_SECRET_KEY`, `CLERK_SECRET_KEY`, and `PLATFORM_JWT_SECRET` are
  injected as env vars into the platform container, never logged.
- `CLERK_SECRET_KEY` is NOT forwarded into user containers (trusted-sync
  architecture — see `checkHomeMirrorS3Env` in `main.ts:327-354`).
- Email verification codes are stored as bcrypt hashes on the signup row
  (cost 10), not plaintext. Constant-time comparison via `timingSafeEqual`.

### Logging & Observability

- Every signup attempt logs: timestamp, masked email (`h***@example.com`),
  handle, IP (`cf-connecting-ip` only, never the raw `x-forwarded-for`
  chain), outcome, request id.
- Prometheus metrics: `signup_attempts_total{outcome=...}`,
  `signup_duration_ms` histogram, `signup_verification_codes_sent_total`,
  `signup_captcha_failures_total`.
- Alerts wire up on the global rate limiter firing, and on
  `signup_duration_ms{p99}` breaching 60s.

---

## Failure Modes

### Partial Provisioning Rollback

Failure points along the path, with recovery behaviour:

| Step | Failure handling |
|---|---|
| 1. Turnstile verify | Fail → 403. No signup row persisted; caller can retry immediately. |
| 2. Signup row INSERT | Postgres constraint errors → 500. No external side effects. |
| 3. Email send (Clerk backend) | Retry 3× with jitter. If still fails → mark `email_send_failed`, return 502. User can resend. |
| 4. Verify code match | Wrong code → counter increment. Right code → proceed. |
| 5. Clerk user create | If errors → signup row marked `clerk_failed`. User retries with same email. If Clerk says email exists → check whether it maps to an existing `containers` row; if yes, "already signed up"; if no, it's a dangling Clerk user → link instead. |
| 6. Orchestrator provision | If errors: signup row marked `provision_failed`. Clerk user deletion is attempted (best-effort, non-blocking). User can retry, which re-runs from step 5 with a linking branch. |
| 7. Package install | Per-package failure isolated; overall container stays up. `packageStatus: "partial"` or `"failed"` returned to CLI. |

**Cleanup guarantee**: the only resource a failed signup can leave behind is
a dangling Clerk user (if step 5 succeeds but step 6 fails). A reconciler
cron (`packages/platform/src/reconcile-signups.ts`) runs hourly to delete
Clerk users older than 24h with no matching `containers` row. Same cron
deletes `signup` rows past TTL.

### Idempotency

- Same email + same handle + successful signup row already in `ready` state
  → reject with `email_taken` (the UX path is "`matrix login`, not
  `matrix onboard`").
- Same email + `provision_failed` signup row → allow retry, re-drive from
  step 5.
- `signup_id` in the verify/resend endpoints makes those operations
  idempotent on their own.
- Clerk user creation is the only external side effect that's hard to
  rollback; the reconciler handles leftovers.

### Timeouts

Every external call wrapped in `AbortSignal.timeout(...)`:

| Call | Timeout |
|---|---|
| Cloudflare Turnstile verify | 5s |
| Clerk create user | 10s |
| Clerk send verification email | 10s |
| Hetzner container provision | 60s (matches orchestrator's existing internal timeout) |
| R2 presign on first-boot package install | 15s per file |
| Git clone for `installer.type=git` | 60s |
| Whole-signup wall clock | 120s (CLI prints progress; server enforces on verify) |

Every timeout path returns a stable error enum (see response tables) and
logs enough to correlate in Sentry / Grafana.

### Crash Recovery

- Signup row is the single source of truth for in-flight signups. Persisted
  in Postgres with atomic status transitions.
- Platform restart mid-signup: pending rows are reaped or resumed depending
  on status. `provisioning` rows older than 120s are moved to
  `provision_failed`. Users retry.
- Container provisioning uses the orchestrator's existing rollback
  (`orchestrator.ts:281-290`) — on failure it removes the Docker container
  and releases ports in a transaction.
- Package install crash: `~/system/packages.json` is atomic-write; gateway
  restart picks up `pending` entries and retries.

### Concurrent Access

- `POST /api/signup` for the same email from two clients simultaneously:
  first INSERT wins via a UNIQUE constraint on active signup rows
  (`WHERE status NOT IN ('ready', 'expired')`); second gets `email_taken`.
  Avoids the TOCTOU race of "check-then-insert".
- Handle race: `containers.handle` UNIQUE constraint. `POST /api/signup/
  verify` catches the violation and returns `handle_taken` — the user
  re-runs onboard with a different handle. Rare; `check-handle` eliminates
  most cases.
- Signup row updates use SQL `WHERE status = '<expected>'` guards so two
  verify requests for the same signupId can't both claim the transition.

---

## Integration Wiring

### Files Touched

```
packages/platform/src/signup-routes.ts        # NEW -- POST /api/signup, /verify, /resend, /check-handle
packages/platform/src/signup-store.ts         # NEW -- Drizzle schema + CRUD for signups table
packages/platform/src/signup-email.ts         # NEW -- Clerk backend email integration
packages/platform/src/turnstile.ts            # NEW -- Cloudflare Turnstile verifier
packages/platform/src/reconcile-signups.ts    # NEW -- hourly cron
packages/platform/src/packages-routes.ts      # NEW -- GET /api/packages/catalog
packages/platform/src/main.ts                 # wire signup + packages routes; exempt /api/signup* from container proxy
packages/platform/schema.ts                   # add `signups` table
packages/platform/data/packages/catalog.json  # NEW -- checked-in package catalog
packages/platform/data/reserved-handles.json  # NEW -- checked-in reserved list

packages/gateway/src/packages/installer.ts    # NEW -- first-boot package install
packages/gateway/src/packages/catalog.ts      # NEW -- fetch catalog via platform internal URL
packages/gateway/src/server.ts                # run installer on boot if ~/system/packages.json has pending

packages/sync-client/src/cli/commands/onboard.ts  # NEW -- `matrix onboard` command
packages/sync-client/src/cli/commands/packages.ts # NEW -- `matrix packages install/list/remove`
packages/sync-client/src/cli/commands/login.ts    # update 404 message to mention `matrix onboard`
packages/sync-client/src/signup/                  # NEW -- signup-flow client (POST /api/signup etc.)
packages/sync-client/src/auth/token-store.ts      # reuse -- signup verify returns a Sync JWT

tests/platform/signup-routes.test.ts          # NEW
tests/platform/signup-store.test.ts           # NEW
tests/platform/turnstile.test.ts              # NEW
tests/platform/reconcile-signups.test.ts      # NEW
tests/gateway/packages-installer.test.ts      # NEW
tests/sync-client/onboard.test.ts             # NEW
tests/integration/signup-e2e.test.ts          # NEW -- end-to-end (Clerk test mode)

www/content/docs/cli/onboard.mdx              # NEW -- public docs
www/content/docs/cli/packages.mdx             # NEW -- public docs
```

### Startup Sequence

In `packages/platform/src/main.ts`, after the existing orchestrator + auth
routes wire-up:

1. Construct `createSignupStore({ db })` (Drizzle).
2. Construct `createTurnstileClient({ secret: env.TURNSTILE_SECRET_KEY })`.
3. Construct `createSignupEmail({ clerkBackend })` using the existing Clerk
   `@clerk/backend` import.
4. Construct `createSignupRoutes({ store, turnstile, email, orchestrator,
   platformJwtSecret })`, and have the route module apply `bodyLimit` to
   `/api/signup`, `/api/signup/verify`, `/api/signup/resend`, and
   `/api/signup/check-handle` before reading JSON.
5. Mount at `app.route('/', createSignupRoutes(...))` BEFORE the
   `app.use('*', app-domain proxy)` middleware so `/api/signup*` and
   `/api/packages/catalog` never get dispatched into a user container.
6. Start `createSignupReconciler({ store, clerkBackend, orchestrator })`
   on a 1h timer (`node-cron`, same pattern as
   `packages/platform/src/lifecycle.ts`).

### Container Proxy Exemption

The existing exemption in `main.ts:438-453` gets a new branch:

```typescript
if (
  reqPath === '/auth/device' ||
  reqPath.startsWith('/auth/device/') ||
  reqPath.startsWith('/api/auth/device/') ||
  reqPath.startsWith('/api/signup') ||         // NEW
  reqPath === '/api/packages/catalog'          // NEW
) {
  return next();
}
```

### Cross-Package Communication

- Platform → orchestrator: direct function call (`orchestrator.provision(...)`),
  same pattern as existing `/containers/provision` admin route.
- Platform → gateway: no direct link. Gateway reads its own
  `~/system/packages.json` on boot and self-drives. The platform emits the
  initial `packages.json` by SSH-ing the file into the container's volume
  during provisioning (reuse of existing home-seed path in
  `home-mirror.ts`). No new RPC surface.
- Platform's `reconcileSignups` calls Clerk backend directly via the already-
  configured `@clerk/backend` client.

### CLI → Platform

- `matrix onboard` uses the shared fetch helper from
  `packages/sync-client/src/lib/http.ts` (create if not already there).
  All calls: `AbortSignal.timeout(...)`, bearer auth is NOT set (signup is
  public).
- After verify succeeds, signup returns a Sync JWT in the same shape as the
  device-flow token — so `saveAuth({accessToken, expiresAt, userId, handle})`
  (already in `packages/sync-client/src/auth/token-store.ts`) works
  unchanged. `saveConfig({...})` writes `gatewayUrl` from the verify
  response.
- Device flow's `login()` function in `packages/sync-client/src/auth/
  oauth.ts` stays unchanged — signup is parallel, not a replacement.

### Existing Code Touchpoints (exact lines)

- `packages/platform/src/main.ts:438-453` — add signup exemption.
- `packages/platform/src/main.ts:626-641` — existing extraEnv pattern we
  mirror when wiring `TURNSTILE_SECRET_KEY`.
- `packages/platform/src/auth-routes.ts:37-63` — rate limiter pattern reused.
- `packages/platform/src/orchestrator.ts:225-296` — `provision()` consumed
  as-is.
- `packages/sync-client/src/cli/commands/login.ts:96-108` — update "no
  account" message to mention `matrix onboard`.

---

## Data Model

Single new table, lives in the platform SQLite DB (migration in
`packages/platform/src/schema.ts`).

```typescript
// schema.ts
export const signups = sqliteTable('signups', {
  signupId: text('signup_id').primaryKey(),           // "su_<24 chars>"
  email: text('email').notNull(),                     // lowercase
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  packages: text('packages', { mode: 'json' }).$type<string[]>().notNull(),
  codeHash: text('code_hash').notNull(),              // bcrypt
  codeExpiresAt: integer('code_expires_at').notNull(),
  wrongCodeCount: integer('wrong_code_count').notNull().default(0),
  resendCount: integer('resend_count').notNull().default(0),
  provisionAttempts: integer('provision_attempts').notNull().default(0),
  status: text('status').notNull().$type<
    | 'pending'
    | 'email_sent'
    | 'email_verified'
    | 'clerk_created'
    | 'provisioning'
    | 'provision_failed'
    | 'ready'
    | 'ready_no_packages'
    | 'expired'
  >().default('pending'),
  clerkUserId: text('clerk_user_id'),                 // populated after step 5
  clientIp: text('client_ip').notNull(),
  clientId: text('client_id').notNull(),              // CLI user-agent
  turnstileOk: integer('turnstile_ok', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  expiresAt: integer('expires_at').notNull(),         // 24h after createdAt
});

// indexes: (email WHERE status NOT IN ('ready', 'expired')), (expires_at), (handle WHERE status != 'expired')
```

TTL sweeper: `reconcile-signups.ts` deletes rows past `expiresAt`, deletes
dangling Clerk users for rows that errored, and flags `provisioning` rows
older than 120s as `provision_failed`.

---

## Testing Strategy

Per the constitution (Principle IX — TDD is non-negotiable).

### Unit

- `signup-store.test.ts` — Drizzle CRUD + atomic status transitions.
- `turnstile.test.ts` — mock Cloudflare responses, assert fail-closed.
- `reserved-handles.test.ts` — loads the JSON, asserts each slug passes
  handle regex, asserts no collisions with existing `containers` records.
- `packages/gateway/packages-installer.test.ts` — mock catalog, verify
  atomic manifest updates, verify `pending → installed/failed` transitions.
- `packages/sync-client/signup.test.ts` — CLI fetch helper + state machine.

### Integration

- `tests/integration/signup-e2e.test.ts` — against a real Clerk test tenant
  (cost-controlled, runs on `NODE_ENV=test` with `SIGNUP_TEST_MODE=true`
  and seeded Turnstile). Uses Haiku for any agent-spawned steps. Full path:
  `POST /api/signup` → inspect signup row → `POST /api/signup/verify` with
  the right code → `GET /api/me` with the returned JWT returns the expected
  handle + gatewayUrl. Budget ≤ $0.10 per run.
- `tests/integration/signup-idempotency.test.ts` — retry same email after
  `provision_failed`, assert single final container.

### Manual Docker Verification

`specs/067-cli-signup/quickstart.md` (to be written alongside `plan.md`)
enumerates the manual test matrix:

1. Fresh Clerk tenant, `matrix onboard` interactive, all defaults.
2. Interactive with handle collision (pre-create `@taken`).
3. Non-interactive `matrix onboard --email ...`.
4. Verify CLI handles each error code from the enum.
5. Platform restart mid-signup — pending signup reaped cleanly.
6. Clerk outage simulation — 502 + signup row retains state for retry.
7. Package install partial failure — container usable, CLI reports
   `packageStatus: "partial"`.

### Security

- Signup routes in `tests/platform/signup-routes.test.ts` assert every
  error path returns only enum strings, never raw exception messages
  (regex scans response bodies for `Postgres|Clerk|at /home|stack`).
- Reserved-handles list round-trip test.

---

## Open Questions

1. **Password vs Clerk-hosted?** For v1 we use Clerk-hosted: `POST /api/
   signup` kicks off the Clerk signup via the backend API, and Clerk
   manages the password + session. The CLI never touches password
   material. Is there a future need to support passwordless-only (passkey)
   signup from CLI? — defer.
2. **Do we hold the `handle` during email verification?** A malicious user
   could burn through a popular handle by starting signups and never
   verifying. Decision for v1: YES, we reserve the handle from the
   successful signup-row insert until `expiresAt` or explicit expiry. This
   means a 24h reservation window per attempt; combined with per-email and
   per-IP rate limits, the practical window is small.
3. **Package catalog hosting.** Start checked-in JSON at `packages/
   platform/data/packages/catalog.json`. Follow-up: move to a versioned
   registry with its own review process when external contributors start
   publishing. Tracked as follow-up, not a v1 blocker.
4. **Email deliverability.** Clerk's default transactional email is fine
   for `@matrix-os.com` sender? Need to verify SPF/DKIM for the handoff.
   Action item during `plan.md` / spike phase.

---

## Rollout & Deploy

This is a single-PR spec (no phased rollout needed — signup is additive, not
a migration). Deploy steps mirror the PR 1 pattern from the 066 deployment
plan.

1. Merge PR. Tag `v0.5.0-rc1`.
2. On VPS: `git fetch --tags && git checkout v0.5.0-rc1`.
3. Add to `.env`:
   ```
   TURNSTILE_SITE_KEY=0x4...
   TURNSTILE_SECRET_KEY=0x4...
   SIGNUP_EMAIL_FROM=noreply@matrix-os.com
   ```
4. Rebuild platform: `docker compose -f distro/docker-compose.platform.yml
   --env-file .env up -d --build platform`.
5. Smoke-test the endpoints (see `quickstart.md`).
6. Announce `matrix onboard` in the release notes. Link to
   `docs/cli/onboard`.

Rollback: revert the platform image, leave the signup table in place
(read-only legacy). No data migration to undo. Signup rows past TTL clean
themselves up.

---

## Success Criteria

- `matrix onboard` on a clean macOS 14+ install, no prior Matrix account,
  completes in ≤ 60s wall clock (p95) and ends with a working `matrix sync`
  session.
- Non-interactive `matrix onboard --email ... --handle ... --packages ...`
  works from a shell script with verifiable exit codes.
- No `signup_captcha_failures_total` above 20% for a rolling 1h window in
  production (if above, Turnstile threshold needs tuning or abuse is
  active).
- 100% unit-test coverage for `signup-routes.ts`, `signup-store.ts`,
  `turnstile.ts`, `reconcile-signups.ts`, `packages/gateway/src/packages/`.
- No signup endpoint returns a raw Clerk / Postgres / Turnstile error
  message — enforced by a response-scanning integration test.
- Reconciler deletes 100% of dangling Clerk users within 1h of creation
  (measured by signup-row audit).

---

## References

- `specs/066-file-sync/deployment-plan.md` — PR 4 scope this spec expands.
- `specs/066-file-sync/spec.md` — auth and JWT contracts reused.
- `specs/012-onboarding/spec.md` — earlier web-only onboarding reference.
- `specs/020-signup-redesign/tasks.md` — parallel web signup UX redesign.
- `specs/025-security/` — defense-in-depth patterns.
- `specs/030-settings/` — future settings surface for plan/quota display.
- `.specify/memory/constitution.md` — Principles I, II, III, VIII, IX.
- `specs/quality-gates.md` — the checklist this spec is written against.
