# Cloudflare-only usage metering and starter defaults

Status: active. Supersedes the exact pre-count / full-context reservation approach
for the new opt-in usage mode. Existing strict funded requests remain compatible.

## Approved product decisions

- Cloudflare only: no Anthropic counting key or counting dependency for generation.
- Settle real response usage; reject new requests when credit/monthly allowance is
  exhausted. One in-flight funded request per owner across runtimes and replicas.
- Matrix absorbs the final in-flight overrun; never recover it from later user
  top-ups or charge a payment method. User explicitly approved this trade-off.
- Starting credit defaults to $5, configurable to $10, once per owner per campaign.
- Default managed model: `@cf/zai-org/glm-5.3-flash`, verified against Cloudflare's
  live catalog. Preserve existing explicit Chat and own-account selections.
- PR1502 preview only. No merges, production promotion, primary machine changes,
  automatic credit purchases, or bulk historical grants.

## Implementation units and parallel ownership

### U1: Durable usage admission and settlement (test-first)

Goal: opt-in usage admission succeeds with positive remaining credit without a
token pre-count or requiring the worst possible cost to be available. Actual
provider cost is audited; user debit is capped at the available credit/budget
committed for this request; excess is Matrix-funded and never customer debt.

Own: `packages/contracts/src/funded-ai.ts`, platform metering repository and new
extracted modules, related platform DB types/migrations if required, and focused
contract/metering tests. Do not edit promotional-grant routes/config (U3).

Wire agreement: authorization request/response reservation optional
`billingMode: "usage"`; retain required `maxCostMicrousd` as a bounded liability
ceiling and strict-mode compatibility. Platform derives an affordable hold
`min(maxCostMicrousd, availableCredit, remainingMonthlyBudget)` inside its existing
transaction, never trusting caller balances. Response echoes usage mode on the
reservation. Relay sends actual finalization even above the hold in usage mode.

Pattern: existing Kysely transactions, idempotent reservation lifecycle,
per-source promotional/add-on attribution, error allowlist. Extract responsibility
from the 1108-line repository before adding new behavior. Distributed owner
serialization must use Postgres, not a process-local map. Unknown usage remains
unresolved/fail-closed, not fabricated as an exact full-credit charge.

Tests: $1 balance admits a larger bounded request; single winner across owner
runtimes; strict compatibility; repeated settlement/idempotency; overrun audit
without debt or charging later credit; zero balance denied; unknown usage blocks
further execution until reconciliation. Verification: focused real-DB tests.

### U2: Cloudflare GLM relay protocol (test-first)

Own: `packages/proxy/src/funded-relay*.ts`, new proxy protocol modules, focused
proxy tests; `.github/workflows/ai-relay-cloud-run.yml` configuration wiring.

Goal: retain Anthropic Sonnet support and add `/v1/chat/completions` for the exact
GLM Flash model through Cloudflare. Usage mode does not call count_tokens. Limit
request bytes/output/lifetime; validate tools/messages and reject unknown fields;
request streaming usage and settle it once. Fixed upstream origins only.

Use `MATRIX_FUNDED_AI_RESERVATION_MODE=usage` opt-in (replace unshipped model-context
mode). Apply U1 billingMode protocol. In usage mode accept platform's positive
affordable hold <= requested liability cap; strict mode retains equality.
Keep pricing fail-closed with review expiry, integer arithmetic for fractional
microusd rates; allow no arbitrary upstream models/providers. Workers AI bearer
must stay centralized. Verify supported prepaid Workers AI route/settings in
Cloudflare docs; no credential output. Do not change live cloud settings.

Tests: synthetic GLM SSE including reasoning/tool calls/final usage, malformed or
missing usage, duplicate events, count never called in usage mode, policy/credit
denial before inference, caller authority stripped, safe errors and bounds.

### U3: Starter credit and shared GLM default (test-first)

Own: promotional-grant configuration/routes and focused route tests; gateway
managed provider/model catalog, generic-harness runtime config, shared default
selection helpers and their tests. Do not edit U1 contract or metering files or
U2 proxy files. Coordinate necessary contract requests with parent.

Goal: $5 default configurable to $10, idempotent once-per-owner campaign, no
automatic bulk grants. Project GLM as the default managed route in V3 for Pi and
OpenCode and all shared Chat/settings consumers. GLM cannot execute in Claude's
Anthropic-only harness. Preserve explicit existing Chat and own-account choices.
Use existing managed access source `Matrix AI`; GLM's serving provider is
Cloudflare Workers AI, not a fabricated Matrix model provider. Generic adapters
must use OpenAI-compatible wire format and the relay's `/v1` base.

Tests: default/config override; repeated claim/multiple-runtime owner cannot mint
multiple grants; installed generic harness can select GLM Matrix route; explicit
saved selections preserved; native Claude routes remain compatible.

### U4: Integration, visible errors, documentation, preview (parent)

Own shared persisted Chat error fixes already in progress and their tests;
operator verification, safe preview-only configuration, integration gaps and
dev docs plus separate site documentation PR. Wait for worker file ownership
before editing overlaps. No staging/committing/test-suite execution by workers;
parent integrates and runs gates. Read ce-work shipping workflow before shipping.

Verify exact preview artifact provenance, one successful user-visible funded
reply, usage ledger delta and no stuck admission. Preserve existing chats/data.
Never describe the feature as live or merge-ready before these checks pass.
