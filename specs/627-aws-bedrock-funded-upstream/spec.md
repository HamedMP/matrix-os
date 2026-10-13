# AWS Bedrock funded inference upstream

**Linear:** ENG-150

**Parent:** ENG-182

**Status:** implementation complete behind fail-closed configuration; live qualification pending

## Objective

Add AWS Bedrock as an operator-controlled Matrix AI inference upstream without
changing customer runtime placement, starter-credit economics, or the
authoritative Matrix policy and ledger. Bedrock is a transport and inference
provider behind the existing relay. It never receives authority to admit an
owner, choose a funded model, reserve credit, or settle a charge.

The route is absent by default. Merely deploying this code does not advertise
or enable a Bedrock model. Enablement requires a strict
`MATRIX_FUNDED_BEDROCK_ROUTE` value, current reviewed prices, a successful
authenticated readiness probe, and the existing platform global/runtime model
allowlists.

## Source of truth and invariants

- Platform PostgreSQL/Kysely remains authoritative for owner identity, model
  policy, monthly budget, credit grants, reservations, and the append-only
  ledger. AWS budgets and quotas are defense-in-depth controls only.
- The relay route JSON is operator configuration. It binds one client model ID
  to one canonical Matrix model, resolved Bedrock model/inference profile,
  region, context/output ceilings, and a time-bounded reviewed integer price
  table. Unknown keys, endpoints, and embedded credentials are rejected.
- The existing $5 starter-credit campaign is unchanged. Authoritative campaign
  total caps, claim limits, and pause/revision controls are tracked separately
  in ENG-275 and are not inferred from this provider route.
- Authorization and an affordable atomic hold complete before the platform
  marks the reservation in flight; provider dispatch occurs only after that
  start transition. There is no automatic provider fallback after start.
- A complete Bedrock `ConverseStream` response must include consistent exact
  input, output, cache-read, and cache-write usage. Missing, malformed,
  truncated, cancelled, timed-out, or oversized usage stays unresolved and
  fail-closed under the existing usage-reservation barrier.
- Exact settlement stores only content-free evidence: upstream kind, route ID,
  resolved model, inference profile, region, pricing version, and provider
  request ID. Prompts, tool arguments, generated content, credentials, raw AWS
  errors, endpoints, account IDs, and response bodies are never stored as
  provenance or returned in client errors.

## Auth matrix

| Route | Caller authentication | Additional authorization | Public |
|---|---|---|---|
| `POST /v1/chat/completions` | short-lived platform-issued funded credential | platform policy check, atomic usage reservation, model allowlists | No |
| `GET /ready?model=<configured-client-id>` | constant-time relay control bearer | exact configured route, current price review, bounded live inference probe with exact usage | No |
| `GET /health` | none | liveness only; exposes no provider state | Yes |

No new customer-facing endpoint is introduced. Caller-supplied identity,
provider headers, route URLs, AWS account data, and model aliases are ignored.

## Runtime wiring

1. The dedicated relay validates and reconstructs a bounded OpenAI-compatible
   request. Remote media and server-side fetching remain disallowed.
2. The configured client ID resolves to a canonical policy model and a single
   Bedrock inference profile. The platform checks owner/runtime policy.
3. The relay calculates a conservative liability ceiling using the maximum
   configured input and requested output bounds plus a 20% margin. Pricing must
   be inside its reviewed time window.
4. Platform authorization atomically reserves only the affordable owner funds
   while retaining the full liability ceiling, then `start` moves the row to
   `in_flight`.
5. The provider-neutral dispatch seam calls AWS SDK v3 `ConverseStream`. The
   SDK uses the relay workload's default AWS credential provider chain; no AWS
   credential is accepted from a request or route configuration.
6. Bedrock events are translated to bounded OpenAI SSE. Downstream
   cancellation aborts the SDK request and returns its iterator.
7. Exact metadata usage is priced with the reservation's route-bound price
   version. Settlement and provenance are written in the existing owner-locked
   transaction with the reservation row locked. A conflicting replay is an
   idempotency conflict and cannot debit again.

## Transaction and orphan-state contract

- Platform authorization retains the existing owner advisory lock and database
  transaction for balance checks, reservation allocation, and ledger safety.
- Settlement retains the owner advisory lock plus reservation `FOR UPDATE` row
  lock through source reconciliation, debit ledger writes, provenance write,
  hold release, and receipt persistence.
- Before `start`, failures release the untouched reservation. After `start`, an
  unknown provider result is an acceptable unresolved `in_flight` state: the
  hold remains and blocks another funded request for that owner until exact
  reconciliation. It must never be converted to free usage or a guessed zero.
- A provider charge can exist without a delivered client response after a
  network interruption. The bounded settlement retry queue and unresolved hold
  are the deliberate recovery mechanisms; automatic cross-provider retry is
  prohibited because it can duplicate spend or tool effects.

## AWS prerequisites and IAM

Production enablement requires operator review of the actual target account and
region. The deployment identity should use workload identity federation and an
assumable least-privilege role. A staged secret is permitted only as a temporary
operator-managed fallback; it must not be placed in the repository, route JSON,
customer VPS environment, logs, or client responses.

The role needs only the resources selected during qualification:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:GetInferenceProfile` when an inference profile is used

Model access, cross-region inference destinations, service quotas, price,
cache pricing/TTL semantics, and data-residency implications must be checked in
the live account. A profile name or prefix is not proof of residency; every
destination region returned by the profile must satisfy the approved policy.

## Bounds, errors, and privacy

- Route JSON: 16 KiB maximum and strict schema.
- Requests retain the relay's body, message, tool, JSON-depth, output-token,
  first-response, total-duration, and admission limits.
- Generated response: relay-configured cap, with a second 32 MiB adapter cap.
- Readiness response: 64 KiB capture and the shared 8-second upstream probe
  deadline.
- Tool registry per response: 256 entries maximum.
- AWS throttling maps to a generic 429; timeout/cancellation to a generic 504;
  other AWS rejection/transport/stream failures to a generic 502. Raw provider
  messages are logged only as coarse error classes and never returned.

## Rollout and rollback

1. Confirm credits/expiry, target region and allowed residency destinations,
   model access, inference profile, service quotas, exact prices, and workload
   identity in the real AWS account.
2. Run one explicitly approved, bounded live smoke request and record only
   content-free evidence. Do not make a paid call without operator approval.
3. Deploy the route configuration with a short price-review window. Verify
   `/ready` before adding the canonical model to platform global/runtime
   allowlists.
4. Observe readiness failures, throttling, unresolved holds, exact settlement,
   Matrix-absorbed overruns, and provider request IDs. No prompt/content logging
   is allowed.
5. Roll back immediately by removing the route and policy allowlist entry.
   Existing exact settlement retries remain valid because each queued task
   carries its pricing version and provenance. Unresolved holds require evidence
   reconciliation, not deletion.

## Verification

- Adapter tests cover strict config, OpenAI/Bedrock translation, tool streaming,
  usage/cache metadata, cancellation, response caps, and generic exception
  mapping.
- Relay integration tests cover policy-before-provider ordering, reservation and
  start ordering, current pricing, exact settlement/provenance, readiness,
  policy rejection, throttling, and no fallback.
- Contract/platform tests cover bounded provenance, atomic persistence,
  idempotent replay, conflicting evidence, and legacy Jev/Cloudflare behavior.
- Full repository typecheck, pattern checks, unit/integration tests, current-head
  Greptile 5/5, and CI are required before merge.

## Deferred deliverables

- ENG-275 owns authoritative starter-campaign aggregate caps and pause controls.
- Live AWS account qualification and the bounded paid smoke remain blocked on
  operator-supplied account/region/credit/model/quota/identity facts and explicit
  spend approval.
- A separate documentation PR in the private `FinnaAI/matrix-os-site`
  repository must document Bedrock prerequisites, configuration, readiness,
  observability, and rollback after live qualification. This public repository
  must not contain customer identifiers, account IDs, secrets, or private
  operator commands.

## Primary references

- AWS Bedrock Converse: <https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html>
- ConverseStream metadata and token usage: <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamMetadataEvent.html>
- Model access: <https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html>
- Inference profiles: <https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html>
- Runtime quotas: <https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/quotas-runtime.html>
- Pricing: <https://aws.amazon.com/bedrock/pricing/>
