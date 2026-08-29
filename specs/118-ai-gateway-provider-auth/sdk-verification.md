# Agent SDK and Gateway Verification

**Verified**: 2026-08-29

**Target**: `@anthropic-ai/claude-agent-sdk@0.3.251`

**Production version during this spike**: `0.2.79` (unchanged; the upgrade belongs to Phase 1)

## Reproduce

Install the target SDK outside the repository so this spike does not alter the
production dependency or lockfile:

```bash
mkdir -p /private/tmp/matrix-agent-sdk-03251
pnpm add --dir /private/tmp/matrix-agent-sdk-03251 @anthropic-ai/claude-agent-sdk@0.3.251
MATRIX_AGENT_SDK_PACKAGE_DIR=/private/tmp/matrix-agent-sdk-03251/node_modules/@anthropic-ai/claude-agent-sdk \
  bun run spike:agent-sdk
```

If `claude` is not on `PATH`, set `MATRIX_CLAUDE_BIN` to its absolute path. The
runner binds only to loopback, uses a fake bearer token, makes no paid model
request, removes its temporary skill/session directory, and never prints a
credential or raw auth-status output.

The normal contract tests run without an SDK download:

```bash
pnpm exec vitest run tests/scripts/agent-sdk-gateway-verification.test.ts
```

The real-runtime test is opt-in for ordinary local unit runs:

```bash
MATRIX_AGENT_SDK_PACKAGE_DIR=/absolute/path/to/node_modules/@anthropic-ai/claude-agent-sdk \
  pnpm exec vitest run tests/scripts/agent-sdk-real-runtime-spike.test.ts
```

CI has a required `Agent SDK 0.3.251 Compatibility` job that installs the exact
package into the runner's temporary directory and runs this test. The ordinary
unit shards keep it skipped so they do not repeat the external install four
times.

## Results

| Check | Result | Evidence / decision |
|---|---|---|
| Exact package and runtime surface | Pass | Exact `0.3.251`; runtime exports `query`, `createSdkMcpServer`, `tool`, and `HOOK_EVENTS`. Types retain V1 `resume`, `mcpServers`, `agents`, `hooks`, `abortController`, structured output, and `modelUsage`. |
| Relay base URL and token | Pass | The bundled Claude runtime called the loopback Anthropic endpoint at `/v1/messages?beta=true` and sent the configured bearer token. The report only records `present`. `ANTHROPIC_API_KEY` must be explicitly empty when `ANTHROPIC_AUTH_TOKEN` is used. |
| First-turn in-process MCP | Pass | A forced first response called `mcp__spike__echo`; the in-process tool ran once and the next model request contained its tool result. |
| V1 `query()` + `resume` | Pass | The second `query()` reused the first result's session ID and returned `resume-ok`. Keep V1 for the Phase 1 upgrade. |
| `PreToolUse` | Pass | The matcher ran exactly once for the MCP tool and allowed it. Defense-in-depth hooks remain available. |
| Skills | Pass | A temporary project skill was visible in the init event with `skills: ["spike-skill"]`. `Skill` in `allowedTools` is deprecated in `0.3.251`; Matrix must migrate to the `skills` option. |
| Agent subagents | Pass | A forced `Agent` tool call spawned the configured subagent and returned a structured result. The result reported one spawned subagent. |
| Cancellation | Pass | Aborting `Options.abortController` terminated a request whose upstream never responded within the five-second spike deadline. |
| Refusal and usage | Pass | A provider `stop_reason: "refusal"` produced `model_refusal_no_fallback`; the SDK then throws after emitting the structured event. Consumers must retain events before normalizing that error. Successful results expose per-model canonical provider/model and cost/token usage through `modelUsage`. |
| Anthropic login status | Contract pass; live login blocked | The installed CLI supports `claude auth login` (`--claudeai`, `--console`, `--email`, `--sso`) and machine-readable `claude auth status --json`. This machine reported `loggedIn: false`, so an authenticated owner-profile turn was not run. Chat/Settings can launch the visible CLI login and poll the structured status; they must not infer readiness from credential files. |
| OpenRouter Agent SDK transport | Official contract pass; live call blocked | OpenRouter documents `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<owner key>`, and an explicitly empty `ANTHROPIC_API_KEY`. No owner key was available for a live model request. |
| OpenRouter OAuth PKCE | Contract pass; live exchange blocked | Builders require S256, an owner-bound one-time `state` in the callback, the fixed HTTPS exchange endpoint, redirect rejection, and a ten-second timeout. No authorization code was minted or exchanged. |
| Cloudflare Anthropic streaming | Protocol pass; live Unified Billing blocked | The fake provider proves the Agent SDK's Anthropic streaming and required beta-header behavior through the Matrix-compatible boundary. No Cloudflare gateway credential was available for an external inference call. |
| Cloudflare privacy / metadata | Contract pass | Funded requests must send `cf-aig-collect-log-payload: false` and `cf-aig-zdr: true`; metadata is allowlisted, content-free, and capped at Cloudflare's five-entry limit. |
| Cloudflare spend controls | Documentation verified; live enforcement blocked | Gateway rules can scope budgets by model/provider/custom metadata, including split-by-user. They are eventually consistent and are not Matrix's hard customer balance. Matrix remains authoritative for eligibility, add-on credit, and hard admission. |

## Frozen provider contracts

- OpenRouter Agent SDK: <https://openrouter.ai/docs/guides/community/anthropic-agent-sdk>
- OpenRouter OAuth PKCE: <https://openrouter.ai/docs/guides/overview/auth/oauth>
- Cloudflare Unified Billing and per-request ZDR: <https://developers.cloudflare.com/ai-gateway/features/unified-billing/>
- Cloudflare payload-log suppression: <https://developers.cloudflare.com/ai-gateway/observability/logging/>
- Cloudflare limits: <https://developers.cloudflare.com/ai-gateway/reference/limits/>

## Phase 1 migration gates

1. Remove `Skill` from `allowedTools` and configure the explicit `skills` option.
2. Keep V1 `query()` with `resume`; do not adopt a newer session API until the
   same MCP/resume harness passes against it.
3. Normalize `modelUsage` rather than summing main-loop `usage`; `modelUsage`
   includes subagents and other query-pipeline calls.
4. Preserve structured refusal events even when the SDK subsequently throws.
5. Run one bounded authenticated owner-profile turn and one Cloudflare Unified
   Billing turn in a secret-bearing environment before rollout. The deterministic
   fake-provider suite remains the required regression gate.
