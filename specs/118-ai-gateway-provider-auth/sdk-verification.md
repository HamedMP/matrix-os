# Agent SDK and Gateway Verification

**Verified**: 2026-08-29

**Target**: `@anthropic-ai/claude-agent-sdk@0.3.251`

**Production version after Phase 1**: `0.3.240`, the newest release old enough
to satisfy the workspace's seven-day `minimumReleaseAge` policy as of
2026-08-30. Upstream `0.3.251` was published on 2026-08-28, so the exact target
remains quarantined until normal policy resolution accepts it. Do not bypass
the workspace policy or add a package exception to install it.

## Reproduce

Install the forward target SDK outside the repository so the compatibility job
does not alter the production dependency or lockfile:

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
| Runtime credential refresh (`0.3.240`) | Pass with bounded-run injection | A loopback Anthropic fixture returned `401` on the first Messages call. `settings.apiKeyHelper` ran again and the same V1 `query()` retried with the replacement token. The undocumented `getHostAuthToken` callback was not invoked for either a normal API-key environment or a host-managed custom environment. Matrix therefore acquires one short-lived runtime credential in the gateway, injects it only into a bounded Agent SDK/Claude CLI run, and reacquires for the next run when the cached credential is inside its safety window. This preserves one in-memory singleflight path instead of executing an external key-helper command with separate cache state. |
| OpenCode CLI `1.16.0` | Installed CLI and local source contract pass | The installed binary reports `1.16.0`; `opencode run --help` confirms `--format json`, `--pure`, `--model`, and `--session`. An isolated-config, invalid-provider spike emitted one NDJSON `error` record with `timestamp`, `sessionID`, and a structured error before exiting non-zero. The matching local `run.ts` source confirms completed `text`/`tool_use` records and session resume. The Matrix adapter terminates option parsing before user prompt text, disables project config and plugins, applies a final deny-by-default local read/glob/grep/list policy, maps an Anthropic relay URL into provider options, and rejects non-portable Claude OAuth profiles. Network tools, workspace-write, and interactive approval transport remain deferred. |
| Pi CLI `0.81.0` credential routing | Adapter contract pass | The existing JSON-stream adapter now resolves the exact enabled harness access source for every turn, copies only `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, and applies funded-run expiry as an upper timeout. Missing or ambiguous settings and unavailable credentials fail before spawn. |

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

## Phase 1 implementation status

- Production dependencies are pinned to `0.3.240`; the lockfile resolves the
  matching platform packages and MCP SDK peer range.
- `0.3.251` remains the verified upstream target, not the installed production
  version, until pnpm accepts it under the unchanged seven-day release-age
  policy.
- V1 `query()` plus `resume` remains the kernel path.
- Skills use `skills: "all"`; the deprecated `Skill` allowlist entry is gone.
- Claude Fable 5, Opus 5, Sonnet 5, and Haiku 4.5 are the current catalog.
  Fable's documented limits are a 1M-token context window and up to 128K output
  tokens, with $10/$50 per million input/output tokens. Existing 4.x model IDs
  remain valid legacy choices and are never rewritten; invitation-only Mythos
  is not exposed.
- Effort and adaptive thinking are emitted only for models whose current API
  contract supports them. Claude 5 exposes `xhigh`; Haiku and unknown/custom
  models receive neither field.
- Results normalize cumulative `modelUsage`, and no-fallback refusals reach the
  shell as a safe generic terminal error.
- Matrix-funded runtime credentials are fetched from the authenticated,
  handle-scoped platform endpoint with a five-second acquisition deadline,
  bounded retry/backoff, response-size cap, exact returned-identity checks,
  singleflight refresh, expiry jitter, and a near-expiry refusal. The opaque
  credential is held only in gateway memory and is cleared on shutdown.
- Funded kernel and Claude CLI runs are capped at ten minutes, which leaves a
  one-minute safety margin inside the default fifteen-minute credential. There
  is no fallback to a legacy static Anthropic key or indefinite HMAC relay key.
- Customer hosts receive only the relay URL, enable flag, and their existing
  scoped platform verification token in the protected host environment. Relay
  service tokens and Cloudflare credentials are never provisioned to the VPS.
