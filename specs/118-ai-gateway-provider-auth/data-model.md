# Data Model: Matrix-Funded AI and Provider Accounts

**Date**: 2026-08-29

This feature has three distinct sources of truth:

1. owner-runtime provider connections and Chat bindings belong to the owner;
2. Matrix-funded eligibility, runtime identity, and later billing records belong to the platform control plane;
3. model/provider metadata is validated configuration with a bundled fallback, not user data.

The first funded release does not require usage tables. The schemas below define the stable boundary and the later additive persistence needed for allowances and add-ons.

## Product Terms and Contract Names

The product vocabulary is intentionally more precise than the legacy contract
names:

| Product term | Contract representation | Meaning |
|---|---|---|
| Harness | `ProviderDriver` plus one or more `ProviderInstance` records | Executable agent runtime and its runnable configurations |
| Model provider | `ModelDescriptor.vendor` plus route/access policy | Inference service that serves the selected model |
| Account | `ProviderAccount` | Owner-scoped authenticated identity or API-key profile |
| Access source | `AiAccessSource` | Exact credential and funding path used by one run |

Do not merge these entities because they can change independently. Installing a
harness does not authenticate an account; a Matrix-funded access source does not
connect an Anthropic account; changing a model provider does not replace the
selected account silently.

## Canonical Concepts

### ProviderDriver

Internal definition of an execution harness or transport implementation.

| Field | Type | Rules |
|---|---|---|
| `id` | bounded slug | Stable, e.g. `kernel`, `claude_code`, `codex`, `opencode`, `pi`, later `acp` |
| `displayName` | bounded string | User-facing harness name |
| `kind` | enum | `agent_sdk`, `cli`, `acp`, `openai_compatible` |
| `installState` | enum | `installed`, `missing`, `installing`, `failed`, `unknown` |
| `health` | enum | `ready`, `degraded`, `stopped`, `unavailable`, `unknown` |
| `capabilities` | bounded set | Tool use, resume, subagents, vision, reasoning, cancellation, project context |
| `setupActions` | bounded set | `install`, `connect_account`, `enter_api_key`, `open_terminal`, `retry` |

Drivers are registered in code. They are never created from untrusted remote catalog data.

### ProviderInstance

A concrete runnable harness configuration that can execute a Chat turn.

| Field | Type | Rules |
|---|---|---|
| `id` | UUID or stable local ID | Persisted Chat binding |
| `driverId` | ProviderDriver ID | Required |
| `vendor` | enum/bounded slug | `anthropic`, `openrouter`, `openai`, `baseten`, etc. |
| `accountId` | optional ProviderAccount ID | Selected owner account; null for Matrix-funded access |
| `accessSourceId` | AiAccessSource ID | Required |
| `label` | bounded string | Safe user label; no secret fragments |
| `capabilitySnapshot` | validated object | Bounded and versioned |
| `modelCatalogVersion` | bounded string | Last catalog applied |
| `readiness` | ProviderReadiness | Derived; not a second secret source of truth |

An existing Chat remains bound to its provider instance ID until the user changes it explicitly.
Multiple accounts for one model provider are represented as distinct
`ProviderAccount` records. Adding one never overwrites another. A runnable
instance selects exactly one account or one Matrix-funded access source so
billing authority is visible and deterministic.

### ProviderAccount

An owner-scoped connection to an external provider.

| Field | Type | Rules |
|---|---|---|
| `id` | UUID | Owner-generated |
| `ownerId` | owner principal | Derived from authenticated runtime, never browser-selected |
| `vendor` | enum/bounded slug | Initially `anthropic` or `openrouter` |
| `authMethod` | enum | `provider_profile`, `api_key`, `oauth_pkce` |
| `secretRef` | opaque local reference | Never returned to clients |
| `accountLabel` | optional bounded string | Provider-supplied safe label; no token/key suffix |
| `state` | enum | `unverified`, `ready`, `invalid`, `expired`, `unavailable`, `disconnected` |
| `verifiedAt` | timestamp/null | Last successful bounded probe |
| `lastCheckedAt` | timestamp/null | Last attempted probe |
| `failureClass` | safe enum/null | `auth`, `timeout`, `rate_limited`, `provider_unavailable`, `local_config`, `unknown` |
| `revision` | non-negative integer | Optimistic update guard |
| `createdAt` / `updatedAt` | timestamp | Required |

The initial owner-runtime implementation may adapt existing provider-native files and `system/config.json` behind a `ProviderCredentialStore`. New secret material must be stored in an owner-controlled, export-denied file with mode `0600`, symlink-safe path resolution, bounded size, and atomic replacement. The API exposes only `secretRef`-free projections. A later migration can move existing plaintext API-key config without changing the public contract.

### AiAccessSource

Describes who supplies credentials and who is billed.

| Field | Type | Rules |
|---|---|---|
| `id` | stable slug | Examples: `matrix_included`, `owner_anthropic_profile`, `owner_anthropic_key`, `owner_openrouter` |
| `fundingKind` | enum | `matrix_included`, `owner_account`, `owner_api_key`, later `matrix_addon` |
| `vendor` | bounded slug | Expected model API vendor |
| `accountId` | optional UUID | Required for owner account sources |
| `state` | enum | `ready`, `setup_required`, `auth_required`, `invalid`, `unavailable`, `disabled`, `stale`, `unknown` |
| `eligibleModels` | bounded model ID set | Derived from policy + provider catalog |
| `precedence` | integer | Used only for an explicit `auto` selection; UI shows the selected result |
| `policyVersion` | bounded string | Funded policy/catalog version |

Matrix-funded access is an access source, not an Anthropic login. This distinction prevents the current false-ready state.

For a Matrix-funded source, `state = "ready"` is valid only when both of these
inputs are fresh and ready:

- an explicit Matrix policy authorizes the derived owner/runtime for at least
  one eligible model; and
- a bounded Matrix relay health projection says the funded route can admit
  work.

Configuration presence, a legacy platform API key, Cloudflare gateway setup, or
a previous successful request is insufficient. Missing/stale inputs fail closed.

### ModelDescriptor

| Field | Type | Rules |
|---|---|---|
| `id` | canonical bounded string | Persisted stable ID |
| `vendor` | bounded slug | Required |
| `displayName` | bounded string | Required |
| `status` | enum | `current`, `legacy`, `preview`, `retired`, `unavailable` |
| `capabilities` | bounded set | Context/output limits, tools, vision, reasoning, etc. |
| `effortControls` | bounded set | Only controls accepted by this model/transport |
| `accessEligibility` | bounded set | Which access-source classes may use it |
| `dataPolicies` | bounded object array | One route/disclosure key per eligible access source, so Matrix-relay and owner-direct paths remain distinct |
| `aliases` | bounded array | Compatibility only; never ambiguous |
| `catalogVersion` | bounded string | Required |

Remote catalog input is signed or platform-authenticated, validated with Zod, capped in bytes and entry count, written atomically as last-known-good cache, and falls back to the bundled catalog. It cannot add drivers or arbitrary URLs.

### ProviderReadiness

The single projection consumed by Settings and Chat.

```ts
type ProviderReadiness = {
  state:
    | "ready"
    | "setup_required"
    | "auth_required"
    | "invalid"
    | "expired"
    | "unavailable"
    | "disabled"
    | "stale"
    | "unknown";
  checkedAt: string | null;
  staleAfter: string | null;
  action: "none" | "connect" | "enter_api_key" | "open_terminal" | "retry" | "contact_owner";
  safeReason: "auth" | "timeout" | "rate_limited" | "provider_unavailable" | "policy" | "unknown" | null;
};
```

The service may cache a health result briefly, but a cache entry has a TTL, global cap, LRU eviction, and shutdown drain. A timed-out check produces `stale` or `unavailable`; it does not erase a known account.

### ProviderSettingsUsageProjection (later additive view)

Usage is a bounded view with explicit authority; it is not inferred from local
Chat token totals:

| Field | Type | Rules |
|---|---|---|
| `source` | enum | `matrix_ledger`, `provider_balance`, `provider_allowance`, `matrix_observed`, `unavailable` |
| `state` | enum | `current`, `stale`, `unavailable`, `not_applicable` |
| `usedMicrousd` | non-negative integer/null | Exact only for reconciled Matrix ledger/provider data |
| `remainingMicrousd` | non-negative integer/null | Never synthesized from subscription allowance or local token counts |
| `allowancePercent` | bounded number/null | Provider-reported subscription allowance only |
| `resetsAt` | timestamp/null | Provider-reported or Matrix entitlement period |
| `asOf` | timestamp/null | Required for current/stale numeric values |
| `scope` | enum | `account`, `access_source`, `owner_entitlement` |

The V3 Settings foundation can render `unavailable` before this view ships. It
must not display mocked credit as product state. Matrix add-on and included
credit use `matrix_ledger`; Cloudflare balance/spend remains operator telemetry,
not a customer balance.

### ConnectionAttempt

Short-lived owner-runtime state for browser or CLI-backed login.

| Field | Type | Rules |
|---|---|---|
| `id` | random UUID | Public correlation ID |
| `ownerId` | owner principal | Bound at creation |
| `vendor` | enum | `anthropic` or `openrouter` |
| `method` | enum | `oauth_pkce`, `provider_cli` |
| `stateHash` | digest | Store digest, compare constant-time |
| `pkceVerifier` | secret | Never returned after creation |
| `redirectUri` | allowlisted URI | Server-selected |
| `status` | enum | `pending`, `authorized`, `exchanging`, `succeeded`, `denied`, `expired`, `failed` |
| `expiresAt` | timestamp | Maximum 10 minutes unless provider requires less |
| `consumedAt` | timestamp/null | Enforces one-time callback |
| `safeFailure` | enum/null | No raw provider error |

Initial storage can be a bounded in-memory registry because attempts are ephemeral. It must cap total and per-owner attempts, evict expired entries on access and a recurring timer, reject duplicate completion idempotently, and clear secrets/timers on shutdown. If multi-instance gateway routing makes local affinity unreliable, move attempts to owner Postgres with a unique state digest and conditional update.

## Funded Relay Request Identity

### RuntimeServiceCredential

Issued or derived by the platform for one owner runtime; it is not the upstream provider key.

| Claim | Rules |
|---|---|
| `subject` | Stable runtime ID |
| `ownerId` | Platform-derived user/owner ID |
| `audience` | Exact funded-relay audience |
| `scope` | `ai:invoke` only |
| `issuedAt` / `expiresAt` | Short-lived when token refresh is available; otherwise independently revocable |
| `keyId` / `tokenId` | Rotation and revocation metadata |

The relay ignores any browser-supplied owner/runtime headers and derives Cloudflare custom metadata from this verified credential plus a server-generated run ID.

### AiGatewayRequestIdentity

Ephemeral request context:

| Field | Source |
|---|---|
| `requestId` | Relay-generated UUID |
| `ownerId` | Verified runtime credential |
| `runtimeId` | Verified runtime credential |
| `runId` | Validated bounded header from trusted gateway or relay-generated |
| `accessSource` | Relay policy (`matrix_included`) |
| `requestedModel` | Validated request body |
| `canonicalModel` | Provider response/usage metadata |

No Chat content is persisted at the relay in the first release.

## Later Platform Tables

These tables are intentionally deferred until per-user allowance/add-on work. They use platform Postgres and Kysely migrations.

### `ai_entitlements`

- unique logical key: `(owner_id, entitlement_kind, status)` with an active-scope constraint;
- fields: `id`, `owner_id`, `kind`, `status`, `limit_microusd`, `period_start`, `period_end`, `policy_version`, timestamps, `revision`;
- changes use `WHERE revision = :baseRevision` or a row lock;
- unique-scope creation uses `INSERT ... ON CONFLICT`.

### `ai_spend_reservations`

- fields: `id`, `owner_id`, `entitlement_id`, `request_id`, `estimated_microusd`, `final_microusd`, `status`, `expires_at`, timestamps;
- `request_id` is unique for idempotency;
- reservation and entitlement balance update occur in one transaction with the balance predicate in the write;
- terminal states: `committed`, `released`, `reconciled`, `expired`;
- a recurring bounded reconciliation job releases expired holds and reconciles provider results.

### `ai_usage_records`

- fields: `id`, `request_id`, `owner_id`, `runtime_id`, `access_source`, `requested_model`, `canonical_model`, `provider_class`, input/output/cache token counts, `cost_microusd`, `status`, `provider_request_hash`, timestamps;
- unique `request_id`; insert uses `ON CONFLICT` for retry idempotency;
- stores no prompt, response, tool payload, file path, API key, access token, or raw provider error;
- cost basis is versioned so later pricing corrections are auditable.

### `provider_catalog_releases`

If the catalog is controlled from platform Postgres:

- immutable version, digest, signature/status, published time, bounded JSON descriptor;
- a channel pointer update and release insert are transactional;
- owner runtimes retain the last valid catalog if refresh fails.

## State Transitions

### Provider account

```text
disconnected -> unverified -> ready
                    |          |
                    v          v
                 invalid <-> unavailable
                    |
                    v
                  expired

any state --logout--> disconnected
```

Only a successful bounded probe moves `unverified`, `invalid`, `expired`, or `unavailable` to `ready`. A transient timeout from a previously ready account projects as `stale` before it becomes `unavailable` according to TTL policy.

Logout preserves the safe account entry when the provider model supports
re-authentication. Remove account is a separate deletion workflow: delete the
secret/profile and binding only after checking active/resumable Chat references,
then project those Chats as requiring reassignment. A failed secret deletion
leaves the prior visible state intact.

### Harness enablement

```text
enabled <-> disabled
   |
   +---- install/health states continue independently
```

Disabling a harness blocks new selection and execution but preserves binaries,
instances, accounts, configuration, and readable Chats. It is neither logout
nor account removal.

### Connection attempt

```text
pending -> authorized -> exchanging -> succeeded
   |           |             |
   +----------> denied / expired / failed
```

Completion is a conditional transition from `pending` or `authorized`. Replayed callbacks return the already-recorded safe terminal result and cannot bind a second account.

### Spend reservation (later)

```text
reserved -> committed -> reconciled
    |            |
    +---------> released
    +---------> expired -> reconciled
```

## Ownership and Deletion

- Owner provider accounts and secret references are deleted/disconnected at the owner runtime. Secret deletion must complete before the UI clears connected state; failures are reported safely.
- Matrix-funded policy and platform usage records are platform control-plane data with a documented financial retention period.
- Deleting a provider account does not delete Chats. Bound instances become `auth_required` and require an explicit new access source.
- If an account is referenced by an active or resumable Chat, removal requires
  explicit reassignment or confirmation. Matrix never silently charges another
  account or access source.
- Deleting a Matrix account revokes runtime relay credentials immediately and queues billing metadata deletion or retention according to financial/legal policy; Chat content remains governed by the owner's data deletion flow.
