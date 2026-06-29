# Matrix OS — STRIDE Analysis

Companion to [`threat-model.md`](./threat-model.md), [`risk-register.md`](./risk-register.md),
and [`findings.md`](./findings.md). STRIDE per trust boundary, re-verified against
`main` @ `205a8bb0b`. ✅ = control present and holding · ⚠️ = gap (linked to an
F/N number).

DoS / pure resource exhaustion is out of scope per the model; LLM **cost**
amplification (F14) is in scope as financial risk.

## Trust boundaries

- **TB-1** Internet → Platform (matrix-os.com public surface)
- **TB-2** Platform → per-user VPS (provisioning, routing, internal sync)
- **TB-3** Browser/shell → Gateway (owner-authenticated API + WS)
- **TB-4** Sandboxed app (iframe) → Shell relay → Gateway bridge
- **TB-5** External channels / web content → Kernel (prompt-injection surface)
- **TB-6** Kernel/agents → Tools (file, DB, IPC, paid services, cron)
- **TB-7** VPS → shared infrastructure (R2 object storage)

---

## TB-1 — Internet → Platform

| | Status | Notes |
|---|---|---|
| **S**poofing | ✅/⚠️ | The global bearer middleware (`main.ts:3374`) now gates `/api/social`+`/api/store`, closing the unauthenticated impersonation. Residual: handlers still trust `body.authorId`/`x-user-id` (**F1**, **F2**), and the split is mount-order-dependent (**N1**). |
| **T**ampering | ⚠️ | A holder of the platform secret (or a route mounted above the gate) can still mutate/delete others' posts via body-supplied identity (**F1**, **N1**). |
| **R**epudiation | ⚠️ | Actions attributed to a body-supplied `authorId` have no verified actor on those routes. |
| **I**nfo disclosure | ✅/⚠️ | Most routes Clerk-authed; `503` on unset admin secret leaks config state (**N1**). |
| **E**levation | ✅/⚠️ | Internet→act-as-anyone is closed; secret-holder→act-as-anyone remains. |

Holding: Stripe webhook signature + idempotency (`billing-routes.ts`); Clerk auth on
billing/provisioning; device-flow CSRF double-submit; HTML/JS escaping in auth pages
(`auth-pages.ts`); session cookies HttpOnly+Secure+SameSite (`session-cookies.ts`).

## TB-2 — Platform → VPS

| | Status | Notes |
|---|---|---|
| **S**poofing | ✅/⚠️ | Internal sync + provisioning use handle-derived HMAC, timing-safe compare. `/vps/register` now validates the token in the service layer (**F11** downgraded); add a boundary check too. |
| **T**ampering | ⚠️ | Host bundles SHA256-only, hash fetched from the same endpoint; no signature, installs anyway if hash missing (**F10**). |
| **R**epudiation | ✅ | Sync actions resolve to a DB-backed userId from the verified handle. |
| **I**nfo disclosure | ⚠️ | Secrets shipped in cloud-init user-data; provider may log (**F15**). On-box env files are `0640` (ok). |
| **E**levation | ⚠️ | A compromised platform/manifest serves a malicious bundle to every VPS (**F10**). |

Holding: per-tenant Postgres DB + HMAC role password (`orchestrator.ts`); presign
prefix-scoping (`internal-sync-routes.ts`); GCP Secret Manager + bundle/sync bucket
separation (`platform-cloud-run.yml`).

## TB-3 — Shell → Gateway

| | Status | Notes |
|---|---|---|
| **S**poofing | ⚠️ | Identity from `x-platform-user-id`; gateway checks existence, not that the caller is them — relies on proxy hygiene (**F9**). |
| **T**ampering | ✅ | File ops go through realpath + symlink-checked containment; SQL identifiers allowlisted + parameterized. |
| **R**epudiation | ✅/⚠️ | WS tokens in URL query can leak to logs (**F13**, mitigated). |
| **I**nfo disclosure | ✅/⚠️ | Bridge errors sanitized; PTY inherits full env (**F17**). |
| **E**levation | ✅ | Bearer/JWT required on `/api/*`; public exemptions explicit in `auth.ts`. |

Holding: body limits + Zod on mutating routes; `ws-message-schema.ts` validation;
SSRF allowlist on `/api/bridge/proxy`; admin bearer injected only by the shell proxy,
never exposed to app iframes.

## TB-4 — Sandboxed app → Gateway bridge

| | Status | Notes |
|---|---|---|
| **S**poofing | ⚠️ | The relay pins the message *envelope's* `app` to the iframe slug (`AppViewer.tsx:181`) — but the gateway selects the schema from `body.app` inside `init.body`, which the relay forwards verbatim. App forges which app's data it touches (**F3**, still open). |
| **T**ampering | ⚠️ | Same path allows write/delete into another app's tables (**F3**). |
| **R**epudiation | ⚠️ | No per-app provenance on bridge writes. |
| **I**nfo disclosure | ⚠️ | Cross-app read of all tables + KV (**F3**); store apps ship with no review/permission model (**F8**). |
| **E**levation | ✅/⚠️ | `/api/bridge/service` scopes to the owner's connected integrations, but any app can invoke them (no per-app capability gate). |

Holding: iframe sandbox `allow-scripts allow-forms allow-popups` (no
`allow-same-origin`, no top-nav); CSP `connect-src 'self'`; **new** bridge-fetch URL
allowlist (`app-viewer-bridge-policy.ts`) — guards the URL, not `body.app`.

## TB-5 — External channels / web → Kernel

| | Status | Notes |
|---|---|---|
| **S**poofing | ⚠️ | Channel sender identity is informational; all sources collapse to the same full-tool kernel run (**F5**). |
| **T**ampering | ⚠️ | Injection scan logs but does not block; content still runs (**F5**). |
| **R**epudiation | ✅ | Activity log records source/senderId/tools. |
| **I**nfo disclosure | ⚠️ | Injection can read owner data and exfil via `call_service`/paid tools (**F5**). |
| **E**levation | ⚠️ | Untrusted text reaches owner-level tools; `manage_cron` gives persistence that outlives the message (**F5**, **F6**, **F12**). |

Holding: external-content wrapping markers; suspicious-pattern detector (detect-only);
Telegram deny-by-default allowlist; `web_fetch` SSRF guard.

## TB-6 — Kernel/agents → Tools

| | Status | Notes |
|---|---|---|
| **S**poofing | ⚠️ | IPC/MCP server has no per-caller auth; any sub-agent calls any tool (**F12**). |
| **T**ampering | ⚠️ | File-protection hook matches `Write|Edit` only; `Bash` bypasses it (**F6**); `tool-deny.ts` dead, approval hook unwired. |
| **R**epudiation | ✅/⚠️ | Tool calls logged, but caller role is not enforced. |
| **I**nfo disclosure | ⚠️ | PTY inherits full `process.env` incl. secrets (**F17**). |
| **cost** | ⚠️ | Paid tools (`generate_image`/`speak`) have no per-source quota (**F14**). |
| **E**levation | ⚠️ | `bypassPermissions` global; no `disallowedTools` per source (**F5**). |

Holding: dangerous-command Bash patterns blocked (`rm -rf`, `mkfs`, `dd`); system-path
write block; zellij env allowlist + KDL escaping; approval-hook scaffold exists (unwired).

## TB-7 — VPS → R2

| | Status | Notes |
|---|---|---|
| **S**poofing | ✅ | Presigned URLs scoped to `matrixos-sync/{userId}/` and validated before issue. |
| **T**ampering | ⚠️ | Standing full-bucket credential on every VPS bypasses presign scoping (**F4**). |
| **I**nfo disclosure | ⚠️ | A popped VPS reads every user's synced files via the shared key (**F4**); `.env*` not excluded from sync defaults can push secrets up (**F7**). |
| **E**levation | ⚠️ | Single-VPS compromise → cross-tenant data access through shared creds (**F4**). |

Holding: presign prefix validation (`keyAllowedForUser`); sync/bundle bucket isolation
checked in CI; immutable release objects.

---

## Control-coverage summary

| Boundary | Spoof | Tamper | Repud | Info | Elev | Worst gap |
|---|---|---|---|---|---|---|
| TB-1 Internet→Platform | ✅/⚠️ | ⚠️ | ⚠️ | ✅/⚠️ | ✅/⚠️ | F1/F2 + N1 (MED, was CRIT) |
| TB-2 Platform→VPS | ✅/⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | F10, F15 |
| TB-3 Shell→Gateway | ⚠️ | ✅ | ✅/⚠️ | ✅/⚠️ | ✅ | F9, F17 |
| TB-4 App→Bridge | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅/⚠️ | **F3 (HIGH, top live)** |
| TB-5 External→Kernel | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | **F5 (HIGH)** |
| TB-6 Kernel→Tools | ⚠️ | ⚠️ | ✅/⚠️ | ⚠️ | ⚠️ | F6, F12, F14 |
| TB-7 VPS→R2 | ✅ | ⚠️ | — | ⚠️ | ⚠️ | **F4 (HIGH, top blast)** |

The repeated signature across boundaries: **authorization is taken on the caller's
word** — identity from a body field (`authorId`, `body.app`) or an unverified header
(`x-platform-user-id`) — while the cryptographic and filesystem controls are solid.
The platform refactor fixed the worst instance (internet-facing social/store) but
left the same pattern intact at the app bridge (TB-4) and the header trust (TB-3).
