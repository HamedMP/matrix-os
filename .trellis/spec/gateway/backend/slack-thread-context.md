# Read-only Slack channel and thread context in a PR preview

## 1. Scope

Ordinary human messages in an explicitly enrolled public Slack channel or thread can supply reference context to one selected private Matrix bot. Without a matching active policy, an ordinary message never admits a Chat Turn or Run. A [Chat-defined owner rule](slack-summary-rules.md) may admit a restricted private summary for all new human messages or genuine mentions by another human, at explicit immediate or bounded per-thread cadence. The earlier environment mention pilot remains a separate legacy path and is suppressed once an owner policy takes control. A channel grant accepts new top-level posts and thread replies. A legacy thread grant accepts replies in its exact thread. The owner may also ask that selected bot to fetch bounded recent history through its native integration tools. Permanent historical backfill, edits, deletion reconciliation, group DMs and outbound actions are outside this contract.

## 2. Interfaces

| Entry | Authority and effect |
| --- | --- |
| `POST /webhooks/slack/events` | Slack raw-body HMAC, timestamp, app and active workspace installation. Exact opted-in channel or thread. Claim and settle the existing event receipt without a send/reaction destination. |
| `POST /api/internal/slack/context` | Existing path-bound owner bridge signature. Check the exact runtime, owner, active private Chat and selected bot binding before committing a reference. |
| `POST /internal/slack/thread-context/access` | Registered machine bearer, matching runtime and owner, and the same grant digest, bot and Chat. Check current installation, linked Slack identity, Matrix membership and Slack access. Return an authorization result. Explicit `includeChannelMetadata: true` may also return the current authorized channel ID and validated display name. Legacy requests retain the strict boolean response. |
| `BotRunSpec.slackThreadReference` | Optional bounded reference text for a later interactive private bot run. The reference grants no permissions and cannot select tools. |

## 3. Contracts

- `SLACK_PREVIEW_THREAD_CONTEXT_GRANT` is optional JSON for the isolated platform only. It pins `appId`, `teamId`, `organizationId`, `ownerId`, `ownerSlackId`, `channelId`, `botId`, `chatId`, `runtimeId`, `installationGeneration`, and `linkCreatedAt`. Channel-wide enrollment additionally requires `scope: "channel"` and excludes `threadTs`. Legacy grants with no scope, and explicit `scope: "thread"` grants, require `threadTs`. Omitting a legacy root fails closed. Legacy parsed field order and serialized grant bytes stay stable, preserving the grant digest and retry receipts. A different link or installation generation invalidates the old grant. An invalid optional grant disables this path while the existing Slack route remains available. The owner context service uses the registered PR-preview runtime identity.
- Only `type: "message"` and `channel_type: "channel"` qualify. In channel mode, `thread_ts ?? ts` gives the source root, so top-level posts and replies under different roots are retained. Thread mode still requires the exact `thread_ts` distinct from `ts`. The Slack sender remains message provenance. Matrix authority comes from the enrolled owner's verified link and current Matrix and Slack membership. Slack API checks are bounded and use the installed bot token.
- Owner thread references live in `slack_private_thread_context` and are keyed by grant and Slack message timestamp, with a separate unique grant and event ID fence. Insert, deduplication and the 64-row owner retention cap run in one transaction. The canonical Chat transcript stays free of the raw Slack messages.
- A current channel display name comes from the existing `conversations.info` read made while revalidating context access. It is optional display metadata. The provider channel ID must match the authorized grant before the label can be returned, and the owner reader applies it only to references with the same channel ID. The shared schema caps names at 80 characters and excludes whitespace, controls, format characters, and Slack markup delimiters. Missing or invalid optional provider names leave an ID-only reference. Invalid responses at the owner boundary deny access. Metadata opt-in preserves the old boolean access client and the old grant digest. Existing stored references gain a current name without mutation or history fetch.
- Reference text has a 4 KiB UTF-8 prompt cap. The broker checks the grant when the worker requests its spec, then the worker presents the excerpt as quoted untrusted data in the current model request copy. Channel labels such as `#tech` are JSON-quoted alongside the source ID and included in the same byte cap. The raw block stays out of replayable messages and compaction history. A prior answer can still reflect content the bot was authorized to read at the time.

## 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| Missing or invalid Slack or bridge signature | `401`. |
| Wrong channel, a root outside a thread-scoped grant, app or bot sender, subtype, or Slack Connect source | No context admission. |
| Expired grant, lost membership, unlink/relink, or different runtime | Deny access to stored references. |
| Successful retry or same Slack timestamp | Existing receipt or stored row makes delivery idempotent. |
| Conflicting payload for a claimed provider event ID | `409`. |
| Retryable delivery failure | Generic failure and retry through the existing receipt lease. |
| Provider returns metadata for another channel ID | Deny access before the label reaches the owner context. |
| Optional provider name is missing, malformed, too long, or contains controls | Preserve the authorized source ID and omit the label. |
| Owner receives malformed access-response metadata or metadata with a mismatched channel ID | Deny the context read. |


## 5. Examples

An owner reader opts into current display metadata using the existing access route.

```json
{
  "ownerId": "user_owner",
  "botId": "bot_12345678",
  "chatId": "chat_12345678",
  "runtimeId": "runtime_preview",
  "grantId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "includeChannelMetadata": true
}
```

```json
{
  "allowed": true,
  "channel": { "id": "C123", "name": "tech" }
}
```

The prompt retains `channel: "C123"` and adds `channelName: "#tech"`. A request without `includeChannelMetadata` keeps the legacy `{"allowed": true}` response.

- Good. A teammate sends a plain post or reply in the explicitly enrolled channel. The selected private bot gets one reference in its next eligible prompt. The stored root preserves the post/thread identity.
- Base. A Slack retry produces no additional reference, Run, Slack write, or reaction.
- Bad. The same owner opens another bot or moves to another machine. That bot or machine cannot read the enrolled context.

## 6. Required tests

- Sign an ordinary reply locally and exercise the platform webhook, signed owner bridge, persisted owner reference and exact prompt reader. Redeliver the event, send a different event ID for the same timestamp, and assert one reference, zero Runs, and zero Slack writes or reactions.
- Exercise legacy and explicit thread grants rejecting a different root and top-level posts, while an explicit channel grant admits both. Check stable legacy serialization and reject missing-root legacy grants. Exercise wrong channel, owner/runtime/bot, missing membership, revoked link, app/bot sources, subtypes and external shares. Verify the existing DM and mention paths independently.
- Enrich already stored signed references with a current provider channel name using one existing info call. Check wrong-channel metadata, missing/invalid/long/control labels, legacy boolean requests, opt-in responses, revoked membership, and the UTF-8 prompt cap.
- Check the broker spec for a later eligible private turn. A mocked model can see references while the original user prompt and persisted replay history contain none of the raw Slack block.

## 7. Implementation rule

Wrong. Forward every approved Slack channel event to the personal DM submitter, which admits a Turn and may react or send a reply.

Correct. Check the explicit channel grant or exact thread grant, forward via the context-only signed bridge and commit the owner-scoped reference. An eligible private Run can read it through the current grant.

Wrong. Hardcode a channel ID to a display name or use a label as enrollment authority.

Correct. Obtain the current provider label for the already authorized channel ID and attach it as bounded reference data at read time.


## 8. Optional recipient mention summary pilot

`SLACK_PREVIEW_MENTION_SUMMARY_RULE` is a separate optional JSON object. Its strict shape is `{ruleId,version,grantId,enabledAfter}`: a safe 1–64 character rule ID, positive integer version, unchanged read-grant SHA-256 digest, and ISO not-before time. A missing or invalid rule disables automation only. It never changes the existing read grant, app scopes, installations, ordinary DM routes or legacy access response. It is configured only for the reviewed PR-preview runtime.

Only a new real human other than the linked recipient can trigger. The event must pass existing channel/source filters, the exact read grant and all current access checks, and contain an active user mention of `grant.ownerSlackId`. Code, quotes, escaped examples, link labels, self-mentions, app/bot/subtype messages, external shares, and unknown rich-text structures do not trigger. A teammate need not have a Matrix account: the sender remains Slack provenance, while the linked recipient supplies Matrix execution authority. Ordinary posts/replies continue to update reference context without a Run.

Platform attaches `envelope.summary = {ruleId,version,proof}` only after that admission. `proof` is a domain-separated source HMAC bound to the configured grant, rule and exact event/root/timestamp/sender tuple. It is carried only through the signed owner bridge and private owner job. It is never included in model input, canonical Chat, public responses or logs. Possession of a machine credential cannot mint a proof for a different root or sender.

### Private broker payload

The explicit private variant uses the existing `POST /internal/slack/context` route:

```json
{
  "ownerId":"user_owner","botId":"bot_12345678","chatId":"chat_12345678",
  "runtimeId":"runtime_preview","grantId":"<64 hex grant digest>",
  "summary":{"ruleId":"owner_mentions","version":1,"eventId":"Ev123",
    "threadTs":"1795000000.000001","ts":"1795000001.000001","userId":"U456","proof":"<64 hex source proof>"}
}
```

The machine-authenticated route verifies the current rule and source proof, derives channel ID from the grant, and uses the proved signed root. It does not create a Slack reply/reaction destination. Current app and linked-recipient conversation access, installation/link generation, organization membership, owner/bot/Chat/runtime and exact rule are checked before and after bounded retrieval. At most three pages of 15 messages and 16 KiB of source are retained; a provider cursor/page cap sets `partial`, never a claim of complete coverage. Provider failures are unavailable, not an empty successful thread. The response includes trusted `recipientUserId` from the grant so the summary distinguishes the owner's mentions and proposed to-dos. Display labels remain optional, validated metadata.

| Route or execution boundary | Authentication and authority |
| --- | --- |
| Slack events → summary marker | Existing raw Slack HMAC and event receipt, current opted-in read grant/rule, real other-human active mention, no historical catchup. |
| Owner context receive → job | Existing exact path/body bridge HMAC; active private direct Chat/bot; source insert and job insert share one owner transaction. |
| Private thread broker / access with `summary` | Registered owner machine bearer; current exact grant, rule and source HMAC; owner link/org/install/Slack membership rechecked. |
| Canonical summary admission / queue | Process-private symbol and reserved deterministic request ID. Public bodies cannot provide provenance. |
| Bot adapter / model send | Durable job joined to canonical owner/Chat/Turn/Run/request/actor/normalized parts and first attempt; recheck local private binding after remote access returns. |

The owner table `slack_mention_summary_jobs` retains the immutable signed source and metadata for 24 hours. The source reference and pending job commit atomically. Durable logical message identity uses grant + rule ID/version + channel + timestamp, excluding the event-specific proof; a second unique event identity prevents event reuse. This dedup remains effective after the passive 64-reference retention window evicts the original row. The pilot caps creation at 25 jobs per UTC day, pending work at 100, and summary concurrency at one. Leased claims get at most five bounded exponential admission retries. A lost canonical acknowledgment reconciles the same deterministic request against the existing canonical Run/queue, never starts a second logical Run, and never repeats an ambiguous paid call. Terminal/expired leases and raw records are cleaned by the bounded owner drain; shutdown aborts access work and drains owned resources. Disabling/replacing the rule prevents pending/model work after current authority revalidation.

### Enforced read-only execution

The existing canonical Matrix bot adapter derives summary mode from the durable receipt, never from model text or an HTTP `readonly` flag. Both runtime binding and worker spec have `capabilities: []`; no tools, routines, tasks, memory, attachments, owner SOUL, unrelated Chat history or steering are admitted. The task gets a fresh private task rather than continuing a waiting manual task. A fixed policy requests a Chinese summary and a **textual suggested to-do checklist**, including source/people/time/coverage. It does not claim to execute any to-do.

The broker rejects nonempty model tool definitions and non-text/history payloads. One durable compare-and-set at the final provider dispatch enforces a single inference even if a worker retries or bypasses its own limit. Output is capped at 2,048 tokens. This pilot supports existing included completions and messages inference paths; `openai-responses` routes fail closed instead of inheriting unrestricted behavior. Broker session load/save is ephemeral for this run and never reads, replaces or tags the ordinary Personal Assistant session. Source is injected only into the current model-request copy, under the existing 16 KiB source ceiling; ordinary passive reads retain their 4 KiB cap.

Public retries of a summary-origin Turn, queued-message edits, steering a summary queue item into an ordinary tool-enabled Run, and shared/published queue promotion are refused. The immutable original Turn identity is checked as well as the current Run request ID. Missing summary service/authority cannot fall back to normal tool-enabled execution. Canonical Chat stores only the fixed automatic request and resulting summary, not the raw source, proof or replayable thread history. No Slack outbox is created.

Required regression: signed teammate mention → atomic owner job → existing canonical queue promotion → actual Pi loop → real gateway inference broker with synthetic provider HTTP → private committed summary. Assert ordinary/code/self messages admit no Run, same event/message stays single, no source/proof in canonical history, no ordinary-session writes, no tools, at most one provider dispatch, recipient mapping and bounded partial context, current revocation, canonical retry/queue steering/edit denials, daily/retry/TTL bounds, and zero Slack posts/reactions/destinations. Local synthetic/CI evidence does not qualify a live Slack mention or a paid provider acceptance.

The existing canonical private-authority transaction helper also fences summary-origin admission and output. It checks historical sharing under the same Chat row lock held by canonical admission/output and sharing transitions, so an asynchronous broker authorization snapshot cannot publish private automatic output after a concurrent share. Source reads separately revalidate live local and remote authority. Project sharing enrollment treats an outstanding summary-origin queue like other private automation and refuses promotion into shared authority. These checks supplement the broker's current remote membership checks; a successful read at model admission does not grant later publication authority.

## 9. Native owner-requested history reads

The enrolled installation is a scoped read source injected into the existing `integration.inventory` and `integration.call` broker. It is distinct from a general connected-services account. Do not create synthetic account rows, broader bot grants, another tool or message router, or a signed mention proof for a manual request. Inventory identifies the enrolled source with an opaque connection ID and includes its supported action/argument contract. It can remain usable when unrelated account inventory is unavailable. A recognized enrolled source ID must never fall back to another account on denial or failure.

The source allows only `slack.list_messages` (bounded recent channel history) and `slack.list_replies` (a bounded thread). Channel is derived from the existing grant; no channel selector is accepted. Unknown arguments, arbitrary provider methods/URLs/cursors, workspace search, Slack writes and reactions are rejected. Recent-history reads require an explicit channel-scoped grant; a legacy thread grant cannot widen itself by omitting a root. A thread-scoped read remains pinned to its enrolled root.

| Entry | Authority and effect |
| --- | --- |
| Native integration inventory/call | Existing live canonical bot binding, declared recipe read effect, exact current enrolled owner/bot/private Chat/runtime grant. Other connections retain their ordinary account-grant authority. |
| Existing `POST /internal/slack/context`, strict `manual` variant | Registered runtime bearer and exact owner/runtime/access tuple. Current grant, installation/link generation, Matrix organization membership, internal Slack channel access and linked owner membership are checked before and after bounded reads. No summary proof or Slack output receipt is created. |
| Source result release | Recheck current local private Chat/bot binding after the remote read. Provider errors or authority changes are unavailable/denied, never successful empty history. |

Manual reads retain at most three pages of fifteen messages, 16 KiB of source and an eight-second provider deadline. Keep provider cursors internal, validate thread identity, report partial coverage on caps, and preserve channel name/ID, Slack author, message/root timestamps and source links. Treat every provider text as untrusted reference data. Tokens stay on the platform. These user-requested tool results follow the normal private agent transcript lifecycle; they do not silently backfill passive references or change the ephemeral, tool-free automatic summary contract.

Required tests exercise the real native broker/source/client/Hono/provider boundary with source content absent from the owner request. Cover wrong owner/bot/Chat/runtime/channel, legacy scope widening, stale grant/install/link, membership loss or sharing during a read, undeclared/search/write actions, upstream errors, malformed/oversized pages, page/byte bounds and generic-account regression. Preserve ordinary no-Run ingress and automatic summary restrictions.

Live acceptance requires a fresh instruction-only owner request, actual successful native history/thread tool calls and returned source evidence, and the generated English summary and suggested to-dos displayed in Matrix. Prior pasted snapshots, zero-tool model answers, a connected label, local tests and CI alone do not establish native provider acceptance. No Slack publication is part of this read path. Wider availability still requires a separate public site documentation PR and release qualification.

## 10. Preview Slack-only transport composition

`MATRIX_SLACK_PLATFORM_URL` and `MATRIX_SLACK_PLATFORM_TOKEN` are an optional operator-owned pair for an existing PR Preview. They change only the existing Slack owner client and signed receiver. Core `PLATFORM_INTERNAL_URL` / `UPGRADE_TOKEN`, sync, funded AI, routine actions, updates and generic integrations keep their original configuration.

- With neither override key present, preserve the existing core-pair Slack behavior.
- With either key present, require both nonempty values, a bare UUID `MATRIX_MACHINE_ID`, `MATRIX_PREVIEW_RUNTIME=true`, an own `pr-<positive integer>` handle equal to `MATRIX_RUNTIME_SLOT`, and an HTTPS origin whose host is `<own-handle>---matrix-platform-preview-<service-suffix>.a.run.app`. No credentials, explicit port, non-root path, query, fragment, arbitrary hostname or IP literal is accepted. The token is exactly 64 lowercase hex characters and must match `MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN` when that existing inbound token is provided.
- Partial/invalid configuration disables Slack only. Never fall back to core credentials after detecting an override. Pass an explicit `null` to bot composition to preserve this distinction from legacy callers that omit the option.
- Generic integration-client availability preserves its original core Preview eligibility even when Slack is disabled. A Slack-only enrolled source may also use the existing unavailable-account fallback to expose native reads; it creates no generic account/grant or working core transport.
- Resolve once at gateway startup. The same connection controls ordinary Slack transport, receiver HMAC/source-extension verification, enrolled native reads, context revalidation and restricted summary/rule reads. No second provider route, Slack grant or OAuth scope is introduced.
- Apply/remove the pair atomically in the isolated host environment; restart the existing gateway to consume it. Keep enrollment, owner/runtime and existing inbound API authority unchanged. Configuration validity does not prove provider readiness or live Slack acceptance.

Regression tests must exercise selected RPC origin/Bearer, selected receiver HMAC versus rejected core HMAC, actual bot startup/context access, explicit-disabled behavior, absent-override compatibility, and invalid-origin/token/runtime cases. Use synthetic Slack/provider fixtures and disposable PostgreSQL; do not consume live Slack or AI to test composition.

## 11. Fresh enrollment discovery without an event prerequisite

The registered runtime can discover its **already configured** exact owner/Bot/private-Chat enrollment before any channel event. `POST /internal/slack/thread-context/enrollment` uses the existing runtime-HMAC-derived Bearer and handle authority, a 4 KiB body limit, strict `{ownerId,botId,chatId,runtimeId}` input, no-store response, and the existing 1.5-second Slack access deadline. No grant ID, channel, workspace, scope, event, cursor or token selector is accepted.

| Boundary | Required authority / result |
| --- | --- |
| Before provider access | Authenticated current owner/runtime and exact requested configured target; current installation generation, linked owner incarnation and Matrix membership. |
| Provider metadata | App can access the internal conversation, linked owner remains a member, provider channel ID equals configured grant channel ID, bounded validated channel name. Missing/invalid display metadata makes discovery unavailable. |
| After provider await | Reauthenticate the current runtime; recheck current installation/link/Matrix authority and cancellation before returning the same immutable configured grant. |
| Owner gateway callback | Check actual active personal/private direct Chat and selected Bot before and after the callback. Strictly validate the returned full target, metadata identity and scope; a configured callback is authoritative. False, malformed, mismatched, unavailable or thrown results never fall back to cached events. |

A success returns `available:true`, existing `access` (including unchanged grant digest), `appId`, `teamId`, `channelId`, provider `channel:{id,name}`, and `scope:"channel"` or `scope:"thread"` plus exact `threadTs`. Require `channel.id===channelId`. A denial returns only `{available:false}`; invalid authentication is 401, malformed body 400, oversized body 413 and provider failure a generic unavailable response. No credentials or discussion content are returned, and discovery writes no context, policy, job or Chat row.

Example request: `{"ownerId":"user_fixture","botId":"bot_12345678","chatId":"chat_fixture","runtimeId":"runtime_fixture"}`. Channel identity is derived solely from the current configured grant. Do not mint a grant, seed a message or backfill history to make setup available.

Native inventory/history and owner-native rule setup reuse `enrollment()`. Discovery metadata preserves thread-only grants: inventory advertises the exact root, native calls reject recent channel history or other roots, and the existing platform grant/event/private-read fences remain authoritative for rules and automatic jobs. Existing thread rule support is retained. Legacy callers with **no** discovery callback keep the cached-event path; a configured callback may never silently downgrade to it.

Required local evidence: actual Hono/client + PostgreSQL zero-context success; identity/auth/metadata/size/provider and local sharing/retirement races; explicit-denial/no-cache fallback; original owner-HTTP rule provenance; then a new signed synthetic qualifying event after activation through existing job/canonical/Pi flow, deduplication, one private English result, empty tools and zero Slack output. Synthetic provider/model acceptance is separate from fresh real owner setup and live Slack acceptance.
