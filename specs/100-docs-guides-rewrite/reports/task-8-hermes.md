# Task 8 — Hermes page

## Status: DONE

## What the code says about the Claude-login requirement

**Key files:**

- `packages/gateway/src/onboarding/api-key.ts` — `hasApiKey()` checks (in order):
  `ANTHROPIC_API_KEY` env var, `CLAUDE_CODE_AUTH` env var (set when Claude Code is
  logged in), or `config.kernel.anthropicApiKey` in `~/system/config.json`. If none
  is present, the kernel has no credential.

- `packages/kernel/src/kernel.ts` — `spawnKernel()` calls
  `@anthropic-ai/claude-agent-sdk` `query()` for every response. No fallback path
  exists when credentials are absent; the SDK call will fail.

- `packages/gateway/src/onboarding/agent-credential-status.ts` — Hermes is always
  registered as `system_agent` with `status: "available"` and `degradedWorkflows: []`
  regardless of credential state. Claude is `core_agent` with
  `degradedWorkflows: ["core_agent"]` when `verifiedAt` is absent and
  `nextAction: "Connect Claude to enable the core agent path"`.

- `packages/gateway/src/onboarding/agent-credential-routes.ts` line 54-55 —
  `POST /credentials/hermes/verify` returns 400 with "Hermes is always available and
  does not need verification." This confirms Hermes has no separate credential flow.

**Net result:** Hermes is architecturally always-available as the system agent identity,
but because the kernel uses the Claude Agent SDK as its only inference engine, no Claude
credential means no responses. The distinction matters for accuracy: Hermes does not
"need a Claude login" in the same sense a coding agent does — it cannot have one. What
it needs is Claude credentials on the VPS (either via `claude` CLI login setting
`CLAUDE_CODE_AUTH`, or an Anthropic API key).

## Uncertainties about the connect flow

- The exact shell UI path for the API key step is visible in `ws-handler.ts` as an
  onboarding WebSocket stage (`api_key`), but the specific Settings panel name or
  menu path the user follows post-onboarding is not confirmed from this codebase
  reading. The page conservatively says "Settings in the shell under the Agent
  Credentials section" — this matches `activation-contracts.ts` terminology but the
  exact label text in the UI was not verified.

- `CLAUDE_CODE_AUTH` is described as "present when Claude Code is logged in on the
  VPS" — this is what `api-key.ts` checks, but the env var's exact lifecycle (set by
  the SDK at login time, persisted across restarts?) was not traced through the SDK
  internals. The page describes it accurately based on what the code shows.

## Claude-login Callout placement

The Callout (`type="warn"`, "Hermes needs a Claude login") appears immediately after the
opening paragraph — before any other section. It is the first substantive element after
the intro sentence.

## Summary bullets

- Hermes is the always-on Matrix system agent; it uses the Claude Agent SDK as its
  inference engine and cannot generate any response without Claude credentials on the VPS.
- Three credential paths exist: `ANTHROPIC_API_KEY` env var, Claude Code login
  (`CLAUDE_CODE_AUTH`), or API key stored in `~/system/config.json` via onboarding.
- The warning Callout is placed near the top of the page, immediately after the
  single intro sentence.
- One uncertainty: the exact post-onboarding shell UI path for connecting Claude
  credentials was not confirmed from code; the page links to Coding Agents for that
  flow and conservatively references "Agent Credentials" section in Settings.
