# Ordinary Chat usage classification

Status: active. Engineering scope: ENG-355. This is an ordinary-Chat analytics feature; it does not qualify Gmail processing or change model routing.

## Goal and user outcome

Owners can understand which tasks their AI usage serves and compare measured model, harness, access source, tokens, cost and latency by task category. Classifier labels describe work, not quality or an instruction to select a different model. Missing measurements remain unknown.

Hamed selected a Matrix-owned transient classifier that persists tags only. Cloudflare's stored-content Log Classification remains disabled on the protected gateway. The feature defaults off; owner configuration, actual transport wiring, review and live evidence are required before activation.

## Data and authority boundary

- Classifier admission requires the existing `modelHistory.inspect` result to be positively `ordinary`, derived from a canonical server-created empty-chat birth. A missing Google marker, `googleOrigin:false`, caller metadata, an old/imported chat or a text scan is insufficient.
- Root composition calls the capture hook only inside the already authorized provider send, after final provenance and binding checks. The hook binds owner, chat, run, runtime handle, execution generation and request ID to a private opaque receipt.
- The immutable snapshot comes from that exact inference body. Only bounded user/assistant plain text is eligible. Tool results, tool schemas, system text, attachments and future history are not loaded. A receipt cannot be serialized, forged, borrowed across a service instance or used twice.
- A trusted successful-completion hook runs only after the response has been fully read and final release checks have passed. It supplies actual measured facts. Primary failure/cancellation cancels the receipt. Normal successful run completion does not retrospectively invalidate a completed generation.
- Gmail, mixed, unknown, deleted, cancelled and failed contexts are excluded. Revalidate ordinary provenance before classifier dispatch and again under the shared context transaction lock before storing tags. A taint/deletion while queued or in flight aborts/discards classification. No database/global context lock spans a model request.
- The model transport is dedicated to classification, must honor AbortSignal and payload suppression, and receives no owner identifiers. Private async-local execution context prevents recursive classification. No classifier failure changes the primary generation result.

## Module contracts and host wiring

`createChatAnalyticsStore(ownerKysely)` owns no pool. It provides migrations, explicit owner policy configuration, admission inspection, metadata-only completed generation persistence, generation revalidation, atomic tag commit, bounded owner aggregation and deletion/expiry.

`createTransientChatClassifier({store, classify, enabled:false, limits})` provides `capture({binding,api,body,signal?})`, nonthrowing `completed(receipt,facts)`, `cancel(receipt)`, `deleteOwner`, `deleteChat`, `whenIdle` and bounded `close`. The root owns broker hooks, configured model transport, account/Chat deletion notifications, authenticated aggregate/CLI surfaces and live validation. A disconnected dependency-injection module is not feature completion.

Completion facts are model ID, harness, access source, input/output/cached-input tokens, cost, latency and server completion time. The classifier does not infer those facts. Unknown facts are null. CSPRNG sampling is server owned and independent of caller-chosen IDs. Unsampled eligible generations can retain metadata-only facts without copying prompt text, allowing observed classified/unclassified coverage; reports do not extrapolate dropped or unsampled categories as known.

## Persistence and deletion

Three small owner-controlled PostgreSQL tables contain policy and metadata only:

1. Owner policy: explicit enabled state, sampling basis points and a fresh UUID policy epoch.
2. Per-chat scope epoch: owner/chat identity and a UUID epoch, with owner-policy and Chat foreign keys.
3. Completed generation facts and nullable v1 tags: exact owner/chat/run/runtime/request identity, immutable measured facts, capture/completion/expiry times and sampling state. Foreign keys cascade on actual owner-policy/Chat/run removal. No prompt, completion text, snapshot, tool content, reason, entity or content fingerprint is persisted.

Owner deletion removes policy, scope epochs and generation facts in one context-locked transaction. A later explicit enable gets a fresh UUID and cannot revive a pre-deletion receipt. Chat analytics deletion rotates its scope epoch and deletes its facts atomically; late completions using the old epoch are denied. Queries remain owner scoped and exclude current nonordinary contexts. Retention defaults to 30 days and bounded cleanup removes expired/ineligible rows. The host invokes cleanup periodically and closes the classifier before destroying its owner database.

## Fixed v1 taxonomy

| Family | Types |
| --- | --- |
| coding | generate, debug, review, explain, refactor, tests |
| research | lookup, compare, synthesis |
| writing | draft, rewrite, summarize |
| translation | translate |
| planning | plan |
| data_analysis | analyze |
| question_answering | answer |
| other | other |

Complexity is low/medium/high. Optional confidence is finite and between zero and one, explicitly an uncalibrated model self-report; it is never shown or aggregated as probability of correctness. Output is strict and rejects extra properties, free-text reasons, entities and incompatible family/type combinations. These are model-produced estimates, not measured quality or verified user intent. Reporting accepts one to four allowlisted dimensions and at most 200 groups; its group limit applies after aggregation over the requested range, never to a pre-sampled set of raw rows.

## Bounds and shutdown

All admitted receipts, queued jobs, active requests, per-owner jobs and total snapshot bytes have hard caps. Admission/queue TTLs are swept on a recurring unref'ed timer and before admission. Snapshots are released on cancellation, expiry or completion. Each classifier request has an abort deadline. Classifiers that ignore cancellation retain their occupied active slot until their real operation settles; shutdown reports an incomplete drain instead of claiming quiescence or silently reusing capacity. The feature never installs a local service or runs heavy work on the Mac.

## Access matrix

| Operation | Authority |
| --- | --- |
| Capture/complete | Private server broker hooks; no HTTP or worker-controlled entry point |
| Classifier model call | Dedicated configured server transport; no raw payload persistence or recursive completion hooks |
| Policy configuration | Root must expose only authenticated owner settings, with normal applicable processing disclosure |
| Aggregate/read/delete | Root must authenticate the owner and supply its own principal; never accept a body-supplied owner as authority |
| Migrate/expire/close | Owner database host lifecycle; no pool ownership transfer |

## Verification

Tests first cover taxonomy, malformed output, immutable bounded snapshots, positive ordinary admission, Gmail/mixed/unknown exclusion, forged/replayed receipts, cancellation before completion, successful completion after run shutdown, taint before send and commit, queue/byte/owner/active caps, sampled/unsampled coverage, timeouts, recursion, deletion races and an honest incomplete shutdown drain. Owner PostgreSQL tests exercise actual model-history births, context locking, metadata-only persistence, owner isolation, aggregation, fresh epochs, cascade and retention. Root then wires and tests exact real transport/broker paths, authenticated reporting and every affected live surface. Public documentation must ship in `FinnaAI/matrix-os-site` alongside implementation.

## Primary research references (checked 25 October 2026)

- [OpenRouter classifiers](https://openrouter.ai/docs/guides/features/classifiers): asynchronous sampled tagging and fixed taxonomy reporting motivate the task/complexity view. Matrix does not copy its serialized-prompt log persistence.
- [Cloudflare Log Classification](https://developers.cloudflare.com/ai-gateway/observability/log-classification/): analyzes stored request/response content and requires log collection. This is incompatible with the selected tags-only approach on the Gmail-protected gateway.
- [Helicone custom properties](https://docs.helicone.ai/features/advanced-usage/custom-properties): measured cost/latency segmented by feature/workflow motivates owner reporting dimensions; no content-bearing arbitrary metadata is accepted here.
- [LiteLLM auto routing](https://docs.litellm.ai/docs/proxy/auto_routing): separates task/complexity classification from routing decisions. Matrix v1 reports usage only and does not automatically move a request to another model.
