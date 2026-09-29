# Chat runnable model repair

## Scope

- Preserve the bounded, enabled model inventory discovered for the exact Pi or OpenCode native access source, including its saved default.
- Admit Hermes's built-in Codex subscription route from its own native metadata. A provider label alone must not authorize an unknown or custom credential origin.
- Confirm the built Hermes session's provider and model before submitting a Codex subscription prompt. Reject a different route, missing confirmation, native build failure, or transport failure with the existing generic Chat error.
- Present Matrix AI as a top-level Chat picker group with the shared rabbit mark. Every model choice retains a real server instance ID; the presentation group is never an execution identity.
- Retain unavailable managed routes with no selectable models. Show credit-required state only while its canonical readiness is fresh.

## Source of truth and bounds

V3 owns accounts, access sources, route eligibility, and funded readiness. Native runtime inventory owns the discovered model IDs. Compatibility Settings and Chat catalogs are projections. No catalog operation acquires a funded credential.

The existing per-instance Chat limit remains 64 models. Native coding catalogs retain the actual saved default when it falls beyond that limit. System catalogs distribute the same budget across authenticated provider inventories so one large inventory cannot erase another provider. No static replacement catalog is introduced.

Hermes `session.create` acknowledges the requested route; the subsequent non-lazy `session.info` reports the built route. Confirmation is bounded by the existing request timeout, capped at 30 seconds, and cancelled with the run. Restored sessions require fresh confirmation after the selected model is applied. The adapter also rejects later observed route changes. Native inference fallback behavior still requires runtime acceptance; notification monitoring alone is not proof that a downstream request never occurred.

## API compatibility and authorization

| Route | Authorization | Public | Change |
| --- | --- | --- | --- |
| `GET /api/chat-providers` | Existing gateway request principal | No | Optional `includeConnectionState=true` presentation negotiation |

`includeConnectionLabels` and `includeConnectionState` are independent opt-ins. Older strict clients receive their existing response shape. Web Canvas, Web Desktop, and Electron Desktop opt into both through their shared catalog consumers. Execution admission continues to validate the real instance, model, options, and immutable Chat binding.

## Validation

Regression coverage includes exact native access-source eligibility, large catalogs and saved defaults, missing or ambiguous Hermes credential metadata, new and restored Hermes route mismatches, cancellation/deadline cleanup, startup retries, native input round trips, credit-state freshness, old-client negotiation, and shared picker selection/lock behavior.

Runtime acceptance must record the exact official Electron package, installed runtime provenance, actual CLI catalogs, selected account/access source, effective execution route, and visible completion separately. New Chats and existing Chats are independent acceptance cases. An existing failed Chat must retain its history and binding while its recovery failure is investigated.

## Deferred scope

Settings Connect/Disconnect redesign, terminal changes, funded-readiness policy or credit changes, release-channel promotion, deployment, and public site documentation are outside this repair's authorized scope. A managed route becoming funded is a separate acceptance fact from its picker presentation. Existing Codex resume failures require their own native-session evidence; catalog tests do not establish their cause or recovery.
