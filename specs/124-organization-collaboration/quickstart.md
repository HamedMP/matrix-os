# Validation and implementation quickstart

Run from the packet's manual worktree. Paths below refer to planned tests until their corresponding packet adds them. This planning change does not run runtime tests or enable any feature.

## Setup

1. Read `.specify/memory/constitution.md`, `specs/124-organization-collaboration/sol-runbook.md` and your task packet.
2. Verify current branch/base and clean ownership of its files. Record `git rev-parse HEAD` and `git rev-parse origin/main` in the implementation log.
3. Use Node 24+, pinned pnpm 10.33.4, bun and the repo's normal environment. Install from repository root with `pnpm install --frozen-lockfile`; if dependencies change, use `pnpm install` at the root and include the lockfile.
4. Configure a disposable real PostgreSQL database via `MATRIX_TEST_POSTGRES_URL`. Provider probes need separate Clerk/Stripe test-mode and disposable Matrix credentials supplied through the environment/secret manager. Never commit values. No customer org/VPS or live charge is a test fixture.
5. The optional Spec Kit hooks are `/speckit.git.commit` before/after plan/tasks. Planning uses explicit documentation commits. To resolve this feature in scripts, use `SPECIFY_FEATURE=124-organization-collaboration`; the actual git branch keeps `codex/`.

## Targeted red/green commands

Use the concrete files assigned to the packet. Representative packet commands after tests are added:

```bash
bun run test -- tests/contracts/organizations.test.ts tests/contracts/collaboration-grants.test.ts
bun run test -- tests/platform/organization-clerk.test.ts tests/platform/organization-membership-evidence.test.ts
bun run test -- tests/gateway/collaboration-grants.test.ts tests/gateway/collaboration-organization-revocation.test.ts
bun run test -- tests/ui/organization-sharing-controls.test.tsx tests/ui/shared-resource-directory.test.tsx
bun run test -- tests/platform/organization-matrix-room-client.test.ts tests/platform/organization-matrix-revocation.test.ts
```

For real database suites, refuse to count a missing-env skip as success:

```bash
test -n "$MATRIX_TEST_POSTGRES_URL"
bun run test -- --maxWorkers=1 --no-file-parallelism tests/platform/organization-lifecycle-postgres.test.ts tests/gateway/collaboration-grants-postgres.test.ts tests/gateway/collaboration-file-write-postgres.test.ts tests/gateway/collaboration-project-app-postgres.test.ts tests/gateway/sync/shared-data-plane-postgres.test.ts tests/platform/organization-billing-postgres.test.ts tests/platform/organization-funded-ai-postgres.test.ts
```

Follow current fixtures' isolation/cleanup convention; these new tests must use actual PostgreSQL, not KyselyPGlite or a fake app bridge. Run additional packet-specific Postgres suites listed in tasks, including runtime ownership, transfer and migration tests.

```bash
bun run typecheck
bun run check:patterns:diff
bun run test
bun run test:e2e
pnpm --filter shell exec tsc --noEmit
pnpm --filter desktop run typecheck
pnpm --filter matrix-os-mobile test -- --runInBand __tests__/organization-sharing.test.tsx __tests__/requests-organizations.test.ts
bun run build:shell:production
bun run build:desktop
```

These are integration/review gates, not commands to repeat after every small edit. Baseline failures must be recorded with exact failing tests and assessed, not hidden. Native validation uses the Expo dev client, not Expo Go. Use the sync-client package's own test/build scripts after S16; confirm its package name from `packages/sync-client/package.json` when invoking pnpm filters.

## End-to-end acceptance matrix

Create disposable admin A, members B/C, outsider D and explicitly admitted guest E; add more than eight org members for the no-fanout case. Exercise actual production registrations and compiled bundle paths.

| Scenario | Expected evidence |
| --- | --- |
| Org/group share for Chat/project/app/file/folder | Matching audiences discover/open; future members inherit; D sees neither existence nor content |
| Viewer and legacy sync ceilings | Every API/bridge/agent/WS mutation denied, including hidden app controls and delete where legacy editor lacked it |
| Standalone resource inside private project | No parent/sibling/attachment destination access; folder future descendants inherit |
| Shared project | Real file/Git/app/layout/child Chat/terminal/export drivers; unsupported item blocks the complete transition |
| Grant overlap/removal | Remaining independent access is explained; old member grant cannot become org guest access |
| Revoke with missed webhook/outage/quiet socket | Original evidence deadline never slides; replay, queued work, tool effects and streams reject/close within the measured bound |
| Matrix group | Human/AI token cannot read/join directly; mediated text checks current group; partition never permits stale delivery |
| File move/upload/download | Revision-confirmed boundary move; same-path recreation cannot reuse grants; delayed upload cannot alter a live key; streaming stops on revoke |
| Admin inventory | Only org-owned/org-addressed resources; personal unrelated shares absent; metadata alone grants no content |
| Org transfer/creator departure | One authoritative org runtime remains; personal credentials/drafts absent; source backup is inaccessible |
| Stripe/AI | Admin allowed/member denied; payer unchanged on admin change; concurrent retry charges once; no personal fallback |
| Migration/restart/rollback | Exact prior rights preserved; no old-binary fallback on a V2 scope; staged orphans inaccessible and cleaned |

Capture separately in Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile and CLI wherever the capability exists. Record keyboard/focus/error/reduced-motion states for the shared controls. Document any genuine platform limitation in the governing spec; do not silently omit a surface.

## Production-like gate

Use a disposable VPS-native host, exact immutable bundle and reviewed test handle; verify release metadata, gateway/shell/sync services and local health. Do not treat Docker Compose or an unbuilt checkout as production evidence. Observe startup/shutdown drains, expired caches, worker failures and recovery. Keep flags off until the current head passes its gate. Paid infrastructure, publishing this local branch, production rollout and merge are separate actions requiring task authorization. Ask whether to delete the disposable VPS afterward; clean completed local worktrees only after safe merged-state checks.
