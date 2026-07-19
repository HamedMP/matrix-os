# Open Source Boundary — what's public, what stays private

Matrix OS is an open-source, self-hostable OS that also provisions real
infrastructure (Hetzner VPSes, Cloudflare R2, a Clerk/Stripe control plane). That
combination makes the public/private line easy to get wrong. This doc draws it once.

## The governing principle: Kerckhoffs

**The system must be secure even if every line of code is public.** If publishing
the repo would break our security, the security was already broken — we'd be relying
on attackers not reading code they can `git clone`. So the rule is not "hide the
risky code." The rule is:

> **Code and configuration structure are public. Secret *values* and tenant *data*
> are private. Nothing in between needs hiding.**

This is also the self-hosting contract: a self-hoster clones the public repo and
brings their own secrets. The OSS boundary and the secrets boundary are the same line.

---

## Tier 1 — Public (the default; all source + structure)

Everything here is safe and *good* to have open. More eyes on the security controls
is a feature, not a risk.

- **All runtime application source** — `packages/kernel`, `packages/gateway`,
  `packages/platform`, `shell/`, `packages/sync-client`. Including the
  provisioning logic, the auth middleware, `path-security.ts`, the SSRF allowlist,
  the bridge relay. These being readable is how bugs get found. The marketing
  and public-docs source deploys from the separate private `FinnaAI/matrix-os-site` repository.
- **cloud-init and deployment templates** — `distro/customer-vps/cloud-init.yaml`,
  host-bin scripts, Dockerfiles. They contain `{{placeholders}}`, not values; secrets
  are injected at render time. The template structure is not sensitive.
- **`.env.example` files** — the env contract. Placeholders only (`sk-ant-...`,
  `pk_test_xxx`). This is documentation.
- **CI/CD workflows** — `.github/workflows/*`. Already public. Keep them free of
  echoed secrets (see opsec guide).
- **The architecture threat model** — `specs/092-threat-model/threat-model.md`,
  `stride-analysis.md`, `data-flows.md`. Publishing a threat model is a credibility
  signal that mature OSS projects (Tailscale, age, SSO projects) routinely send. It
  describes boundaries and the security *model*, not live exploits. **One carve-out
  below.**
- **Specs, ADRs, docs** — the design record. Public.

## Tier 2 — Private (never in git, anywhere)

These are the only things that actually need to be secret.

- **Secret values** — every entry in the [secrets inventory](./security-opsec.md#secrets-inventory):
  Anthropic/Gemini/OpenAI/Brave/Perplexity/ElevenLabs keys, `CLERK_SECRET_KEY`,
  Stripe secret + webhook secret, Pipedream client + webhook secret,
  `HETZNER_API_TOKEN`, R2 access key/secret, GCP service-account keys, Neon/platform
  `DATABASE_URL`, `PLATFORM_SECRET` (the admin bearer), JWT/HMAC seeds, the Matrix
  appservice tokens, `MATRIX_AUTH_TOKEN`. They live in GCP Secret Manager, Vercel
  env, per-VPS `0640` env files, and local `.env` — **and nowhere else.**
- **Tenant / customer data** — platform Postgres contents, R2 bucket contents,
  conversations, anything under a user's `$MATRIX_HOME`. Constitution principle #1.
- **Production access material** — SSH private keys, the SSH key *name* tied to the
  Hetzner project, GCP/Vercel/Cloudflare session tokens.

## Tier 3 — Public, but with judgment (low-value to defenders, free map to attackers)

Not crypto-secret, but no upside to publishing. Keep out of the public repo and
public chat; fine in a private ops doc.

- **Production topology specifics** — the prod server IP, internal hostnames, the
  exact Clerk/Stripe account IDs, the bucket names if they aren't already in templates.
  An attacker doesn't *need* these, but why hand them a target list.
- **Live, unfixed vulnerability detail** — see the carve-out.

### Carve-out: the findings files stay private until fixed

`specs/092-threat-model/findings.md` and `risk-register.md` currently contain
**live, unfixed, exploitable** findings (F3, F4, F5) with copy-pasteable exploit
code. Publishing those today hands every attacker a step-by-step against every
deployed instance — including our own production. Treat them like an embargoed
advisory:

1. Keep `findings.md` + `risk-register.md` **private** (they're untracked today; if
   committed, put them in a private repo or a gitignored path) until the HIGH
   findings are remediated.
2. `threat-model.md` / `stride-analysis.md` can be published now if you want the
   credibility signal — they frame the model without exploit recipes. Scrub the
   inline exploit snippet from the F3 section first.
3. After the HIGH findings ship fixes, publish a sanitized retrospective (what the
   class of bug was, how it's now prevented) and fold the fixed items into the
   "positive controls" list. Responsible disclosure, applied to yourself.

---

## Decision rule for a new file

Ask in order:

1. **Does it contain a secret value or tenant data?** → Tier 2, private.
2. **Is it a live exploit for an unfixed bug?** → Tier 3 carve-out, private until fixed.
3. **Is it a production IP / internal hostname / account ID with no defender value?**
   → Tier 3, keep out of the public repo.
4. **Otherwise** → Tier 1, public. Including code you feel nervous about — nervous
   code is exactly what benefits from review.

If you're unsure, the safe default for *code* is public and for *values* is private.
Never invert that ("I'll keep this code private because it's sensitive") — that's the
Kerckhoffs trap.
