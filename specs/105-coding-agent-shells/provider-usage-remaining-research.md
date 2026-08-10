# Provider Usage Remaining Research

## Scope

This note evaluates how Matrix OS Desktop can present a provider-neutral
"usage remaining" surface without implying precision that a provider does not
expose. It is research input for MAT-265, not an implementation specification.

## Current Matrix OS seam

Matrix already has the correct architectural boundary for this feature:

- `CodingAgentProviderAdapter` is the trusted Gateway seam for Codex, Claude,
  Pi, and future coding-agent providers.
- `FR-110` requires normalized, safe provider usage summaries.
- The full-workspace backend reserves `GET /api/coding-agents/usage` and
  `coding_agent_provider_quota_snapshots`.
- `GW-112` requires quota summaries to be normalized without returning secret
  values.

The existing `/api/usage` route measures Matrix kernel cost. It does not
represent the user's provider subscription or account quota and must not be
reused as "remaining".

Matrix must also distinguish the coding-agent runner from the account that owns
the quota. Codex normally maps to an OpenAI or ChatGPT account and Claude Code
maps to an Anthropic account, while Pi, OpenCode, and custom ACP runners may use
several underlying model or billing providers. The normalized response should
therefore expose usage sources and link them to agent providers instead of
storing one quota percentage directly on `AgentProviderSummary`.

## CodexBar model

[CodexBar's provider documentation](https://github.com/steipete/CodexBar/blob/main/docs/providers.md)
shows that a common UI is possible only because each provider has a distinct
retrieval strategy: CLI RPC or PTY commands, OAuth APIs, API tokens, local
probes, browser sessions, and provider dashboards. Its normalized
[CLI JSON output](https://github.com/steipete/CodexBar/blob/main/docs/cli.md)
uses provider and source metadata, timestamped primary and secondary usage
windows, reset times, and optional credits. Matrix should borrow that contract
shape, not CodexBar's macOS-local credential and browser-cookie architecture.

## Provider capability matrix

| Provider/account mode | Authoritative remaining data | Practical trusted source | V1 state |
| --- | --- | --- | --- |
| OpenAI Codex with ChatGPT account | Yes: rate-limit windows and optional credits | Codex app-server `account/rateLimits/read`; the official [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) documents the method and notifications | Exact remaining and reset times |
| OpenAI API key | Not a universal subscription percentage | Provider billing/limits only when an authorized account API exposes them; local turn usage is consumption, not remaining | Credits/budget when authoritative, otherwise unavailable |
| Claude subscription | Yes in Claude surfaces, including plan usage windows | Claude Code exposes `/usage` and status-line rate-limit fields; see the official [commands](https://code.claude.com/docs/en/commands), [costs](https://code.claude.com/docs/en/costs), and [errors/status-line](https://code.claude.com/docs/en/errors) documentation | Exact when a stable machine-readable CLI surface is verified; otherwise setup/unavailable |
| Anthropic API key | Usage/cost is available, but there is no universal plan-style remaining percentage | Account/API billing data if separately authorized; local session cost is only consumed usage | Cost/credits when authoritative, otherwise unavailable |
| Gemini CLI | Quotas depend on authentication method and tier | Gemini CLI account/quota surfaces; official [quota and pricing documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md) describes the differing limits | Exact only after a version-pinned machine-readable probe is verified |
| Pi/custom provider | Provider-specific | Optional adapter capability | Unsupported until an adapter advertises a safe quota source |

OpenAI also documents that Codex usage is pooled across Codex surfaces and that
plan limits vary by task and model. A local per-turn token counter therefore
cannot truthfully calculate account quota remaining. See the official
[Codex plan usage guide](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits).

## Data-trust rules

1. `remaining` must be provider-reported or derived only from a provider-reported
   limit and used value from the same window.
2. Local token and cost telemetry may be displayed as consumption, but must not
   be converted into a remaining percentage.
3. Every snapshot must carry `source`, `accuracy`, `observedAt`, and freshness.
4. The renderer receives only bounded display-safe values. Credentials, cookies,
   raw CLI output, provider errors, and account identifiers stay in the Gateway.
5. Every provider probe is optional, cancellable, timeout-bounded, cached, and
   failure-isolated. One provider failure cannot fail the whole usage response.
6. Browser-cookie scraping is not an acceptable Matrix renderer integration.

## Recommended V1

Implement a Gateway-owned normalized quota service behind
`GET /api/coding-agents/usage`, with optional `getUsage` capability on provider
adapters. Start with Codex because its official app-server contract exposes
machine-readable rate limits. Claude is the next built-in candidate and may be
added only after a version-pinned spike proves a stable machine-readable source.
Gemini research informs the provider-neutral contract, but Gemini CLI remains
excluded from the first-release built-in provider matrix.

Desktop should always render the same provider list and use truthful states:

- `Available`: exact remaining window and reset time.
- `Stale`: last known value with age and refresh action.
- `Setup required`: a safe provider setup action exists.
- `Unavailable`: the provider supports usage but the probe failed.
- `Unsupported`: the adapter has no authoritative remaining source.

The compact surface should show the active provider's most constrained current
window. A popover can show all providers, all returned windows, credits, reset
times, freshness, and source accuracy.

## Explicit non-goals

- Claiming exact remaining quota for every provider.
- Estimating subscription remaining from local tokens or dollar cost.
- Reading browser cookies or placing provider credentials in the renderer.
- Treating Matrix kernel `/api/usage` as provider quota.
- Persisting high-frequency raw provider usage events in Desktop state.
