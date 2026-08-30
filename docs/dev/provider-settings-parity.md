# Provider Settings Parity

This document defines the product vocabulary, information architecture, and
cross-shell contract for provider settings. It is a delivery constraint for
new work, not a claim that every state described here is already implemented.
The implementation status and sequence remain in
[`specs/118-ai-gateway-provider-auth/plan.md`](../../specs/118-ai-gateway-provider-auth/plan.md).

## Canonical vocabulary

Use these terms consistently in contracts, code comments, tests, and user
copy:

| Term | Meaning | Examples |
|---|---|---|
| **Harness** | The executable agent runtime that plans and performs a turn. A harness can be installed, enabled, disabled, healthy, or unavailable. | Hermes, OpenClaw, Pi, OpenCode, Codex, Claude |
| **Model provider** | The inference service that serves a model. A model provider is not an agent runtime. | Matrix AI, Anthropic, OpenAI, OpenRouter, Baseten |
| **Account** | An owner-scoped authenticated identity or API-key profile for a harness or model provider. More than one account may exist for the same provider. | Personal Anthropic, Work OpenRouter, Codex subscription |
| **Access source** | The exact credential and funding path selected for one run. It answers who supplies access and who is charged. | Matrix included credit, Matrix add-on credit, owner API key, owner subscription |

The V3 contract names `ProviderDriver` and `ProviderInstance` predate this UI
vocabulary. Treat them as the internal projections of a harness definition and
a runnable harness configuration. Do not label a Codex or OpenCode harness as a
model provider in new user-facing copy.

One run resolves this intersection explicitly:

```text
harness instance + account/access source + model provider + model
```

Matrix must not silently replace any explicitly selected member of that
intersection with a different account or funding source.

## Settings information architecture

### Agents & providers

This is the operational setup surface. It owns:

- harness installation, health, enable/disable, and instances;
- model-provider accounts, authentication, account selection, and logout;
- access-source and funding labels;
- model routing, capability-compatible controls, and model allowlists;
- truthful usage or credit displays when an authoritative source exists.

The left rail is labeled **Harness instances**. The add button creates another
harness instance; it does not create an inference vendor. Generic harnesses can
select a model provider and model. Model-specific harnesses expose only routes
that the harness contract proves they support.

### Identity & personality

This surface owns the Matrix assistant identity, profile, and `soul.md`-backed
personality. It must not own harness installation, provider credentials, model
routing, or usage.

### Custom agents (future)

This future surface owns named agent definitions from `~/agents/custom/`. A
custom agent can reference an available harness/route but does not duplicate
accounts, provider health, or model catalogs. Until this surface ships, do not
rename unrelated runtime settings to “Custom agents.”

## One state model across shells

`AiProviderSnapshotV3` is the sole provider-state truth. Legacy Settings and
Chat shapes are compatibility projections from V3; they are not independent
stores. New fields and mutations land in V3 first.

Canvas, Web Desktop, and Electron must expose the same:

- harnesses, accounts, access sources, models, and readiness states;
- add-instance and add-account flows;
- login, logout, removal, re-authentication, and enable/disable actions;
- gateway credit, usage, model-policy, and error states when those features
  exist;
- draft preservation, active-Chat reassignment guards, and safe errors.

Prefer a shared feature component, pure derivation helpers, schemas, and action
client. A shell adapter may provide window chrome, navigation, or the terminal
launcher, but it must not reimplement product state or business rules. A
temporary shell-specific exception requires an issue, a documented capability
reason, and a disabled or explanatory state on the other shells; silent omission
is not acceptable.

Electron Desktop is the visual and interaction ground truth while the surfaces
converge. Canvas is the primary product surface and is validated first. The
required manual order for user-visible changes is:

1. Canvas on the browser shell;
2. Web Desktop on the same runtime;
3. Electron Desktop against the same V3 fixture.

Automated tests must exercise the shared derivations and actions. Each frontend
PR must also include current screenshot or recording evidence for all affected
surfaces.

## Authentication and account lifecycle

Authentication should be guided from Settings or Chat. When a provider
requires a CLI login, open a visible canonical Terminal flow. Canvas and Web
Desktop use the `__terminal__` built-in on the owner VPS; Electron opens its
visible terminal surface through the same account-attempt orchestration. The UI
must show pending, succeeded, denied, expired, failed, and retry states without
inferring success from a file's existence.

These actions are distinct:

- **Log out** revokes or disconnects the selected account session/credential.
  The account entry and harness configuration may remain so it can be signed in
  again. The harness is not uninstalled or disabled.
- **Remove account** deletes the owner credential/profile and account binding.
  If active or resumable Chats reference it, require explicit reassignment or
  confirmation. Removing an account never deletes Chat history.
- **Disable harness** prevents new selection/execution for that harness while
  preserving its installation, instances, accounts, and configuration. Existing
  Chats stay readable and require a compatible route before another turn.

Multiple accounts are first-class. Account IDs are stable and owner-scoped;
labels are safe display metadata, not secret suffixes. Adding an account must
not overwrite another account, and every runnable instance identifies the
selected account or Matrix-funded access source explicitly.

## Gateway readiness, credits, and usage

Matrix AI is a managed access source, not an Anthropic account. It is `ready`
only when both conditions are currently true:

1. Matrix policy says the owner/runtime is eligible for at least one allowed
   model; and
2. the Matrix relay reports bounded, fresh operational health.

A legacy platform key, local configuration, a Cloudflare gateway URL, or a
previous successful request is not sufficient readiness evidence. If policy or
relay health is missing, stale, disabled, or unavailable, fail closed and offer
an owner-funded route where possible.

Cloudflare AI Gateway provides Unified Billing and a coarse operator spend
fuse. It does not own Matrix user identity, per-user balances, model entitlement,
or add-on credit. Cloudflare spend rules are defense in depth because accounting
can be eventually consistent and rule counts are bounded. Matrix must own the
authoritative Kysely/Postgres ledger, reserve spend atomically before a funded
call, and reconcile provider usage afterward before exposing per-user limits or
add-on credit.

Usage displays must state their authority:

- Matrix credit may show exact used and remaining amounts only after the Matrix
  ledger is implemented and reconciled;
- metered owner APIs may show Matrix-observed usage and a provider balance only
  when a supported provider API returns it;
- subscriptions show provider-reported allowance/reset information, not an
  invented dollar balance;
- unknown or stale values are labeled unavailable or stale, never estimated as
  exact.

## Security and failure requirements

- Browser input never chooses owner identity, relay identity, secret references,
  provider base URLs, or billing authority.
- New mutations require authenticated owner scope, `bodyLimit`, bounded Zod
  schemas, safe errors, idempotency, and integration wiring tests.
- External calls use fixed or validated endpoints, redirects rejected, bounded
  bodies/streams, explicit timeouts, cancellation, and no raw provider errors.
- Account-attempt registries, health caches, and subscriber collections are
  capped, evicted, swept, and drained on shutdown.
- Secrets are never returned to renderers, logs, analytics, screenshots, or
  ordinary exports. Provider labels must not contain secret fragments.
- Logout/removal UI changes state only after the server confirms credential
  mutation. Partial failure preserves the prior visible state and offers retry.
- Cloudflare and relay observability is metadata-only; prompt, response, tool,
  file, and credential payload logging remains disabled.

## Delivery stack

Land this work in independently reviewable Graphite layers, each with tests
first, applicable build/pattern gates, current visual evidence, and Greptile
5/5:

1. canonical V3 snapshot and compatibility projections;
2. shared read-only **Agents & providers** surface and cross-shell parity;
3. multi-account authentication and logout/remove/disable lifecycle;
4. policy-and-relay-gated Matrix-funded activation;
5. Matrix-owned allowances, metering, add-ons, and truthful credit UI;
6. additional model providers and harness adapters through the canonical
   contract.

Do not claim a later layer in UI copy or documentation before its source of
truth, security boundaries, tests, and all-shell behavior ship. Production
activation and public product documentation are separate reviewed deliverables.
