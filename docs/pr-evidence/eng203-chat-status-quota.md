# ENG-203: remaining allowance and working-status UI

## Behavior

Subscription labels now show rounded remaining capacity (`71% used` becomes `29% left`), matching the existing remaining meter. Reset dates and stale/unavailable states retain their current behavior. This shared Settings change applies to Web Desktop, Web Canvas and Electron Desktop.

Electron Desktop leaves 12 CSS pixels below the Working/Worked divider and uses a compact themed phase row. Long model names truncate inside the available column while preserving the complete title and accessible name, spinner, detail controls and tool actions. Web Chat currently uses its own busy indicator without this receipt/model row; this cosmetic fix does not introduce a new Web Chat presentation.

## Validation

- TDD: 14 expected failures before implementation; 121 focused regressions pass after implementation.
- UI and Electron Desktop type checks pass; production Electron build passes.
- Changed files pass scoped lint except `transcript.tsx`, which has the same five errors and two warnings at the base commit and after this change. These pre-existing hook/compiler diagnostics occur in unchanged code.
- Built Electron tests use a loopback synthetic gateway and disposable profile. They assert normal/narrow divider geometry, complete long-model identity, no row/container overflow, spinner, completed receipt collapse/expand, 0/71/100-percent usage and fractional rounding, reset date and matching meter accessibility text.
- Runtime screenshots, geometry and client Git provenance are written to `output/eng203/`. This proves frontend behavior in actual Electron; it does not assert live provider authentication or usage collection.

No new public capability or workflow is introduced, so a public-site documentation PR is not needed for this copy/layout correction. The existing Settings spec is updated.

## Reproduce

From the PR worktree:

```sh
flox activate -- bun run build:desktop
MATRIX_DESKTOP_E2E_REQUIRED=1 flox activate -- pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/chat-status-quota.e2e.test.ts --maxWorkers=1 --no-file-parallelism
```

For the interactive Human Review window:

```sh
MATRIX_DESKTOP_E2E_REQUIRED=1 MATRIX_STATUS_QUOTA_REVIEW=1 flox activate -- pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/chat-status-quota.e2e.test.ts -t 'opens a Human Review window' --maxWorkers=1 --no-file-parallelism
```

1. In Settings → Agents & providers → Codex, confirm `29% left`, a matching partly filled meter, and the reset date.
2. Close Settings, open Chat and select `UI status review (synthetic)`. Confirm clear space below the divider and the compact model row. Resize Chat to check truncation.
3. Quit the test Electron app when finished; the gateway and disposable profile are cleaned up. This environment contains synthetic data only.

Yuhan approved Human Review on October 9, 2026 at `b3fafdfcb451b4f89c88a0f30f219df3b0155699` and authorized merge after current-head Greptile 5/5 and green CI. The screenshots above use a local synthetic runtime; deployed-preview screenshots and recording remain a separate live-evidence gate.
