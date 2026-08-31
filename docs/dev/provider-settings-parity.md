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
| **Model provider** | The inference service that serves a model. A model provider is not an agent runtime or managed gateway. | Anthropic, OpenAI, OpenRouter, Baseten |
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

`AiProviderSnapshotV3` is the sole credential, funding, and model-inventory
truth. Owner harness configuration is the bounded Provider Settings projection.
`GET /api/chat-providers` combines those sources with live runtime adapters and
is the sole executable Chat catalog. Legacy Settings and Chat shapes are
compatibility projections; they are not independent stores.

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

Canvas, Web Desktop, and Electron admit turns through the canonical Chat
orchestrator (`/api/chats` and `/api/chats/:id/turns`) and resolve picker choices
from `/api/chat-providers`. A shell must not pair the canonical picker with the
legacy `/api/message` execution path: that would display a harness selection
which does not bind or execute the selected instance. Availability labels and
exact runnable instance/model derivation live in `@matrix-os/ui` so every shell
renders the same disabled reason. The browser shell's Canvas and Desktop modes
consume the same `ChatApp` and canonical state adapter. That shared composer
submits the catalog's exact model options, interaction mode, and permission
mode; it must not silently collapse them to the first advertised value.
Canonical approvals are rendered as allowlisted actions in every browser-shell
mode. Browser shells refresh the Chat list and active detail after focus or
visibility returns in addition to polling an active run, and stale detail
responses cannot retarget a newly selected Chat.

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
- **Remove harness instance** is available only after that instance is disabled.
  It removes the owner Settings instance, not the installed binary, credentials,
  or existing Chat history. A later turn in an existing Chat still resolves its
  durable provider selection independently and must pass normal readiness checks.

Generic lifecycle mutations are admitted only for exact runtime support. Hermes
and OpenClaw reuse the bounded messaging-runtime controller. Pi and OpenCode must
be registered coding runtimes at gateway startup in addition to appearing in
binary inventory. Their binary probes establish installation only; owner
Settings establish authentication, connectivity, exact access source, provider,
and model readiness. Codex and Claude remain specialized model-specific drivers;
their existing login/logout commands are not routed through the generic
coordinator. Multiple account rows are a forward-compatible data shape, not a
claim that a CLI can run concurrent profiles today; generic runtimes do not
advertise standalone account/source selection until they own a real profile
switch.

More than one configured instance of a harness kind is allowed. The add flow
therefore never disables Hermes, OpenClaw, Pi, OpenCode, Codex, or Claude merely
because one instance already exists. Each instance keeps its own display name,
route, access source, and account binding. Until an execution adapter supports
concurrent profiles for that harness, multiple enabled instances fail closed in
the Chat catalog with an explanatory state rather than choosing one silently.
Disabled instance removal and non-active disable remain local cleanup operations,
so an unavailable or uninstalled runtime cannot strand stale owner Settings rows.
Operations that enable, route, or switch an active runtime still fail closed.

Pi and OpenCode currently execute only supervised, read-only turns. Pi receives
only its non-mutating `read` tool; OpenCode receives an explicit deny-by-default
permission document with only read/search tools enabled, ignores project-local
configuration, and disables external plugins. Both run as bounded structured
child processes with cancellation, timeout, output, event, and active-process
limits. A request for workspace-write or full access is rejected rather than
run without confinement.

Long Pi and OpenCode first turns are dispatched only after the queued Chat is
durably visible. They never hold the global thread-state mutation queue while a
CLI runs; inspect, abort, another Chat, and shutdown retain bounded independent
progress. Provider output is finalized in a short race-safe mutation and late
output cannot resurrect an aborted or otherwise terminal Chat.

Each Pi or OpenCode turn resolves the one enabled owner harness instance and its
selected access source immediately before spawn. Only portable credentials for
that exact source are copied into the child environment. Matrix-included access
and owner Anthropic API keys are portable; a Claude OAuth profile is intentionally
not reused by another CLI. Missing binaries, duplicate enabled instances,
unavailable credentials, offline routes, unsupported model vendors, and stale
models all remain non-runnable. Resume state retains only the provider session ID
and the validated working directory; it never persists a credential.

The portable-credential predicate is one shared contract. The add-harness UI
filters provider, model, and source choices with it, configuration mutations
revalidate it at the gateway boundary, and the Chat catalog plus child-process
credential resolver enforce it again. Renderer state can therefore never make
an otherwise unsupported owner subscription or model vendor executable.

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
can be eventually consistent and rule counts are bounded. Matrix owns the
authoritative Kysely/Postgres ledger, reserves spend atomically before a funded
call, and reconciles provider usage afterward. Provider settings reads the
resulting promotional balance, add-on balance, held reservations, settled
monthly use, and remaining monthly budget through a machine-authenticated
platform summary. The response is identity-free and is never persisted on the
VPS. If the summary is unavailable, the card says usage is unavailable; it does
not reuse local configuration as a balance.

Budget and model-policy controls become operator-owned as soon as that platform
summary is configured. The gateway then omits `set_gateway_budget` and
`set_gateway_allowlist` from `supportedActions`; web and Electron render the
same values read-only and cannot write cosmetic owner JSON that the relay would
ignore. Operators use the authenticated platform policy routes with optimistic
revisions. Owner self-service may later narrow an operator ceiling, but it must
be a machine-authenticated platform mutation before either shell advertises it.

First-launch promotional credit is also platform-owned. It is disabled unless
an operator explicitly configures one bounded campaign ID, positive microusd
amount, and ISO expiry. Grant creation derives the exact owner, machine, and
runtime slot from the running handle and uses one `ON CONFLICT`-guarded ledger
entry per campaign/runtime. Retries cannot double-credit. Once remaining
promotional credit expires, new funded admission and usage summaries fail
closed; an expired local value is never treated as spendable credit.

Usage displays must state their authority:

- Matrix credit shows exact used and spendable amounts only from the reconciled
  Matrix ledger; the spendable figure is the smaller of remaining credit and
  remaining monthly budget;
- metered owner APIs may show Matrix-observed usage and a provider balance only
  when a supported provider API returns it;
- subscriptions show provider-reported allowance/reset information, not an
  invented dollar balance;
- unknown or stale values are labeled unavailable or stale, never estimated as
  exact.

Add Credit is advertised only when the platform's authoritative checkout
configuration is complete. The browser cannot choose an owner, machine, USD
amount, Stripe Price, or ledger value: it sends one allowlisted package ID,
runtime slot, and UUID, while Clerk authentication and the active machine row
derive the exact owner/runtime. Web navigates to hosted Stripe Checkout and
Electron opens that same validated `https://checkout.stripe.com` URL in the
external browser. Both render the shared package picker and safe retry state.

Creation first persists an immutable, bounded checkout claim. Active attempts
are reused and each owner/runtime is durably limited to five new attempts per
hour. The signed Checkout lifecycle validates payment mode, USD currency, exact
pre-tax `amount_subtotal`, `amount_total >= amount_subtotal`, package/Price
metadata, and the owner/machine/runtime binding against that claim rather than
mutable environment configuration. Completed unpaid sessions wait for
`checkout.session.async_payment_succeeded`; failed or expired sessions add no
credit. The webhook receipt and non-expiring add-on ledger grant commit in one
database transaction. The ledger entry uses the Checkout Session ID with
`ON CONFLICT`, so duplicate delivery cannot add credit twice. Mismatches return
non-2xx so Stripe retries; valid unpaid, failed, and expired lifecycle events
are recorded as 2xx no-ops for credit.

Any positive refund reverses the full associated add-on grant. Available
unused credit is removed atomically; already consumed or reserved credit
becomes durable debt and freezes further funded authorization. A dispute does
the same while open or lost. A won dispute restores only the amount previously
removed, clears that claim's debt, and unfreezes the runtime when safe.
Cloudflare remains the upstream billing/spend fuse while Matrix Postgres remains
the user-credit authority.

`gatewayPolicy.topUpEnabled` and `add_credit` fail closed unless
`MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED=true`, Stripe signing is configured,
and every server-owned `$5/$10/$25` Price ID is valid. Local provider JSON can
never enable the button. Stripe Tax is off for add-on Checkout unless operators
set `MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED=true` after confirming
the required active tax registrations.

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
