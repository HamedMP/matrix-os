# Operational Security — for every engineer and contributor

Read this once before you touch a secret, a deploy, or a customer VPS. It's short on
purpose. If you only remember one section, remember the Seven Rules.

Companion: [open-source-boundary.md](./open-source-boundary.md) (what's public vs
private). Architecture risk: `specs/092-threat-model/`.

---

## The Seven Rules

1. **Never commit a secret.** `.env` is gitignored — keep it that way. Edit
   `.env.example` with placeholders only. If you think you might have committed one,
   assume you did and rotate it (see [Incident response](#incident-response)).
2. **Run secret scanning before you push.** Install the pre-commit hook
   ([setup below](#pre-commit-secret-scanning)). CI scans too, but the hook saves you
   from a force-push-history cleanup.
3. **MFA on every account, hardware key or TOTP — never SMS.** GitHub, Clerk, Stripe,
   Hetzner, Cloudflare, GCP, Vercel, Neon, PostHog, Pipedream. No exceptions for
   "just my dev account."
4. **Least privilege, and separate dev from prod.** Use test-mode keys locally
   (`pk_test_`, `sk_test_`, Stripe test mode, a Neon dev branch). Never pull a
   production secret onto your laptop.
5. **Secrets live in exactly four places.** GCP Secret Manager (platform prod),
   Vercel env (matrix-os-site/shell), per-VPS `0640` env files (customer runtime), local `.env`
   (dev only). **Not** Slack, not a ticket, not a screenshot, not a code comment, not
   an AI chat. If a secret has been pasted into any of those, it's burned — rotate it.
6. **Rotate on exposure, immediately.** A leaked key is leaked the instant it leaves
   the four places above. Revoke first, ask questions after.
7. **External contributors get zero secret access.** Their PRs run CI without secrets
   (`pull_request`, not `pull_request_target`). Preview environments never receive
   production credentials. Don't paste a secret to "help someone debug."

---

## Contributor trust tiers

| Tier | Who | Access | Rules |
|---|---|---|---|
| **External contributor** | Anyone with a fork | None. CI runs on PRs with no secrets exposed. | Fork + PR. Can't see prod, can't trigger a deploy. Never given a credential to "test with." |
| **Core maintainer** | Trusted committers | GCP Secret Manager, Vercel env, Hetzner, Cloudflare, Neon, Stripe/Clerk dashboards | MFA mandatory. Least-privilege roles. Separate dev creds. Offboard = revoke same day. |

The line that protects everyone: **CI on an external PR must never have access to a
production secret.** `pull_request_target` + checking out PR code is the classic way
to leak one — we don't do that (see the threat model's CI sweep).

---

## Secrets inventory

Where each secret type lives and who holds it. "Burned if seen in" = the places that
mean immediate rotation.

| Secret | Belongs in | Scope | Burned if seen in |
|---|---|---|---|
| `ANTHROPIC_API_KEY` / AI provider keys (Gemini, OpenAI, Brave, Perplexity, ElevenLabs) | Secret Manager / per-VPS env / dev `.env` | per-deployment | git, logs, chat |
| `CLERK_SECRET_KEY` | Secret Manager / Vercel | platform | git, browser, client bundle |
| Stripe secret + webhook secret | Secret Manager | platform | git, logs, client |
| `PIPEDREAM_CLIENT_SECRET` + webhook secret | Secret Manager (**platform only**) | platform | **any customer VPS**, git |
| `HETZNER_API_TOKEN` | Secret Manager | customer-VPS project (not control-plane) | git, customer VPS |
| R2 access key / secret | Secret Manager / per-VPS env | **currently full-bucket, shared (F4)** | git, public |
| `PLATFORM_SECRET` (admin bearer) | Secret Manager | platform | git, client, logs |
| `DATABASE_URL` / `PLATFORM_DATABASE_URL` (Neon) | Secret Manager / Vercel | platform | git, logs, error traces |
| JWT/HMAC seeds, `MATRIX_AUTH_TOKEN`, Matrix appservice tokens | Secret Manager / per-VPS env | per-deployment | git, logs |
| PostHog **project** token (`NEXT_PUBLIC_POSTHOG_KEY`) | Vercel / build env | **publishable** (ships to browser by design) | — (not a secret) |
| PostHog **personal API** key | Secret Manager / personal | account | git, chat |

Note the two PostHog keys are different: the `NEXT_PUBLIC_` project token is *meant*
to be public (it's in the browser bundle); the personal API key is a real secret.
Same shape as Clerk's publishable vs secret key.

---

## Per-tool quick reference

Each tool: the one rule that matters most, where the secret lives, and rotation.

### GitHub (the foundation)
- **Org-wide:** require 2FA for all members; enable secret scanning + push protection;
  branch protection on `main` (no direct pushes — already a hard rule); `CODEOWNERS`
  on `.github/workflows/`, `distro/`, `packages/platform/` so infra/auth changes get a
  maintainer review.
- **Actions:** secrets are repo/environment-scoped; never `echo` one; prefer OIDC over
  stored cloud keys (we already do this for GCP).
- **Rotate:** revoke a leaked PAT in Settings → Developer settings; rotate Actions
  secrets in repo Settings → Secrets.

### Clerk (auth)
- **Rule:** `pk_*` publishable key is public; `sk_*` secret key is server-only. **Never
  ship a bundle built with the example key** — CI already rejects
  `pk_test_Y2xlcmsuZXhhbXBsZS5jb20k` (the `clerk.example.com` placeholder). Keep that gate.
- **Lives:** Secret Manager + Vercel. Test instance keys for dev, live for prod.
- **Rotate:** Clerk dashboard → API keys → roll. Rolling the secret key invalidates
  server sessions briefly.

### Stripe (billing)
- **Rule:** use **test mode** locally; use **restricted keys** (only the scopes you
  need) over the full secret where possible. Webhook secret verifies signatures — never
  skip verification (we don't).
- **Lives:** Secret Manager. `sk_test_` dev, `sk_live_` prod.
- **Rotate:** dashboard → Developers → API keys → roll; re-issue webhook signing secret
  and update Secret Manager together.

### Hetzner (customer VPS)
- **Rule (already documented in `.env.example`):** the API token must belong to the
  **customer-VPS project, NOT the control-plane project**, and the SSH key name must
  exist in that same project. This blast-radius separation is a good existing practice —
  preserve it.
- **Lives:** Secret Manager. One token per project.
- **Rotate:** Hetzner console → Security → API tokens. Rotating means re-provisioning
  capability is briefly down; do it in a window.

### Cloudflare R2 (storage / sync)
- **Rule:** today every VPS holds the **same full-bucket key (finding F4)** — the
  highest-blast item in the threat model. Until that's fixed, treat the R2 key as the
  crown jewel: a single leaked one reads every user's backups. Target state: per-user
  scoped tokens or presign-only (no standing key on the box).
- **Lives:** Secret Manager + per-VPS env (`0640`).
- **Rotate:** Cloudflare dashboard → R2 → Manage API tokens. Rotating the shared key
  means redeploying env to every VPS — another reason to scope it down.

### GCP (Cloud Run + Secret Manager)
- **Rule:** CI authenticates via **Workload Identity Federation (OIDC)** — no
  long-lived service-account JSON keys in GitHub. Keep it that way; never download an SA
  key to a laptop. Platform secrets are fetched at deploy time via `--set-secrets`, not
  baked into images.
- **Lives:** Secret Manager is the source of truth for platform prod.
- **Rotate:** add a new Secret Manager version, redeploy; disable the old version after
  verifying.

### Neon (platform Postgres)
- **Rule:** the connection string **is** the secret — it embeds the password. Keep it
  out of logs and error traces (we already avoid leaking raw DB errors to clients). Use
  a **branch database** for preview/dev, never the prod branch from a laptop. Prefer the
  pooled connection string; enable IP allowlisting if available on the plan.
- **Lives:** Secret Manager / Vercel.
- **Rotate:** Neon console → reset the role password → update `DATABASE_URL` everywhere
  it's referenced.

### PostHog (analytics / error tracking, EU instance)
- **Rule:** the `NEXT_PUBLIC_POSTHOG_KEY` project token is publishable (browser
  bundle) — that's expected. The **personal API key** is the secret. Scrub PII before
  capture; we're on the EU instance (`eu.i.posthog.com`) for data-residency.
- **Rotate:** PostHog → personal API keys for the secret; project tokens rarely rotate.

### Pipedream (integrations)
- **Rule (CLAUDE.md hard rule):** `PIPEDREAM_*` secrets are **platform-owned and must
  NEVER land on a customer VPS.** VPS gateways proxy `/api/integrations*` to
  platform-owned routes using `PLATFORM_INTERNAL_URL` + their existing
  `UPGRADE_TOKEN`/`MATRIX_HANDLE`. Don't break that boundary.
- **Lives:** Secret Manager (platform only).
- **Rotate:** Pipedream dashboard → project settings → rotate client secret + webhook
  secret together.

### Inngest (provisioning workflow, in `matrix-os-site`)
- **Rule:** the signing key + event key authenticate the public site ↔ Inngest channel that
  drives user provisioning. Server-side only; never in the client bundle.
- **Lives:** Vercel env for the private `FinnaAI/matrix-os-site` repository.
- **Rotate:** Inngest dashboard → keys; update Vercel env.

### Vercel (public site / shell hosting)
- **Rule:** set env per environment (Production / Preview / Development). **Preview
  deployments must not get production secrets** — use preview-scoped or test values.
  `NEXT_PUBLIC_*` vars are baked into the client bundle, so only publishable values go
  there.
- **Rotate:** Vercel project → Settings → Environment Variables; redeploy to apply.

### Graphite (`gt`, stacked PRs)
- **Rule:** low risk — it's a GitHub client. The `gt auth` token inherits your GitHub
  permissions, so protect it like a PAT. If `gt` is unauthenticated, treat it as an
  environment blocker for stack work (don't silently fall back to raw git in a way that
  flattens a stack).
- **Rotate:** re-run `gt auth` after rotating the underlying GitHub token.

---

## Pre-commit secret scanning

We don't ship this yet — **add it.** Two layers: local hook (fast, catches it before
push) and CI (catches what slipped through).

**Local (gitleaks):**
```bash
brew install gitleaks            # or: see github.com/gitleaks/gitleaks
# add a pre-commit hook:
cat > .git/hooks/pre-commit <<'EOF'
#!/usr/bin/env bash
gitleaks protect --staged --redact --no-banner || {
  echo "gitleaks: staged changes contain a probable secret. Aborting commit." >&2
  exit 1
}
EOF
chmod +x .git/hooks/pre-commit
```

**CI:** add a `gitleaks` job to the PR workflow (scan the diff, fail on a finding).
This belongs alongside the existing `check:patterns` gate. Until then, the local hook
is the floor.

Also recommended: a `.gitleaks.toml` at the repo root to tune rules and allowlist the
known-safe placeholders in `.env.example` (`sk-ant-...`, `pk_test_xxx`) so the scan
stays zero-noise.

---

## Incident response — a secret leaked

Speed beats blame. Run these in order; don't wait for a meeting.

1. **Revoke** the credential at the provider (links above). This is the only step that
   actually stops the bleeding — do it first, even before you understand the scope.
2. **Rotate** — issue a new one, update the right place (Secret Manager / Vercel / VPS
   env), redeploy.
3. **Scrub history** if it hit git: `git filter-repo` or BFG to remove the blob, then
   force-push. Tell collaborators to re-clone.
4. **Audit the exposure window** — when was it committed/pasted, was the repo public,
   how long was it valid.
5. **Check the provider's audit log** for use you didn't make (Stripe, Clerk, GCP,
   Cloudflare, Hetzner all have one). Assume abuse if the window was non-trivial.
6. **Write it down** — a two-line internal note: what leaked, blast radius, what
   rotated. Feeds the next person's muscle memory.

For the highest-blast secrets — `PLATFORM_SECRET`, the shared R2 key, `DATABASE_URL`,
Hetzner token — treat any suspected leak as confirmed and rotate immediately. The cost
of an unnecessary rotation is minutes; the cost of a real one ignored is every user.

---

## Where this connects

- New endpoint / secret / channel? Update `specs/092-threat-model/` per the model's
  maintenance process, and check this guide covers the new secret.
- Mandatory code patterns (timeouts, no raw error leakage, no secrets to clients) live
  in `CLAUDE.md`. This guide is the *operational* layer; that's the *code* layer.
- Public vs private placement: [open-source-boundary.md](./open-source-boundary.md).
