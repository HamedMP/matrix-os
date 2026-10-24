# Validation quickstart

No paid request is part of the default suite.

```bash
flox activate -- bunx vitest run \
  tests/gateway/openrouter-capability.test.ts \
  tests/gateway/provider-workflow-openrouter-key.test.ts \
  tests/gateway/ai-provider-service.test.ts \
  tests/gateway/managed-chat-catalog.test.ts \
  tests/gateway/claude-runtime-credential-route.test.ts \
  tests/gateway/codex-openrouter-routing.test.ts
flox activate -- bun run typecheck:run
```

## Local product checks

The feature is enabled when the override is unset, so a normal `bun run dev`
must show **Connect OpenRouter** in **Settings → Agents & providers**. Verify
that one successful connection exposes the same account on Matrix AI, Kernel,
Claude Code, and Codex; each route must display its exact model and **Billed by
OpenRouter**. Change routes with an unsent Chat draft and confirm the draft is
preserved.

Exercise the emergency withdrawal path separately:

```bash
flox activate -- env MATRIX_OPENROUTER_MULTI_HARNESS_ENABLED=0 bun run dev
```

The connection action and new OpenRouter starts/resumes must be unavailable,
while existing account metadata, settings, and conversation history stay
readable. Repeat with `=1` to verify the explicit enable override. Do not put a
real API key in an environment variable or command line; connect it only through
the authenticated Settings workflow.

## Paid live qualification

Live qualification requires explicit approval, a disposable test key, and an
exact disposable-VPS host bundle. For each of the four routes, verify streamed
text, one bounded tool call, cancellation, restart/resume, selected-model
attribution in OpenRouter activity, key rotation, disconnect, model removal,
and a concurrent generation change. Confirm failures never fall back to Matrix
credits, Anthropic, OpenAI, ChatGPT, or a native tool credential, and record no
prompt or private content.

Capture Web Desktop, Electron, and Web Mobile independently on the same
commit/build. Keep captures outside the repo, attach them to the PR, post the
same evidence in Slack `#tech`, and link the permalink back to the PR.

