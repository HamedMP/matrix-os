# Research: Matrix-Funded AI and Provider Accounts

**Date**: 2026-08-29
**Scope**: current Matrix implementation, latest `t3code` upstream, Cloudflare AI Gateway, OpenRouter, Baseten, Anthropic models, and the Claude Agent SDK

## Executive Decision

The owner approved Cloudflare AI Gateway Unified Billing as the funded upstream. Matrix owns the entitlement and request boundary: the first funded release routes a narrowly allowlisted Anthropic model set through a Matrix-controlled relay backed by Cloudflare. OpenRouter remains an owner-connected provider with OAuth PKCE and broad model access. Baseten remains a later open-model inference source, optionally reached through Cloudflare, rather than becoming Matrix's account or entitlement authority.

The initial release intentionally has no user-visible token or dollar allowance. It still requires a global kill switch, Cloudflare spend ceiling, Matrix-side rate/concurrency/body limits, verified runtime identity, metadata-only logging, and an explicit funded-model allowlist. Later releases add Postgres/Kysely usage records, atomic spend reservations, allowances, and add-ons.

## Decision Matrix

| Option | Best fit | Strengths | Gaps / risks | Decision |
|---|---|---|---|---|
| Matrix relay + Cloudflare AI Gateway | Included Matrix-funded Claude | Anthropic-compatible endpoint, Unified Billing, stored credentials, gateway spend controls, retries/routing, observability | Cloudflare limits are eventually consistent; service-token traffic does not supply an end-user identity; prompt logging is enabled unless explicitly disabled | **Use for initial funded AI**, behind a Matrix identity and policy boundary |
| OpenRouter | Owner-connected multi-model access | Claude Agent SDK compatibility, OAuth PKCE, provider routing/fallback, model breadth, per-key controls | It is still an external billing/routing authority; provider behavior and model availability vary | **Add as an owner-funded provider**, not Matrix entitlement authority |
| Baseten | Hosted open models and dedicated deployments | OpenAI-compatible inference, high-performance model deployments, useful for open-weight models | Not a general account gateway or consumer OAuth surface; does not solve Claude funding/login | **Defer to open-model phase** |
| Direct shared Anthropic key on every VPS | Fastest apparent path | Minimal code change | Exposes a fleet-wide billing secret, cannot revoke one runtime safely, weak identity/abuse boundary | **Reject** |
| Reuse current `packages/proxy` unchanged | Superficially close to requirement | Existing Anthropic path, HMAC runtime keys, usage parsing | Docker-era path; SQLite, synchronous request I/O, stale pricing, quota races, unbounded state, raw key pass-through | **Replace incrementally, do not deploy unchanged** |

Primary sources:

- Cloudflare: [REST gateway](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), [Anthropic provider](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/), [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/), and [logging controls](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- OpenRouter: [Claude Code](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration), [Anthropic Agent SDK](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk), [OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- Baseten: [Model API inference overview](https://docs.baseten.co/reference/inference-api/overview)

## Current Matrix Audit

### Kernel and Agent SDK

- Production pins `@anthropic-ai/claude-agent-sdk` `0.3.240`. The npm registry
  reports `0.3.251` as current, but its 2026-08-28 publication date keeps it
  quarantined by the workspace's seven-day `minimumReleaseAge` policy as of
  2026-08-30. The exact-version compatibility job remains the upgrade gate;
  production must not bypass the release-age policy.
- Matrix uses the supported V1 `query()` plus `resume` path. This is the correct base: the Agent SDK changelog says the experimental V2 interface was removed in `0.3.142`.
- The SDK upgrade is not a mechanical version bump. The exact `0.3.251`
  compatibility harness verifies first-turn MCP, explicit skills, canonical usage,
  structured refusals, hooks, permissions, resume, cancellation, and subagents
  before production may update the lockfile.
- `packages/kernel/src/options.ts` uses the supported `skills: "all"` option;
  the deprecated `Skill` allowlist entry has been removed. Task/subagent
  capability remains covered by the exact-version compatibility harness.

Source: [Claude Agent SDK TypeScript changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

### Models

- The current Anthropic family is Claude Fable 5, Opus 5, Sonnet 5, and Haiku 4.5. Anthropic documents material Sonnet 5 request-behavior differences, so controls cannot be copied blindly from older models.
- Claude Fable 5 is generally available as `claude-fable-5`, with a 1M-token
  context window, up to 128K output tokens, and $10/$50 per million input/output
  tokens. Invitation-only Mythos is deliberately absent from the Matrix catalog.
- Recommended Matrix-funded default: **Claude Sonnet 5**, with Haiku 4.5 available for low-cost/background classifications once quality tests pass. Opus 5 is owner-funded/add-on at launch. Fable 5 is not included by default because its documented retention posture requires a deliberate policy and user disclosure.
- Model data should move from duplicated arrays to a bounded, validated catalog with a shipped fallback. Existing Chats keep their bound model ID; a retired model becomes non-runnable until the user explicitly selects a compatible model.

Sources: [Anthropic model overview](https://platform.claude.com/docs/en/models/overview), [choosing a model](https://platform.claude.com/docs/en/docs/about-claude/models/choosing-a-model), [Sonnet 5 changes](https://platform.claude.com/docs/en/docs/about-claude/models/whats-new-sonnet-5), and [Fable 5 retention notes](https://platform.claude.com/docs/en/models/fable-5/introducing-claude-fable-5-and-claude-mythos-5).

### Credential resolution and Settings

- `packages/gateway/src/kernel-credentials.ts` already resolves owner API key, then owner Claude login, then platform fallback. That precedence is useful but implicit.
- Platform fallback currently means inheriting process environment. `packages/platform/src/orchestrator.ts` injects an Anthropic-compatible proxy URL and per-runtime HMAC token in legacy/container provisioning paths. The production VPS-native path needs an explicit equivalent.
- `packages/gateway/src/agent-config/service.ts` collapses the winning credential into one Anthropic descriptor. It can show Anthropic as authenticated merely because a platform fallback exists, while the owner Anthropic account is not connected.
- `hasClaudeLogin()` validates local JSON shape, not actual provider readiness. The UI can therefore overstate login health.
- The canonical fix is a provider-status service returning separate access sources, account connections, harness installation/health, and model eligibility. Chat, Settings, onboarding, desktop, mobile, and channel adapters project the same snapshot.

### Chat and harnesses

- `packages/contracts/src/canonical-chat-provider.ts` and `packages/gateway/src/chat/provider-catalog.ts` already define a provider-neutral driver/instance direction. The new work should extend this rather than create another Chat stack.
- Root Matrix Chat uses the Agent SDK; the Claude coding-provider adapter launches the Claude CLI. Provider account state must describe which harness consumes a credential rather than assuming every Anthropic path is identical.
- Existing Matrix harnesses include Claude Code, Codex, OpenCode, Pi, Hermes, and OpenClaw. OpenCode should be reused.

### Legacy proxy

The current proxy is useful as a migration map, not as a production implementation:

- `better-sqlite3` violates the Postgres/Kysely persistence rule and blocks the event loop.
- quota check and usage write are not atomic, so parallel calls can overspend;
- the instance registry is an unbounded `Map`;
- request schemas, body limits, and error normalization are insufficient;
- it can pass through a raw Anthropic key supplied by a runtime;
- pricing is hard-coded and stale;
- streaming accounting buffers are not suitably bounded.

The replacement can keep Anthropic wire compatibility and per-runtime authentication while deleting raw-key pass-through and making the first version stateless except for bounded in-memory abuse controls. Later metering belongs in platform Postgres through Kysely.

## Cloudflare AI Gateway Findings

### Why it is the best first upstream

- Anthropic and Claude Code can use an Anthropic-compatible base URL, minimizing Agent SDK adaptation.
- Unified Billing keeps the upstream Anthropic credential out of Matrix customer runtimes.
- Gateway controls provide an independent global spend fuse and operational observability before Matrix has user-visible metering.
- Cloudflare supports provider routing and can later front Baseten or other allowlisted providers.

### Required safeguards

- Matrix must inject a verified user/runtime identity at its own relay. Cloudflare service-token requests do not automatically create a trustworthy end-user identity.
- AI Gateway `Run` tokens are account-scoped rather than gateway-scoped. Use a dedicated Cloudflare account for funded production traffic (or a Worker binding) so compromise of the relay token cannot consume credentials configured on unrelated gateways.
- Set `cf-aig-collect-log-payload: false` on every funded request. Prompts, responses, tools, and files must not enter gateway logs.
- Treat Cloudflare spend limits as a coarse fuse, not an atomic allowance. Documentation notes propagation delay; a burst can overshoot. Later per-user allowances therefore require Matrix-side reservation before dispatch.
- A Cloudflare metadata rule split by user/runtime is useful for one uniform preview budget, but it cannot represent arbitrary purchased balances: gateways support at most 20 spend rules and every value split by one rule receives the same configured amount. Variable add-on credit therefore lives in the Matrix ledger.
- Unified Billing credits carry a 5% purchase fee and can rarely go negative before Cloudflare charges the payment method on file. Matrix pricing and reserve policy must include that fee and overshoot exposure rather than treating prepaid credits as a strict liability ceiling.
- Unified Billing currently documents a 200-request-per-60-second gateway limit. Matrix defaults its own global admission budget to 180 requests/minute and treats vendor `429` responses as a coarse capacity signal.
- Cloudflare recommends its newer REST API for new integrations, but the initial Agent SDK slice deliberately uses the supported provider-native Anthropic endpoint to preserve Messages API and streaming semantics. A later spike can evaluate the REST endpoint without changing the owner-runtime relay contract.
- Use a dedicated gateway/account/budget for the funded product, separate from development and owner BYOK traffic.
- Do not enable semantic caching for stateful Agent SDK turns. Retries must be bounded and limited to safe pre-response failures.

## OpenRouter Findings

- OpenRouter provides an Anthropic-compatible Agent SDK path and a documented OAuth PKCE flow that issues a user-controlled API key.
- This makes it the strongest smooth owner-connect option: Matrix starts an owner-scoped connection attempt, stores only verifier/state server-side, exchanges the code at the owner gateway, saves the resulting credential in the owner secret store, probes it, and marks the account connected.
- OpenRouter's provider routing, fallback, and ZDR options should be exposed as bounded Matrix policy rather than arbitrary request fields from the browser.
- The model catalog should record the actual canonical model/provider reported for a run when available, because routing may select an upstream provider different from the marketing-level model source.

## Baseten Findings

- Baseten exposes OpenAI-compatible inference for hosted and dedicated deployments. It is attractive for later open-weight models, controlled workloads, or a Matrix-specific classifier/summarizer.
- It does not replace the account connection, entitlement, or general gateway layers required here.
- Add it only after the provider contract supports an OpenAI-compatible transport independent of an execution harness. Cloudflare can front it if unified logging/routing is useful.

## Anthropic Login Decision

Anthropic login must use a supported provider-native flow; Matrix must not scrape tokens or invent OAuth endpoints.

1. Spike the current official CLI/profile flow (`ant auth login` / `ant auth status`) and the Agent SDK's support for Claude subscription/profile authentication.
2. If the flow exposes a stable non-secret authorization URL and machine-readable completion status, wrap it in an owner-scoped login session and return the user to the preserved Chat draft automatically.
3. If it remains terminal-interactive, launch a visible canonical `__terminal__` setup session from Chat/Settings and poll a bounded health check. This is the safe first adapter, not a fake in-app OAuth flow.
4. Keep API-key entry as an alternative. A file's presence is only `unverified`; a bounded real probe establishes `ready`.

Sources: [Anthropic CLI authentication](https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication), [profile/WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference), and [Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## `t3code` Comparison

The private comparison worktree was fetched to upstream commit `053affbed` without touching its existing local edits.

### Useful patterns to adopt

- explicit driver versus provider-instance separation;
- capability probes rather than UI assumptions;
- multiple instances per driver;
- a bounded model manifest with validated remote refresh, last-known-good cache, and bundled fallback;
- legacy-model classification rather than silently rewriting persisted model selections.

### Current upstream models and harnesses

- Claude manifest: Fable 5, Opus 5, Sonnet 5.
- Codex manifest: GPT-5.6 Luna, Terra, Sol, plus the current Daybreak variants.
- Built-in harnesses: Codex, Claude, Cursor, Grok, and OpenCode.

Matrix already has Codex, Claude Code, and OpenCode equivalents plus Pi, Hermes, and OpenClaw. Model IDs can be added through Matrix's catalog after transport/capability validation. Cursor and Grok are not small ports: the comparison implementation depends on its ACP runtime and Effect-based registry lifecycle. Matrix should first implement one generic, bounded ACP driver, then add either harness as a thin adapter in a separate feature.

## Rejected Alternatives

### Put the shared Anthropic key back in platform-injected VPS environment

Rejected because any customer-runtime compromise would expose a fleet-wide billing credential. Per-runtime proxy tokens are safe to expose to that runtime only when the central relay verifies, scopes, rate-limits, and can revoke them.

### Make Cloudflare or OpenRouter the source of truth for Matrix eligibility

Rejected because product entitlement, account ownership, refunds, and add-ons belong to Matrix. Vendor counters are reconciliation inputs and safety fuses.

### Add per-user metering before first funded Chat

Rejected for the first slice because it delays activation and pricing learning. Global controls provide a safe limited release; the relay contract is designed so atomic per-user reservations can be inserted later without changing customer VPS or Chat persistence.

### Copy all `t3code` providers now

Rejected because it would fragment provider state and import a runtime architecture that does not match Matrix's headless kernel, per-user VPS, and existing canonical Chat. Reuse the patterns and add protocol adapters deliberately.

## Resolved Unknowns

No product-blocking clarification remains for planning. Exact free duration, per-user included amount, add-on prices, and organization sharing are intentionally deferred. The implementation starts disabled and can ship behind operator eligibility controls while those commercial decisions are made.
