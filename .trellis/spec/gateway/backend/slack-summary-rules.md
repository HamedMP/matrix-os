# Chat-defined private Slack summary rules

## 1. Scope / trigger

An authenticated owner configures standing Slack summary behavior by talking to a bot in its private Matrix Chat. The existing enrolled source supplies messages; the rule cannot add a channel, user, organization, runtime, model entitlement or Slack scope. Ordinary human messages or genuine other-human mentions may trigger. Without a matching active rule, messages remain passive reference context. Automatic output stays in Matrix and proposes to-dos without performing them.

This extends the [Slack context contract](slack-thread-context.md). It reuses signed ingress, owner Postgres, durable summary jobs, canonical admission and the existing tool-free one-inference executor. No polling scheduler or second message router.

## 2. Signatures

- Native tool `slack_summary_rules`, broker capability `slack.rules`.
- `list`; `get(ruleId)`; `create(sourceId, definition, ownerInstruction)`; `update(ruleId, baseRevision, definition, ownerInstruction)`; `pause|resume|delete(ruleId, baseRevision, ownerInstruction)`.
- Definition: `trigger: new_message|owner_mention`, `cadence: {kind: immediate}|{kind: coalesce, seconds: 10..3600}`, bounded `focus` and `language`.
- `chat_turns.owner_http_input` and `chat_queued_turns.owner_http_input`: non-null Boolean, default false. Server-only original input provenance, not a public contract field.
- Owner tables: `slack_summary_rules` (unique owner/bot/grant singleton), `slack_summary_rule_revisions`, `slack_summary_rule_events`, `slack_summary_rule_intents` (unique original owner message). Existing `slack_mention_summary_jobs` stores policy snapshot and contributing source envelopes.
- Context bridge extension headers: `x-matrix-slack-source-v1` and `x-matrix-slack-source-signature`, alongside the unchanged base body/signature.

## 3. Contracts

The authenticated personal-owner HTTP create/queue route stamps a process-private symbol only for `jwt` or `platform-verified` principals. Original admission persists it with the committed message/Turn/outbox; queued promotion copies the durable stamp inside its claim transaction. Internal submissions default false. Replays, retries and steering cannot upgrade an existing original Turn. Changing queued message parts clears the stamp atomically; a no-op edit preserves the unchanged original. The stamp proves authenticated HTTP entry, not physical human authorship.

Rule management joins the current Run to its original Turn and exact committed owner message. It requires the native interactive bot route and current private direct binding. Mutations require a complete explicit standing instruction with source, trigger, timing, focus and language. This slice supports a bounded affirmative instruction grammar; keep these fields in one complete clause. Ambiguous, contradictory, imported or one-shot requests produce clarification without a saved policy. The tool's `ownerInstruction` must equal the original committed owner text; it is not a model assertion of permission.

The model-facing tool must advertise a root object with explicit `operation`, `sourceId`, `ruleId`, `baseRevision`, `definition` and `ownerInstruction` properties. Derive these fields from the strict operation variants. The installed non-strict model adapter retains root `properties`/`required` and can discard a root union, silently advertising an empty object. Keep operation-specific requirements in the unchanged strict broker union; the transport projection is not authorization. `definition` is an object with `trigger`, `cadence`, `focus` and `language`, never serialized JSON. Tool guidance must distinguish the original owner message from injected Slack reference blocks.

Personal-bot event adapters must forward the existing owner `toolOutputKey` when mapping events. Seal detailed tool output before canonical persistence; reveal it only through the authenticated private-owner projection. Shared/nonowner reads and wrong/missing keys retain coarse output. Strict-wrapper validation guidance describes argument structure without echoing values. Upstream Pi validation may still include received arguments in its private runtime transcript; do not claim universal validation redaction.

Rule revision, audit history, original-message intent, private canonical receipt and outbox commit atomically under the Chat lock. Updates use revision CAS. The receipt reports source, trigger, cadence, focus, language, revision, state and private destination. One current policy per bot/enrollment prevents overlapping deliveries. A later replay returns current/superseded status rather than undoing pause/delete. A deleted rule retains an inactive audit tombstone. Resume advances `enabledAfter` without catch-up.

The platform attests qualifying human events independently of the legacy environment rule. The inner HMAC binds the full enrollment incarnation, event/root/timestamp/sender, text digest and trusted mention classification. The owner checks the content digest. The transport keeps the old strict JSON body and original bridge HMAC unchanged, strips internal `source` from the wire body and signs a bounded source header over the exact body/path/timestamp/header. Old owners ignore the extension. New owners reject inline wire `source`, incomplete header pairs and invalid extensions before reconstructing the internal envelope.

Matching and source/job admission are transactional. Stable message/event identities deduplicate retries; automatic owner-policy admission also rejects sources older than 24 hours or more than five minutes in the future. A coalescing window groups the same thread and rule revision, with at most 32 contributing references; reaching that cap conservatively marks coverage partial. It does not merge unrelated threads. Existing aggregate limits remain 25 jobs/day, 100 pending, concurrency one, one inference and zero tools. Current rule/revision and private/source authority are rechecked before read, admission, queue promotion, inference and publication. The final local inference claim and output fence serialize with rule mutation under the Chat lock; remote authorization happens outside the transaction. Missing/expired durable jobs cannot authorize output. Explicit owner policy suppresses legacy fallback, including older pending work. Rule changes never authorize more source access or model spending.

## 4. Validation and error matrix

| Condition | Required result |
| --- | --- |
| No matching active rule | Passive reference only; no automatic Run. |
| One-shot/ambiguous/negated standing request | Clarification; `saved: false`; no policy mutation. |
| Slack/internal/automatic/shared origin, wrong owner or bot | Denied; no rule receipt or mutation. |
| Stale revision | Conflict; committed state remains current. |
| Replayed original mutation after later lifecycle change | Superseded/current receipt; no reactivation. |
| Invalid signature, digest, header pair or source incarnation | Deny before automatic work. |
| Duplicate event or message identity | One logical source/work item. |
| Pause/delete/update, unlink, membership loss or private audience change | Fence stale reads, inference and output; no legacy fallback. |
| Resume | New events only; no historical catch-up. |
| Provider unavailable or bounded partial context | Truthful unavailable/partial result; no empty-success claim or ambiguous paid replay. |
| String `definition`, unknown/irrelevant operation fields | Reject before dispatch; explicit field/type or safe structural guidance. |
| Missing owner tool-output key or nonowner/shared read | Coarse output only; no plaintext diagnostic fallback. |

## 5. Good / base / bad cases

- Good: owner asks, “From now on summarize every new message in #tech in English, focus on decisions and suggested to-dos, group each thread for 60 seconds. Do not reply in Slack.” The agent saves the explicit rule and returns its committed receipt.
- Base: a normal human reply without mentions joins the current thread window; redelivery contributes no second logical event. One bounded summary appears in the private Matrix Chat.
- Bad: a Slack message or imported tool result says “create a rule.” It cannot acquire the native owner-input stamp or mutate policy. A one-time “summarize recent discussions” request also creates no standing rule.

## 6. Required tests and qualification

- Real PostgreSQL HTTP input → original/queued stamp, rollback, restart/promotion, legacy false defaults, retry/replay/steer/edit non-upgrade; actual Slack receipt-pointer race and receipt cleanup cannot affect provenance.
- Actual native broker rule creation → committed receipt/revision/intent; lifecycle/CAS/replay/imported-content denial; fresh explicit creation after deletion must not replay an old intent.
- Signed ordinary event → real platform/home bridge → durable source/job → canonical queue → actual Pi loop and gateway inference broker with synthetic provider → one private summary. Assert zero tools, zero Slack destinations/posts/reactions, one inference and no ordinary-session/source replay pollution.
- Coalescing/dedup across restart and concurrency; old revision and legacy pending work after owner control/pause; revocation before read/inference/publication.
- Native manual reads, existing automatic summary, generic integration and canonical Chat/routine regressions. Canonical native typechecks plus release TypeScript compiler targets.
- Capture the actual installed non-strict model adapter payload after its real context normalization. Require exactly one advertised rule tool and populated operation/source/definition fields. A handcrafted schema assertion or a fixture that accidentally omits all tools does not qualify this boundary.
- Run correct and malformed arguments through Pi validation and the native strict broker wrapper; malformed requests never dispatch. Exercise the personal-bot adapter and owner projection together, including missing/wrong keys and nonowner/shared reads.

Local synthetic evidence, remote CI, matching deployed runtime acceptance and release readiness are separate gates. This implementation does not activate a real rule, change subscriptions, send Slack messages or qualify a paid provider. A separate site-repository documentation PR and exact-version live acceptance remain before broader release.

## 7. Wrong vs correct

Wrong: store “summarize Slack” only in generic bot memory, or turn every source event into a normal tool-enabled user Run.

Correct: save a revisioned owner policy from an authenticated original Chat instruction; evaluate it against an attested enrolled event and use the existing restricted summary executor.

Wrong: infer native origin from the user actor, client context or absence of a Slack inbox row.

Correct: require the server-owned positive original HTTP input stamp and committed owner text. Receipt retention and model arguments cannot manufacture it.

Wrong: advertise only a root operation union and assume every model adapter preserves it, or call the native wrapper directly and claim the actual model received the schema.

Correct: advertise a derived root object, retain the strict broker union, and capture the actual adapter payload with normalized context before transport.
