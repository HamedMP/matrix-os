# Quickstart: Desktop Cloud Symphony

## Prerequisites

- Matrix OS development environment from the repo root.
- Node.js 24+, pnpm 10, bun.
- A local or hosted Matrix gateway/shell.
- Optional Linear credential for Linear sync tests.
- Graphite CLI authenticated and initialized for stacked PR delivery.
- Optional Apple signing/notarization secrets for desktop publish validation.
- Optional Windows signing secrets for Windows publish validation.

## Local Validation Flow

1. Install dependencies after desktop dependencies are added:

   ```bash
   pnpm install
   ```

2. Run focused desktop and gateway tests:

   ```bash
   pnpm test --fileParallelism=false \
     tests/desktop/runtime-policy.test.ts \
     tests/desktop/navigation-policy.test.ts \
     tests/desktop/app-launch.test.ts \
     tests/desktop/window-state.test.ts \
     tests/shell/desktop-app-launcher.test.tsx \
     tests/shell/workspace-cloud-runtime.test.tsx \
     tests/shell/unified-tickets.test.tsx \
     tests/shell/shared-board.test.tsx \
     tests/gateway/workspace-cloud-only.test.ts \
     tests/gateway/workspace-desktop-contract.test.ts \
     tests/gateway/project-workflow.test.ts \
     tests/gateway/project-previews.test.ts \
     tests/gateway/tickets-repository.test.ts \
     tests/gateway/tickets-linear-sync.test.ts \
     tests/gateway/tickets-routes.test.ts \
     tests/gateway/symphony-ticket-assignment.test.ts \
     tests/gateway/symphony-claim-idempotency.test.ts \
     tests/gateway/symphony-desktop-recovery.test.ts \
     tests/gateway/shared-board-auth.test.ts \
     tests/gateway/shared-board-membership.test.ts
   ```

3. Run typecheck and pattern checks:

   ```bash
   bun run typecheck
   bun run check:patterns:diff
   ```

4. Start Matrix shell/gateway:

   ```bash
   bun run dev
   ```

5. Start desktop app:

   ```bash
   bun run dev:desktop
   ```

6. Verify User Story 1:

   - Desktop opens Matrix shell as the first surface.
   - App launcher opens built-ins and installed apps.
   - Symphony, Workspace, Terminal/Session, File Browser, Settings, and Chat launch.
   - Restart restores desktop shell state.

7. Verify User Story 2:

   - Select a Matrix project.
   - Create/open a cloud worktree.
   - Observe a cloud session.
   - Confirm no local coding-agent process starts.

8. Verify User Story 3:

   - Configure Linear source if available.
   - Create a Matrix-native ticket.
   - Sync Linear tickets.
   - Confirm unified board/list preserves source identity.

9. Verify User Story 4:

   - Assign a Linear ticket and Matrix-native ticket to Symphony.
   - Confirm one active cloud claim per ticket.
   - Stop/retry one run and observe desktop status update.

10. Verify workflow setup and preview:

   - Configure repository setup/live commands and allowed preview ports.
   - Confirm Codex cloud readiness is valid before dispatch.
   - Start a live dev command in the cloud runtime.
   - Open the approved preview from the desktop app.

11. Verify shared board behavior when implemented:

   - Add another Matrix user to the project board.
   - Assign tickets to different users.
   - Confirm each user can only run Symphony where authorized.

12. Verify release workflow:

   - Run desktop release dry-run workflow.
   - Confirm platform artifacts, manifest, and checksums are produced.
   - Confirm publish mode validates signing/notarization secrets before packaging.

13. Verify security expectations:

   - Desktop-visible responses contain no provider secrets, raw DB errors, raw provider errors, filesystem paths, or cloud runner secrets.
   - Invalid external URLs are rejected.
   - Local-agent execution controls are absent and direct local-mode requests are rejected.

## Validation Notes

Latest local validation for the current stack:

- `pnpm test --fileParallelism=false tests/desktop/runtime-policy.test.ts tests/desktop/navigation-policy.test.ts tests/desktop/app-launch.test.ts tests/desktop/window-state.test.ts tests/shell/desktop-app-launcher.test.tsx tests/shell/workspace-cloud-runtime.test.tsx tests/shell/unified-tickets.test.tsx tests/shell/shared-board.test.tsx tests/gateway/workspace-cloud-only.test.ts tests/gateway/workspace-desktop-contract.test.ts tests/gateway/project-workflow.test.ts tests/gateway/project-previews.test.ts tests/gateway/tickets-repository.test.ts tests/gateway/tickets-linear-sync.test.ts tests/gateway/tickets-routes.test.ts tests/gateway/symphony-ticket-assignment.test.ts tests/gateway/symphony-claim-idempotency.test.ts tests/gateway/symphony-desktop-recovery.test.ts tests/gateway/shared-board-auth.test.ts tests/gateway/shared-board-membership.test.ts`: passed.
- `bun run typecheck`: passed.
- `bun run check:patterns:diff`: passed with warnings only; no violations.
- `pnpm --dir apps/desktop build`: passed.
- `pnpm --dir apps/desktop build:linux`: passed after allowing Electron downloads
  and adding required package metadata. Local macOS cross-host output produced
  `Matrix Desktop-0.9.0-arm64.AppImage` and `Matrix Desktop-0.9.0-arm64.deb`;
  validate Linux packaging again on the GitHub Linux runner before publishing.
- `node scripts/release/desktop/write-manifest.mjs apps/desktop/dist dev`: passed
  and wrote `desktop-release-manifest.json` with SHA-256 checksums.
- Desktop smoke flow: not run in this headless implementation pass. Use
  `bun run dev` plus `bun run dev:desktop` and verify steps 6-13 before marking
  the desktop build ready for production review.

## Residual Gaps

- Shared board membership and authorization are implemented, but rich teammate
  assignment controls need a dedicated UI iteration.
- The release workflow writes manifests/checksums, but stable publishing still
  requires live signing/notarization secret verification.
- Slay Zone parity is workflow-oriented; automated import from Slay data is not
  implemented.

## Stacked PR Flow

Use Graphite for implementation after this spec phase:

```bash
gt sync
gt stack
```

Each tasks phase maps to a Graphite stack layer. Do not flatten the stack unless explicitly requested.

## Release Notes Checklist

- Document Slay Zone workflow parity map.
- Document cloud-only differences.
- Document Linear and Matrix-native ticket setup.
- Document Symphony assignment and recovery.
- Document desktop update and connection settings.
