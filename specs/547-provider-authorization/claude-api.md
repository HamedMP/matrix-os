# Claude API connection for Matrix AI

Tracking: ENG-117. Owner approved this phase after the focused Matrix AI picker
correction in PR #2227. This document specifies the API-billed route; it does not
establish deployed or paid inference acceptance.

## Outcome

Settings → Agents & providers → Matrix AI → Your connections offers ChatGPT
subscription and **Claude · Anthropic API**. The Claude action accepts the owner's
Anthropic API key. Copy states that Anthropic bills each request separately from
Claude subscription allowance and Matrix AI credit. Reuse existing card, form,
button and spacing conventions. No extra interactive Bot enable checkbox.

The Matrix AI model category includes qualified Claude API models alongside
Matrix-funded Claude/GLM and personal GPT. Equal model IDs from different payment
sources remain distinct choices. A selected source never silently switches to
another account, Matrix credit, native Claude Code or OAuth.

Native Claude Code continues independently. Its key/login workflow must not be
invoked as a substitute for connecting the managed Matrix Pi source.

## Authority and credentials

Reuse the canonical protected owner Anthropic key file and existing guarded
atomic saver/rollback. Extend its version-1 document compatibly with an optional
opaque credential generation. Every sanctioned save, replacement and revocation
advances generation. A legacy document remains usable by its existing consumers
but cannot authorize this explicit source until an explicit Connect qualifies it.

Store Matrix-enabled intent and source revision separately from credentials.
Private bounded idempotency metadata never enters public status responses.
Connect, replace and disconnect require compare-and-swap under the shared durable
credential writer guard. Failed verification or failed publication retains the
prior source and key; uncertain rollback keeps admission fenced.

Matrix Disconnect disables and revises only this source. It preserves the shared
key and native consumers. Global key removal invalidates this source's generation.
Every inference and continuation rechecks the selected generation, source revision
and model. Recipe tool preparation and dispatch also revalidate the captured source even when native key removal has not aborted the run signal. Integration tools check again after inventory, approval and the final grant read, immediately before service invocation; artifact writes check after staging and close, immediately before rename or exclusive publication. A refusal before the effect cleans temporary files and remains definite; an already-entered external call retains its existing uncertainty and no-replay policy. Cancellation must not replay ambiguous paid requests or tool effects. A replayed old Disconnect cannot withdraw a newer qualified catalog.

Persist only bounded nonsecret source/model/generation/revision references in
ordinary Chat and supported recipe Bot selections and runtime bindings. The
private broker owns the key; it never reaches renderer responses, model context,
Pi worker environment, public logs or platform credentials.

## Private API

| Route | Method | Public | Auth and behavior |
| --- | --- | --- | --- |
| `/api/ai/matrix-connections/anthropic` | GET | No | Authenticated runtime owner on the selected Computer; nonsecret capability/status and generation-qualified models |
| `/api/ai/matrix-connections/anthropic/connect` | POST | No | Same owner; strict key/CAS/idempotency input; fixed-origin verification and guarded publication |
| `/api/ai/matrix-connections/anthropic/refresh` | POST | No | Same owner; strict CAS/idempotency; qualify the captured current source without enabling or selecting it |
| `/api/ai/matrix-connections/anthropic/disconnect` | POST | No | Same owner; strict CAS/idempotency; disable/fence Matrix source while retaining shared credentials |

Missing authentication returns 401; authenticated nonowners return 403 before
credential reads or upstream probes. Missing server dependencies return safe 503.
Use bodyLimit before buffering every mutation, strict bounded Zod contracts,
private no-store responses, bounded requests/queues/caches and shutdown drains.
Never accept a provider URL or return raw upstream errors.

Discovery uses fixed `https://api.anthropic.com/v1/models`, redirect rejection,
finite timeouts and bounded response parsing/pagination. It observes actual model
IDs and capabilities rather than importing funded aliases or asserting allowance.
HTTP success/model discovery does not prove remaining credits or paid inference.
Expired/failed discovery preserves saved source intent and offers explicit recovery.

## UI and applicability

AiProviderSnapshotV3 owns the qualified Matrix Anthropic source, model inventory, revision/generation and readiness. Settings and Chat are compatibility projections of that canonical field; connection status and mutation receipts return the same projection. Owner-only opt-in wire fields preserve older strict clients. Missing canonical authority fails closed.

Use shared state and clients across Web Desktop, Web Canvas and Electron Desktop.
Capability denial, unsupported backend, loading, unavailable models, failed
replacement, disconnect and retry have truthful states. Accepted current
owner/Computer mutations and failed discovery reconciliation invalidate the scoped
provider catalog; replacement verification failure retains the existing source. Opening the
picker does not start another discovery, autofocus Search or reset drafts. Connection cards consume the existing canonical observation without an additional mount probe. A lost Connect response triggers bounded status reconciliation; changed authority replaces stale CAS intent, while an unchanged authority preserves an exact retry and a usable prior connection.

Ordinary Chat and recipe Bot routes require separate admission qualification. Both canonical picker instances project at most 64 models from the bounded discovery catalog. Invalid or partial recipe source bindings return a nonretryable selection error before run admission.
Custom Bot routes remain excluded from choices and save boundaries until separately
qualified; an available ordinary catalog row is insufficient. Recipe Bot model saves require a complete, current source revision and credential generation binding. Preserve unrelated
custom Bot edits and historical saved identities as unavailable without rewriting.
Integration/MCP and tool execution keep existing permission intersections, approval
and cancellation semantics. No source choice expands permissions.

## Acceptance

Write failing regressions before implementation for strict DTOs, secret rejection,
all canonical generation writers, legacy compatibility, CAS, duplicate/payload
reuse, publication rollback and restart fencing. Exercise the authenticated route
boundary and actual shared connection controls, identity changes, failed replace,
recovery, no source fallback and exact ordinary/recipe runtime binding.

Run affected checks plus full types, patterns and current-head CI. Backend changes
require the exact immutable bundle on the already authorized Main Computer and
matching production Electron package. Use only a genuinely configured owner API
key for real Claude text, tool continuation, supported Bot, Integration/MCP,
history/resume and Stop acceptance. Never borrow funded platform credentials or
subscription tokens. Record discovery, actual inference and deployment separately.
Present exact-head runnable UI for Human Review before subsequent review/merge.

Extra providers, new VPSes, fleet rollout and public-site documentation are deferred
by the owner. Preserve existing native, funded and personal ChatGPT behavior.
