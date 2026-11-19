# Read-only Slack channel and thread context in a PR preview

## 1. Scope

Ordinary human messages in an explicitly enrolled public Slack channel or thread can supply reference context to one selected private Matrix bot. A message alone never admits a Chat Turn or Run. A channel grant accepts new top-level posts and thread replies. A legacy thread grant accepts replies in its exact thread. Historical backfill, edits, deletion reconciliation, group DMs, personal mention triggers, and outbound actions are outside this contract.

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
