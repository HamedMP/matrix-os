# Isolated ordinary Chat admission

## 1. Scope / trigger

An explicitly reviewed, default-disabled operator envelope can constrain one ordinary
Matrix-funded managed Pi Chat phase. A short prompt or a per-run validation profile
does not preserve a once-only phase after a new run or Gateway restart. This contract
adds a server-owned phase fence and cache-only fixed-model readiness. It creates no
credit, entitlement, access permission, paid-call approval or customer activation.

Ordinary owner authentication, capability/root admission and current funded execution
authorization still apply. The worker output minimum remains 256 and action minimum
remains 1. Default customer limits remain 8192 output and 60 actions. Tool-capable
customer behavior is not certified by this constrained text-only phase.

## 2. Signatures

- `parseIsolatedChatEnvelope(raw?: string): IsolatedChatEnvelope | undefined` parses
  trusted `MATRIX_ISOLATED_CHAT_ENVELOPE` in Gateway and Platform composition.
- `createIsolatedChatAuthority({ config, db, identity, now? })` selects the exact Chat,
  claims its first server-created run, and consumes one pre-send generation.
- Worker commands carry optional `isolatedTurn: { phaseId, maxInputBytes: 131072 }`.
  This instruction is not the authority for dispatch.
- `FundedModelProbeService.readCached(modelId, call?)` reads existing provider health
  without acquiring a probe lease or reserving count budget.
- Existing private runtime-HMAC-authenticated
  `POST /internal/containers/:handle/ai/route-readiness?runtimeSlot=...` carries
  `x-matrix-isolated-chat-phase: <phaseId>` when Gateway's exact trusted target
  matches. The public request body remains `{}` or the existing Jev selector.
- Owner PostgreSQL migration 8 adds `managed_pi_isolated_phases` with primary key
  `phase_id`, configuration hash, owner/Chat/run/runtime-handle/generation bindings,
  immutable expiry and one-way `dispatched` state.

No new public endpoint is introduced. Existing Chat auth, broker binding and Platform
runtime-HMAC auth remain the sources of authority.

## 3. Contracts

The strict envelope binds `phaseId`, `ownerId`, `machineId`, `runtimeSlot`,
`runtimeTokenEpoch`, `runtimeCredentialSha256`, `chatId`, `modelId`, `sourceSha`,
`startsAt` and `expiresAt`. Runtime slots use the canonical computer slot schema,
including supported Private Preview slots. Only fixed GLM Flash and Sonnet models
qualify. Credential bytes are not persisted in the phase table. The initial phase
lifetime is positive and at most one hour; expiry remains restrictive.

Configuration is absent by default and is supplied only through trusted server
composition. Client selection options, headers and home-directory files cannot
create or replace this authority. Invalid or partial configuration fails closed.

Gateway compares the installed source and hash of its current opaque runtime-HMAC
credential; it does not decode that credential into an epoch. Platform compares the
declared epoch with the current machine epoch and recomputes the credential hash
before cache-only readiness. Existing runtime and Relay authentication remain
mandatory at execution; a local configuration match is not fresh authorization.

The existing private runtime-authenticated readiness request also binds the Gateway
phase to the Platform's trusted configuration. The phase identifier is only a
matching hint; it cannot enable cache-only behavior or grant admission. Missing or
mismatched Platform configuration fails closed before any probe. Public catalog
request fields remain unchanged: fixed-model catalog reads use `{}`, and client
fixed-model or cache-only overrides remain invalid.
Platform independently restricts its configured exact target to cached health even
when the hint is absent. Nontarget and Jev requests retain their existing behavior.

The isolated worker requests 256 output, uses an action limit of 1, exposes no model
tools, and refuses tool execution, steering, continuation and summaries. The broker
validates the complete serialized request, model, output bound, request byte bound
and absence of tools before consuming the durable generation allowance. Capacity
refusal, cancellation, failed transport and unknown dispatch do not refund it.

The first run claim uses an atomic conflict-protected insert under the bounded phase
admission lock. Conditional `dispatched=false -> true` update precedes outbound I/O.
There are at most 64 retained phase rows; exhaustion fails closed. Release, restart
or Chat deletion does not clear phase history or permit a replacement run.

For the exact runtime, normal fixed-model catalog/readiness requests read only an
existing fresh, credential/config/Relay/model/price-bound health observation.
Current owner policy, ledger, machine epoch, kill switches and execution admission
remain independent checks. Cache miss, expiry or database failure returns unavailable
without inference, lease acquisition or count reservation. Other runtimes and Jev
retain their existing behavior. Composite receipt validity remains at most 30 seconds
and is also capped by phase, policy, provider-health and original price expiry.

The byte and output bounds are not tokenizer bounds or a provider dollar cap. This
phase is not a service-wide Relay caller fence. Upstream reasoning semantics,
background callers, current prices and complete fees still need a concrete paid
execution review. Normal runtime availability and customer recovery remain separate.

## 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Envelope absent | Preserve normal admission, model tools and readiness |
| Invalid/partial configuration | Reject startup/configuration; no unrestricted fallback |
| Wrong source, identity, credential, model or expired phase | Reject isolated execution |
| Duplicate first-run claim or changed binding | Reject replacement; preserve original phase |
| Concurrent generation claims | At most one durable pre-send update succeeds |
| Database failure or retained phase cap reached | Reject before provider dispatch |
| Oversized/incorrect serialized body or tools present | Reject before dispatch |
| Tool/steer/continue/summary request | Refuse without an additional model generation |
| Capacity refusal, abort or unknown result | Preserve consumed allowance |
| Readiness cache missing/stale/error | Unavailable with zero probe HTTP/count/lease work |
| Gateway phase absent or mismatched in Platform configuration | Generic unavailable response before probe HTTP/count/lease work |

Client errors retain coarse provider-neutral copy. Private identifiers, raw database
errors and credentials do not become public status fields.

## 5. Good / base / bad cases

- Good: one exact, currently authorized Chat/run consumes its phase before the sole
  outbound generation; fresh cached health is observed and normal settlement follows.
- Base: absent envelope preserves ordinary Chat and current fixed-model probing.
- Bad: an expired phase, second run or unknown first result is replaced to get another
  send. It must fail closed even after restarting the Gateway.
- Bad: a UI/catalog read warms health by calling Relay `/ready`; for this target it
  must read the cache only. Relay `/ready` itself performs paid inference.

## 6. Tests required

Use existing contract, worker loop, managed runtime, broker, Platform policy/cache and
actual PostgreSQL suites. Assert exact normal defaults and canonical slot validation;
real pinned-SDK serialized payload/tools/retry behavior; tool/continuation refusal;
duplicate/concurrent phase and generation claims using independent database pools;
restart/release/unknown-result no-reset behavior; byte/model validation before dispatch;
database and cap failure; fresh policy/epoch/kill-switch refusal; cache misses and errors
with no outbound calls or counter/lease writes; mismatched cross-service phase rejection;
supported `{}` catalog positives and invalid client overrides; and unaffected
nontarget/Jev paths. Capture the real worker's pinned-SDK request: the isolated
worker omits its reasoning option through the supported Agent thinking-level/off
mapping, output is 256 rather than a serialized null, model tools are absent, and
retries are zero. Omission does not establish that billable provider reasoning is
disabled. Do not replace that assertion with a hand-built body.

Final-source Preview VPS and Web Canvas/Web Desktop/Electron Desktop functional
acceptance remain delivery gates. Funding and access must be reviewed independently;
a funded-off Preview cannot establish a positive model turn or customer-primary repair.
Publish the public-safe behavior and limits in a separate `matrix-os-site/content/docs`
PR. Offline tests and registered bundle metadata are not live recovery evidence.

## 7. Wrong versus correct

Wrong: use a short prompt, count requests only in a runtime registry, delete the registry
on release, then interpret an unchanged owner ledger as proof of zero provider cost.

Correct: bind the reviewed phase in trusted composition, preserve its first run and
pre-send consumption in owner PostgreSQL, reject any second dispatch, and separately
record actual provider usage, owner settlement and remaining operational authority.

## 8. Server-only readiness diagnostics

Existing authenticated readiness calls may carry a server-created probe UUID. It
is diagnostic metadata only and never an authentication or admission input. The
Relay accepts only a bounded UUID and an optional 32-hex Cloud Run trace ID; it
replaces invalid UUID text and omits invalid trace text. Platform records an
independently generated receipt UUID, allowlisted ready model IDs and coarse
receipt outcomes. Same-process coalesced observers can link that receipt to the
actual dispatch UUID. Cached health from another replica does not retain its
originating probe identity; do not imply complete cross-replica attribution.

Log only fixed event names, allowlisted models and outcomes, HTTP status and
elapsed milliseconds. Never log prompts, response bodies, tokens, owner or
machine identities, URLs or arbitrary error names/messages. These fields do not
change client response schemas, readiness truth, call counts, request budgets,
timeouts or any security setting. An HTTP 200 receipt can still have an empty
ready-model set. Offline tests must cover correlated success, local rejection,
upstream status, timeout and hostile diagnostic/error text without an extra call.
