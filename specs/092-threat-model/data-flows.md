# Matrix OS — Data Flows, Secrets & Privacy

Companion to [`threat-model.md`](./threat-model.md), [`risk-register.md`](./risk-register.md),
and [`findings.md`](./findings.md). Re-verified against `main` @ `205a8bb0b`.

## Data inventory

| Data | Where it lives | Owner | Sensitivity | Crosses |
|---|---|---|---|---|
| Identity / handle / Clerk user | Platform Postgres | Platform | high | TB-1, TB-2 |
| Billing / Stripe customer | Platform Postgres + Stripe | Platform | high | TB-1 |
| VPS registry, machine state | Platform Postgres | Platform | medium | TB-2 |
| Social posts / follows / likes | Platform + per-VPS Postgres | User | medium | TB-1, TB-3 |
| Store app metadata | Platform Postgres | Author | medium | TB-1 |
| Per-app application data | Per-app Postgres schema (on VPS) | User | high | TB-4 |
| App KV blobs | KV store (on VPS) | User | high | TB-4 |
| Owner files / home | VPS filesystem (`$MATRIX_HOME`) | User | high | TB-3, TB-6 |
| Synced file backups | R2 bucket `matrixos-sync/{userId}/` | User | high | TB-7 |
| Conversations / memory / SOUL | VPS filesystem | User | high | TB-5, TB-6 |
| Connected-integration tokens | Platform-owned (proxied) | User | high | TB-5, TB-6 |
| Secrets (API keys, DB pw, R2) | VPS env + config files | Platform/User | critical | TB-2, TB-6, TB-7 |

## Cross-boundary flow map

```
Sign-up ─▶ Platform (Clerk) ─▶ provision VPS (cloud-init carries secrets, F15)
                  │
   social/store ──┤ now bearer-gated at main.ts:3374 (F1/F2 ↓), but body-supplied
                  │ identity remains; gate is mount-order dependent (N1)
                  │
Owner ─▶ shell ─▶ Gateway ─▶ per-app Postgres / KV
                  │              ▲
   sandboxed app ─┘              └─ app names target via body.app, forwarded
                  │                 verbatim by the relay (F3, still open)
                  │
External msg ─▶ Kernel (bypassPermissions, F5) ─▶ tools ─▶ paid APIs / cron / files
                  │
VPS ─▶ R2 (presign prefix-scoped ✓, but shared standing full-bucket key, F4)
        ▲
        └─ sync engine; .env* / credentials.json not excluded from defaults (F7)
```

## Secrets inventory

| Secret | Issued by | Lands on | At-rest | Scope | Risk |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` / proxy key | Platform (per-handle HMAC) | VPS env | env `0640` | per-user | ok |
| Postgres tenant password | Platform (HMAC) | VPS env + `credentials.json` | env `0640`; **`credentials.json` `0644`** | per-user | **F7** |
| R2 access key / secret | Platform | every VPS | env `0640` | **full bucket, shared** | **F4** |
| Platform verification token | Platform (HMAC handle) | VPS env | env `0640` | per-user | ok |
| Registration token | Platform | VPS (ephemeral) | env `0640` | per-VPS, ~15 min TTL | F11 ↓ |
| Stripe secret / webhook secret | Platform | Platform only | GCP Secret Mgr | platform | ok |
| Clerk secret | Platform | Platform only | GCP Secret Mgr | platform | ok |
| Platform secret (admin bearer) | Platform | Platform + shell proxy | env / GCP | platform | gates social/store (N1) |

Distribution gap: per-VPS secrets ride **cloud-init user-data**, which the cloud
provider may retain or log; redaction is applied to *our* logs only (**F15**). The
on-box env files themselves are `0640` (root:matrix) — the gap is the provider side
and the `0644` `credentials.json` written separately by `postgres-manager.ts`.

## Privacy notes (data-ownership lens)

Matrix OS's pitch is "data belongs to its owner." The flows that undercut that,
ranked by how sharply they violate it:

- **Cross-tenant exposure (sharpest)** — the shared R2 key (**F4**) means one user's
  compromised box can read another user's backups. The only finding that breaks
  ownership *across users*.
- **Linkability / unauthorized read across apps** — one installed app reading every
  other app's data on the box (**F3**) breaks per-app ownership within a single user.
  Now the top live finding after the platform refactor.
- **Identity spoofing** — social/store actions attributed to users who never made
  them (**F1/F2**) is an integrity-of-identity problem; now gated behind the admin
  secret rather than open to the internet, but the body-trust pattern persists.
- **Secret leakage to third parties** — secrets in cloud-init (**F15**) and `.env*`
  syncing to R2 (**F7**) move owner/platform secrets to places the owner didn't choose.
- **Provider trust** — conversations, memory, and prompts flow to Anthropic by
  design; in scope to disclose to users, out of scope as an attacker in this model.

What protects ownership today: per-tenant Postgres *databases* (real isolation),
presign prefix-scoping on the normal sync path, the iframe sandbox keeping app code
off the shell origin, and — new — the bearer gate that closed public social/store
writes. The gaps above are where the guarantee still leaks.
