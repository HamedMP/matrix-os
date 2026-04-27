# Quickstart: Workspace Canvas

## Prerequisites

- Node.js 24+
- pnpm 10+
- bun
- Matrix OS dev dependencies installed from the repository root

If implementation adds `@tldraw/tldraw`, run dependency installation from the repo root so `pnpm-lock.yaml` stays current:

```bash
pnpm install
```

## Development Flow

1. Start from the feature spec and plan:

```bash
vim specs/071-tldraw-workspace-canvas/spec.md
vim specs/071-tldraw-workspace-canvas/plan.md
```

2. Generate implementation tasks:

```text
/speckit-tasks
```

3. Before implementation, write failing tests for:

```text
tests/gateway/canvas-contracts.test.ts
tests/gateway/canvas-repository.test.ts
tests/gateway/canvas-routes.test.ts
tests/gateway/canvas-service.test.ts
tests/gateway/canvas-recovery.test.ts
tests/gateway/canvas-subscriptions.test.ts
tests/gateway/canvas-terminal.test.ts
tests/gateway/canvas-review-loop.test.ts
tests/shell/workspace-canvas-store.test.ts
tests/shell/workspace-canvas-renderer.test.tsx
tests/e2e/workspace-canvas.spec.ts
```

4. Implement gateway contracts and shell renderer.

5. Run targeted verification:

```bash
pnpm exec vitest run \
  tests/gateway/canvas-contracts.test.ts \
  tests/gateway/canvas-repository.test.ts \
  tests/gateway/canvas-routes.test.ts \
  tests/gateway/canvas-service.test.ts \
  tests/gateway/canvas-recovery.test.ts \
  tests/gateway/canvas-subscriptions.test.ts \
  tests/gateway/canvas-terminal.test.ts \
  tests/gateway/canvas-review-loop.test.ts \
  tests/shell/workspace-canvas-store.test.ts \
  tests/shell/workspace-canvas-renderer.test.tsx
pnpm exec vitest run tests/e2e/workspace-canvas.spec.ts
```

6. Run broader pre-PR checks:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

## Manual Verification

1. Start Matrix OS dev environment.
2. Open the browser shell.
3. Open a project or PR workspace canvas.
4. Confirm PR/review/task/terminal nodes render as typed workspace nodes.
5. Create or attach a terminal node.
6. Reload the browser and confirm node position and session identity persist.
7. Open the same canvas from a second browser session and confirm the layout is visible there.
8. Simulate a missing terminal session and confirm the node becomes recoverable instead of disappearing.
9. Add a note, file, preview, and app-window node.
10. Connect two compatible nodes and confirm the visual edge persists without mutating source-of-truth records unless explicitly confirmed.
11. Exercise terminal observe/write/takeover modes and confirm unauthorized mode changes are rejected safely.
12. Try an invalid payload, unauthorized file path, unsafe URL, and invalid custom-node migration; confirm generic recoverable errors.
13. Load or seed a 200-node canvas and confirm search/focus remains responsive under the live-node activation budget.
14. Export a canvas and confirm temporary export/preview artifacts are cleaned up according to the configured policy.

## Documentation Deliverable

Before release, add public documentation at:

```text
www/content/docs/workspace-canvas.mdx
```

The docs must cover workspace canvas concepts, terminal nodes, PR review workflows, custom node boundaries, data ownership, export/delete, and recovery expectations.
