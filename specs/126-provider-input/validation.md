# Validation and Human Review

## Verified locally

- Repository `bun run typecheck` passes, including gateway, platform and Electron Desktop.
- `bun run check:patterns`: zero violations; five pre-existing advisory categories.
- Electron Desktop production build passes.
- Canonical production shell build passes with the repository CI Clerk test key. This validates compilation/prerendering, not production authentication.
- Focused contracts, gateway input lifecycle, provider transports, Web/Electron UI and Native Mobile tests pass. Regressions cover concurrent approval/input state, ten choices plus Other, duplicate submissions, unknown-response retries, prototype-shaped question IDs, late responses after changing Chat, cancelled/expired requests and composer draft retention.
- Actual Electron Desktop HTTP fixture: wide and 600px layouts, native card rendering, answer POST, intermediate assistant output via SSE before run completion without reload, and unchanged composer draft. Fixture credentials are isolated and no external browser authentication is launched.
- Actual Pi 0.81.0 no-model RPC probe: native dialog -> stdin answer -> continuation. See `research/providers.md` for exact runtime/dependency evidence.
- Full repository unit test run was launched before PR preparation; its final result belongs in the PR checks/validation update.

## Limits

- Authenticated model-triggered end-to-end runs for all five providers remain to be reviewed. Transport fixtures are not evidence of a live model run. OpenCode was not installed locally.
- OpenClaw's inspected interface has no native question/reply mechanism; its capability remains disabled.
- Existing shell lint has six errors and nine warnings; comparison against base HEAD confirms no new diagnostics. Native Mobile retains pre-existing component typing issues.
- Public docs: https://github.com/FinnaAI/matrix-os-site/pull/101 (91 tests; both changed pages rendered at 375/768/1440px).

## Runnable Electron Desktop review

Run from this branch's manual worktree:

```sh
flox activate -- bun run build:desktop
OM239_HUMAN_REVIEW=1 flox activate -- pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/canonical-input.e2e.test.ts
```

The isolated app opens the question at a narrow width and leaves it for up to 15 minutes. Choose a destination (or Other), enter report details, then Submit answer. Verify that the card closes, intermediate output appears without reload, and “Keep this unsent draft” remains in the composer. The fixture stays open another minute after submission, then removes its isolated profile. This is a client review fixture, not a production provider run.

Without `OM239_HUMAN_REVIEW=1`, the same scenario runs automatically. Screenshots are written to `output/playwright/om-239/`.

Human Review and merge approval remain pending. Do not merge on automated evidence alone.
