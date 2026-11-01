# Validation quickstart

No paid request is part of the default suite.

```bash
bun run test -- tests/gateway/provider-workflow-openrouter-key.test.ts
bun run test -- tests/gateway/ai-provider-service.test.ts
bun run test -- tests/gateway/managed-chat-catalog.test.ts
bun run test -- tests/gateway/claude-runtime-credential-route.test.ts
bun run test -- tests/gateway/codex-execution-admission.test.ts
```

Then run the package/typecheck and release-parity shell build selected by the
changed files. Live qualification requires an explicit test key and approval;
never place the key on a command line. Capture Web Desktop, Electron, and Web
Mobile independently on the same commit/build. Keep captures outside the repo,
attach them to the PR, post the same evidence in Slack `#tech`, and link the
permalink back to the PR.

