# AWS Bedrock funded inference upstream

**Linear:** ENG-150, ENG-297

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
- A bounded, owner-scoped `cloudflare | aws_bedrock` preference is available
  only to the four immutable owner IDs in the operator-managed developer
  cohort. The expiring cohort configuration, exact Bedrock model list, current
  price review, and authenticated readiness result are all required before the
  platform can resolve Bedrock. Missing, invalid, stale, unauthorized, or
  unhealthy state resolves to Cloudflare.
- Preference writes use optimistic revision checks and a bounded idempotency
  key, and persist the preference plus its content-free replay/audit event in
  one transaction. Renderers receive only the platform projection; they never
  derive cohort membership or readiness. Funding-summary reads, preference
  response projection, and relay policy checks use only bounded cached Bedrock
  health and fall back to Cloudflare on cache failure; they never start paid
  readiness probes. Only the authenticated readiness route may refresh that
  cache. Account deletion erases the owner's preference and its audit history
  inside the existing platform-data transaction.
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
- Explicit Bedrock readiness accepts only the validated bounded Bedrock model
  list and fails closed without an exact configured route. Cloudflare health
  can never establish Bedrock readiness.
- A complete pre-stream zero-usage rejection carries the already-resolved
  content-free upstream evidence into exact settlement, so route-bound holds
  cannot be stranded by provenance validation.

## Auth matrix

| Route | Caller authentication | Additional authorization | Public |
|---|---|---|---|
| `POST /v1/chat/completions` | short-lived platform-issued funded credential | platform policy check, atomic usage reservation, model allowlists | No |
| `GET /ready?model=<configured-client-id>&upstream=aws_bedrock` | constant-time relay control bearer | exact configured route, current price review, bounded live inference probe with exact usage | No |
| `POST /internal/containers/:handle/ai/funding-summary?runtimeSlot=...` | exact runtime verification token | preference is returned only on an explicit opt-in and only for an entitled owner | No |
| `POST /internal/containers/:handle/ai/upstream-preference?runtimeSlot=...` | exact runtime verification token | immutable owner entitlement plus optimistic preference revision | No |
| `POST /internal/ai/funded/check` | constant-time relay control bearer | live owner/model policy; returns a short-lived HMAC-bound upstream selection | No |
| `POST /internal/ai/funded/authorize` | constant-time relay control bearer | re-verifies the same selection and binds it to the atomic reservation | No |
| `GET /health` | none | liveness only; exposes no provider state | Yes |

No public endpoint is introduced. Unentitled owners receive no preference field
and preference mutation returns the same generic not-found shape. Caller-supplied
identity, provider headers, route URLs, AWS account data, and display names are
never authority.

## Runtime wiring

1. The dedicated relay validates and reconstructs a bounded OpenAI-compatible
   request. Remote media and server-side fetching remain disallowed.
2. The configured client ID resolves to a canonical policy model and a single
   Bedrock inference profile. The platform checks owner/runtime policy, resolves
   the authoritative upstream before reservation, and signs a selection bound
   to owner, exact model, preference revision, and a maximum 30-second lifetime.
   Selection is capability-negotiated on the read-only policy check: legacy
   relays receive the original strict response and legacy platforms are retried
   with the original strict request. Either mixed-version path remains
   Cloudflare-only and omits new authorization fields.
   For entitled current clients, the platform projection carries the exact
   healthy Bedrock model IDs into Provider V3. Shared Chat and Settings
   projections consume that field rather than inferring eligibility. Bedrock
   models are exposed through Matrix Pi's OpenAI-compatible route and excluded
   from the Claude SDK's Anthropic Messages instance. Settings clients must
   opt in to the preference field and matching mutation together; legacy
   clients receive neither. Raw Provider V3 reads negotiate the same additive
   preference truth independently so older strict provider readers also keep
   their historical response shape.
   If route readiness refreshes Bedrock health after the concurrent funding
   summary was read, the gateway re-reads bounded platform truth and requires
   an exact effective Bedrock model match before exposing a custom model or
   choosing the OpenAI-compatible request protocol.
3. The relay calculates a conservative liability ceiling using the maximum
   configured input and requested output bounds plus a 20% margin. Pricing must
   be inside its reviewed time window.
4. Platform authorization verifies the selection again and atomically reserves
   only the affordable owner funds while retaining the full liability ceiling.
   The reservation records that same upstream; `start` then moves the row to
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
- The selected upstream is included in the authorization idempotency hash and
  reservation row. Exact settlement provenance must match it; a mismatched
  provider receipt is an idempotency conflict.
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

1. Configure the preference feature only with the reviewed immutable owner IDs,
   exact canonical Bedrock model IDs, an expiring validity timestamp, and a
   dedicated HMAC selection secret. Display names and runtime headers are not
   accepted as cohort authority. The bounded configuration is
   `AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED`,
   `AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS` (exactly four immutable owner
   IDs), `AI_FUNDED_BEDROCK_MODEL_IDS` (a JSON array of at most eight canonical
   model IDs), `AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH` (at most 30 days),
   and `AI_FUNDED_UPSTREAM_SELECTION_SECRET`.
2. Confirm credits/expiry, target region and allowed residency destinations,
   model access, inference profile, service quotas, exact prices, and workload
   identity in the real AWS account.
3. Run one explicitly approved, bounded live smoke request and record only
   content-free evidence. Do not make a paid call without operator approval.
4. Deploy the route configuration with a short price-review window. Verify
   `/ready` before adding the canonical model to platform global/runtime
   allowlists.
5. Observe readiness failures, throttling, unresolved holds, exact settlement,
   Matrix-absorbed overruns, and provider request IDs. No prompt/content logging
   is allowed.
6. Roll back immediately by disabling the expiring preference cohort or removing
   the route and policy allowlist entry.
   Existing exact settlement retries remain valid because each queued task
   carries its pricing version and provenance. Unresolved holds require evidence
   reconciliation, not deletion.
7. After current-head Greptile reaches 5/5 and CI is green, create an explicitly
   approved preview VPS and verify the full preference, routing, streaming,
   settlement, and fallback flow on real devices before merge.

## Verification

- Adapter tests cover strict config, OpenAI/Bedrock translation, tool streaming,
  usage/cache metadata, cancellation, response caps, and generic exception
  mapping.
- Relay integration tests cover policy-before-provider ordering, reservation and
  start ordering, current pricing, exact settlement/provenance, readiness,
  policy rejection, throttling, and no fallback.
- Contract/platform tests cover cohort hiding, optimistic transactional
  preference/audit persistence, cached short-path resolution, signed
  resolution, reservation binding, bounded provenance, idempotent replay,
  conflicting evidence, and legacy Jev/Cloudflare behavior. Gateway tests prove
  that healthy configured Bedrock models enter Provider V3 through the shared
  Matrix relay data policy instead of renderer-local inference. Route tests
  prove exact effective Bedrock models use OpenAI-compatible Matrix Pi while
  the Claude kernel path excludes them, and mixed-version Settings tests prove
  the preference field and mutation are negotiated atomically.
- Full repository typecheck, pattern checks, unit/integration tests, current-head
  Greptile 5/5, and CI are required before merge.

## Large-file extraction plan

ENG-297 establishes the following behavior-preserving extraction sequence
before any further funded-AI behavior is added to the three oversized files
touched by this feature:

1. Move funded control-plane startup assembly from `platform-startup.ts` into a
   focused `ai-funded-startup.ts` factory. The factory will accept the shared
   database and parsed environment, return the three route groups plus probe
   and preference services, and will not take ownership of the shared database.
   Startup remains responsible only for lifecycle composition and shutdown.
2. Move the post-reservation provider dispatch/finalization state machine from
   `funded-relay.ts` into a provider-neutral `funded-generation-dispatch.ts`.
   The extracted boundary will own start-before-dispatch ordering, exact versus
   unresolved settlement classification, route provenance, cancellation, and
   the prohibition on cross-provider retry; the Hono module will retain request
   validation, authentication, and admission composition.
3. Split `ai-funded-policy-routes.test.ts` into shared fixtures plus focused
   policy, readiness, and upstream-preference route suites. Every suite will
   create and destroy its own native Postgres fixture and retain the mixed-
   version, owner-policy re-read, and route-selection integration coverage.

The extraction is complete when each new module has one documented
responsibility, the affected composition files are below 1,000 lines (with
focused helpers aiming below 500), the full existing focused suites remain
green, and no route/auth/database ownership semantics change.

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
