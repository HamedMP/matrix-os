# Read-only Slack thread context in a PR preview

## 1. Scope

An ordinary human reply in an explicitly enrolled public Slack thread can supply reference context to one selected private Matrix bot. A reply alone never admits a Chat Turn or Run. The pilot accepts new reply events. Historical backfill, edits, deletion reconciliation, group DMs, personal mention triggers, and outbound actions are outside this contract.

## 2. Interfaces

| Entry | Authority and effect |
| --- | --- |
| `POST /webhooks/slack/events` | Slack raw-body HMAC, timestamp, app and active workspace installation. Exact opted-in thread. Claim and settle the existing event receipt without a send/reaction destination. |
| `POST /api/internal/slack/context` | Existing path-bound owner bridge signature. Check the exact runtime, owner, active private Chat and selected bot binding before committing a reference. |
| `POST /internal/slack/thread-context/access` | Registered machine bearer, matching runtime and owner, and the same grant digest, bot and Chat. Check current installation, linked Slack identity, Matrix membership and Slack access. Return only an authorization result. |
| `BotRunSpec.slackThreadReference` | Optional bounded reference text for a later interactive private bot run. The reference grants no permissions and cannot select tools. |

## 3. Contracts

- `SLACK_PREVIEW_THREAD_CONTEXT_GRANT` is optional JSON for the isolated platform only. It pins `appId`, `teamId`, `organizationId`, `ownerId`, `ownerSlackId`, `channelId`, `threadTs`, `botId`, `chatId`, `runtimeId`, `installationGeneration`, and `linkCreatedAt`. A different link or installation generation invalidates the old grant. An invalid optional grant disables this path while the existing Slack route remains available. The owner context service uses the registered PR-preview runtime identity.
- Only `type: "message"`, `channel_type: "channel"`, and an exact `thread_ts` distinct from `ts` qualify. The Slack sender remains message provenance. Matrix authority comes from the enrolled owner's verified link and current Matrix and Slack membership. Slack API checks are bounded and use the installed bot token.
- Owner thread references live in `slack_private_thread_context` and are keyed by grant and Slack message timestamp, with a separate unique grant and event ID fence. Insert, deduplication and the 64-row owner retention cap run in one transaction. The canonical Chat transcript stays free of the raw Slack messages.
- Reference text has a 4 KiB UTF-8 prompt cap. The broker checks the grant when the worker requests its spec, then the worker presents the excerpt as quoted untrusted data in the current model request copy. The raw block stays out of replayable messages and compaction history. A prior answer can still reflect content the bot was authorized to read at the time.

## 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| Missing or invalid Slack or bridge signature | `401`. |
| Wrong conversation, unbound root, app or bot sender, subtype, or Slack Connect source | No context admission. |
| Expired grant, lost membership, unlink/relink, or different runtime | Deny access to stored references. |
| Successful retry or same Slack timestamp | Existing receipt or stored row makes delivery idempotent. |
| Conflicting payload for a claimed provider event ID | `409`. |
| Retryable delivery failure | Generic failure and retry through the existing receipt lease. |

## 5. Examples

- Good. A teammate sends a plain reply in the enrolled Slack thread. The selected private bot gets one reference in its next eligible prompt.
- Base. A Slack retry produces no additional reference, Run, Slack write, or reaction.
- Bad. The same owner opens another bot or moves to another machine. That bot or machine cannot read the enrolled context.

## 6. Required tests

- Sign an ordinary reply locally and exercise the platform webhook, signed owner bridge, persisted owner reference and exact prompt reader. Redeliver the event, send a different event ID for the same timestamp, and assert one reference, zero Runs, and zero Slack writes or reactions.
- Exercise wrong thread, owner/runtime/bot, missing membership and revoked link. Verify the existing DM and mention paths independently.
- Check the broker spec for a later eligible private turn. A mocked model can see references while the original user prompt and persisted replay history contain none of the raw Slack block.

## 7. Implementation rule

Wrong. Forward every approved Slack channel event to the personal DM submitter, which admits a Turn and may react or send a reply.

Correct. Check the exact thread grant, forward via the context-only signed bridge and commit the owner-scoped reference. An eligible private Run can read it through the current grant.
