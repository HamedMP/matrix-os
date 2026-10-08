# Quickstart: Conversational Recipe Bots

How to build, test, and see this feature work at each stack layer. See [plan.md](plan.md) for the layers and [spike-plan.md](spike-plan.md) for the live evidence protocol.

## Prerequisites

- A manual worktree for the layer: `git worktree add ../matrix-os-536-<layer> <parent-layer-branch>`, then `gh stack add` from inside it. Flox or Node 24+, pnpm 10.33.4, and bun.
- `pnpm install --frozen-lockfile` at the worktree root.
- Pi packages come from the lockfile at exactly `0.86.1`, with overrides for chord and pi-telemetry. Never add a caret range.
- For Postgres-backed tests, `MATRIX_TEST_POSTGRES_URL` enables the `*-postgres.test.ts` suites. Everything else uses in-process `kysely-pglite`.

## Test commands per layer

```bash
# contracts
pnpm exec vitest run tests/contracts/bots tests/contracts/funded-ai.test.ts
# platform funded priority
pnpm exec vitest run tests/platform/ai-funded-priority-claims.test.ts tests/platform/ai-funded-metering.test.ts tests/platform/platform-migration-revision.test.ts
# gateway funded queue and credential classes
pnpm exec vitest run tests/gateway/funded-ai-credential-manager.test.ts tests/gateway/funded-admission-queue.test.ts tests/gateway/kernel-credentials.test.ts
# bot runtime (Pi loop, fake provider)
pnpm exec vitest run tests/bot-runtime
# scope runtime bot profile
pnpm exec vitest run tests/scope-runtime
# gateway bots
pnpm exec vitest run tests/gateway/bots
# UI and renderers
pnpm exec vitest run tests/ui/bots tests/shell/bot-* tests/desktop/bot-*
```

Before any PR: `bun run typecheck`, `bun run check:patterns`, and focused suites. Run `npx react-doctor@latest <project-dir>` for changed React projects, and `bun run build:shell:production` when `shell/` changes. On this shared machine, prefer focused suites plus CI over full local runs.

## Local development flow (fixtures)

`bun run dev` runs the gateway, proxy, and shell. The scope runtime needs systemd and is not available in local dev, so local runs use `BOT_RUNTIME_LAUNCHER=in-process-test`. This launcher is refused unless `NODE_ENV=test` or `MATRIX_DEV_UNSAFE_BOT_LAUNCHER=1`, and it logs a warning at startup. It runs the same bot-runtime worker in a child process with the fake model provider. Use it to see:

1. Recipes panel: choose **Competitor Watch**. A bot named after the recipe appears with its rabbit and opens its direct chat.
2. The bot asks one question. Answer it, reload, and see the same bot, chat, and remembered answer.
3. Open the bot's authority view: remembered items with their source, and no grants.
4. Ask for something that needs Gmail. A connect-request card appears. With the fixture integration broker, **Connect** completes, and a grant request follows.

## Live validation (disposable VPS)

Live evidence uses a disposable test VPS and the normal host-bundle path, never the owner's primary computer:

```bash
set -a; source .env; set +a
HOST_BUNDLE_VERSION=<ver> HOST_BUNDLE_CHANNEL=dev MATRIX_BUILD_SHA=$(git rev-parse HEAD) MATRIX_BUILD_REF=<branch> ./scripts/build-host-bundle.sh
./scripts/publish-release.sh <ver> --channel dev
# then POST /vps/deploy {"handle":"<test-handle>","version":"<ver>"}
```

The platform funded-priority layer needs a platform preview revision (see `docs/dev/preview-environments.md`) before Spike B's funded cases run. Record the model spend cap and the VPS lifetime and cost cap before live calls. Ask the owner whether to delete the test VPS afterwards.

## Checks that prove it works

- `GET /api/chat-agents/:id/authority` matches the database after each grant, revocation, and forget.
- Killing the gateway during a tool call leaves `bot_tool_checkpoints` in `effect_unknown`, not replayed.
- Two instantiate calls with one `clientRequestId` return the same bot and chat.
- On a funded route, an owner turn reserves ahead of queued bot requests (`ai_funded_priority_claims` trace on the preview platform).
