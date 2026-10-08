# ENG-104: Discord connection capabilities

The ordinary `discord` Pipedream OAuth account lists the user's servers with
`guilds`. A user token, including a token with a `bot` install scope, does not
become a bot credential. `discord_bot` uses the provider's separate API-key
connector and the existing bot token. The connector registry is the canonical
capability source for Settings, agent discovery, provider sync/webhooks and
execution. Do not silently change service, account label, grant or owner.

Ordinary OAuth advertises only `list_servers`. Legacy channel/message/send
requests fail before provider dispatch with `discord_bot_required` and an
existing-bot setup path. Bot reads use the original reviewed Discord REST
mappings; credentials remain with Pipedream. Upstream 401, 403, 429 and 5xx remain
separate; responses and agent recovery copy never include upstream diagnostics.
A 200 channel-discovery response must be an array of valid channel IDs.

Each owner-agent MCP/SDK instance owns a bounded discovery fence. Pending or
failed discovery blocks message reads on the same selected account; success for
a different server/account cannot clear the failure. Trim labels as the gateway
does and conservatively fence unlabeled aliases. Successful retry of the failed
server evicts its entry. Capacity exhaustion fails closed until a new run. No
state is global or persisted. Standalone REST reads and spec-536 Bot grants keep
their existing independent authorization contracts; this is an owner-agent
workflow fence, not a new channel authorization grant.

## Validation and release boundary

Regression tests cover regular scopes/unknown legacy scopes, exact provider
slug and bot account selection, expired/revoked/ambiguous accounts, other-owner
and immutable-grant refusal, safe error translation, malformed discovery,
empty results, real MCP failure/read/retry continuation, pending calls, capacity,
label aliases and run isolation. Provider responses, channel IDs, messages and
MCP transports in these tests are synthetic. They establish message evidence
being supplied to the agent; they do not certify an LLM-written summary or a
live Discord round trip.

Real acceptance needs owner-approved existing bot credentials, guild membership,
View Channel and Read Message History, and Message Content Intent for message
text. Send Messages is additionally required for `send_message`. Verify Settings
shows separate Discord/Discord Bot entries, connect through the existing
provider-hosted credential flow, then perform the original server → channel →
summary request on an explicitly approved channel. Record the exact runtime and
release. Do not reconnect Liz, create a new account, read real messages or deploy
under the local implementation authorization.

## Invariants

- Source of truth: reviewed connector registry and the owner's active connection
  rows; no migration, implicit OAuth-to-bot transfer or fallback.
- Lock/transaction scope: no new persistent writes; provider calls remain outside
  locks. Workflow state lives only within the owner-agent instance.
- Acceptable failure state: failed channel discovery cannot authorize continuation;
  a missing/expired/revoked bot returns actionable denial without using OAuth.
- Auth source: existing authenticated gateway owner, explicit service/label and
  existing grant checks, plus Pipedream's bound account credential.
- Deferred: live owner acceptance, publication, deployments and a Discord Chat bot.

### Existing authorization boundaries

| Entry point | Authentication and selection | Public |
| --- | --- | --- |
| `/api/integrations/call` | Existing gateway request principal; owner-bound active connection, explicit service and optional label/connection ID | No |
| `/api/integrations/read-call` | Existing authenticated owner or bounded delegated read grant; immutable account selection | No |
| Owner MCP/SDK `call_service` | Existing gateway credential plus the same route checks; per-instance discovery fence | No |
| `/api/integrations/connect` | Existing authenticated owner and provider-hosted connection flow; separate `discord_bot` slug | No |

No endpoint or authorization mechanism is added. Provider calls keep existing
action timeouts and request body limits. The in-memory fence has a 128-entry cap,
evicts successful retries and is discarded with its owner-agent instance.

## Public documentation follow-up

The repository constitution requires a companion public-docs PR in
`FinnaAI/matrix-os-site/content/docs/`. Prepare a Discord OAuth versus Discord Bot
capability/setup explanation for that existing integrations guide after this
implementation is approved for publication. This local task authorizes neither
site edits nor creating that PR, so this follow-up remains a release deliverable.

## Primary references checked during implementation

- https://docs.discord.com/developers/topics/oauth2 (guilds and bot scopes)
- https://docs.discord.com/developers/resources/guild#get-guild-channels
- https://pipedream.com/apps/discord-bot (API-key slug and automatic proxy auth)
- https://linear.app/matrix-os/issue/ENG-104/fix-discord-channel-discovery-for-regular-oauth-connections
