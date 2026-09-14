# Contract: Provider, Account, and Model Catalog

## Separation invariant

Every run resolves four explicit IDs:

```text
driver -> provider instance -> access source/account -> model
```

Example:

```text
kernel (Agent SDK)
  -> kernel-matrix-included
  -> matrix_included (Matrix is billed; Anthropic account is not connected)
  -> claude-sonnet-5
```

Neither the UI nor a route may infer owner login from the ability to run through Matrix-funded fallback.

## Public catalog shape

```ts
type AiProviderSnapshotV3 = {
  contractVersion: 3;
  revision: number;
  refreshedAt: string;
  accessSources: AiAccessSourceView[];
  accounts: ProviderAccountView[];
  drivers: ProviderDriverView[];
  instances: ProviderInstanceView[];
  models: ModelDescriptorView[];
  active: {
    providerInstanceId: string | null;
    accessSourceId: string | null;
    modelId: string | null;
  };
};
```

All IDs and labels have explicit Zod length limits. Arrays have maximum counts. Unknown enum values fail catalog ingestion but are mapped to safe `unknown` when reading older persisted data.

## Status vocabulary

| State | Meaning | Typical action |
|---|---|---|
| `ready` | Verified or authoritatively enabled and runnable | none |
| `setup_required` | No owner connection/configuration exists | connect / enter key |
| `auth_required` | Harness exists but provider auth is missing | connect / open terminal |
| `invalid` | Provider definitively rejected current credential/config | reconnect |
| `expired` | Provider says credential/session expired | reconnect |
| `unavailable` | A bounded probe or funded policy dependency is temporarily down | retry |
| `disabled` | Operator, entitlement, or policy disabled this source | connect another source / contact owner |
| `stale` | Last known state exceeded TTL; refresh did not establish current truth | retry |
| `unknown` | No trustworthy observation exists | retry/setup |

Harness install and health states remain separate. A connected OpenRouter account does not make a missing harness installed; an installed Claude CLI does not mean the Anthropic account is connected.

## Resolution rules

1. An explicitly selected provider instance and access source always win if still compatible.
2. Matrix must not silently move a run from owner-funded to Matrix-funded or vice versa.
3. `auto` resolution may use a documented precedence list, but the resolved funding source is shown before submission and recorded on the run.
4. A model must be enabled by the intersection of driver capability, vendor catalog, account/access-source policy, and current entitlement.
5. If the intersection becomes empty, the Chat remains readable and submission requires an explicit compatible selection.
6. Fallback between upstream infrastructure providers is allowed only when it preserves the same funding source, user-visible model semantics, and data policy. The response records the canonical model/provider when known.

## Initial model policy

| Model | Matrix included | Owner Anthropic | Owner OpenRouter | Notes |
|---|---:|---:|---:|---|
| Claude Sonnet 5 | yes, default | yes | yes if available | Validate adaptive-thinking/control behavior |
| Claude Haiku 4.5 | optional after quality test | yes | yes if available | Low-cost/background candidate |
| Claude Opus 5 | no initially | yes | yes if available | Add-on candidate |
| Claude Fable 5 | no | opt-in only | opt-in only | Requires explicit retention/data-policy disclosure |

This is policy, not a claim that every upstream always serves every model. The catalog intersects policy with provider availability.

## Catalog refresh

Borrow the useful `t3code` pattern without trusting a public repository as runtime authority:

1. load and validate the bundled catalog;
2. load a symlink-safe, bounded last-known-good cache if present;
3. fetch a Matrix-published catalog from a fixed allowlisted URL with `AbortSignal.timeout(10_000)` and `redirect: "error"`;
4. validate schema, entry count, byte size, allowed vendors/transports, catalog version, and signature/digest;
5. atomically replace cache and publish a generic `catalog_updated` event;
6. on any error, log a safe class and continue with last-known-good/bundled catalog.

Remote data cannot define executable paths, shell commands, arbitrary base URLs, headers, drivers, or credential behavior.

## Harness adoption contract

A new harness must provide:

- registration-time dependency validation;
- bounded capability and model discovery;
- install/health/auth state independently;
- run, resume (if claimed), cancellation, tool/result normalization, and safe error mapping;
- process environment allowlisting so platform/database secrets never enter child processes;
- bounded stdout/stderr/event buffers, process timeouts, and cleanup;
- canonical Chat persistence only.

OpenCode uses the current Matrix driver. Cursor/Grok wait for a generic ACP driver and separate security/compatibility tests. Their names or model lists must not be added to UI until the driver is actually runnable.
