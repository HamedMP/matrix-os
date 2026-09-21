# S20 audience layer CI repair — #1791

**Packet:** S20 T101/T102, audience layer `124/s20-audience`. **Date:** 2026-09-21. **Starting head:** `1e881c251cbb2463ed8528ebf75f5ce4b3160ea1`. **Fixture commit:** `ffb06f4852a171416dcf409059b5efa7b4566e75`. This receipt supplements the aggregate `S20-receipt.md` in the later audience UI layer; the latter holds the six-layer and surface evidence. At the time of the initial receipt, this layer had not been restacked or pushed while its lower #1794 PR was open.

The dispatched full-stack CI run `35584963094` on the later S20 UI branch failed one gateway test: `collaboration-project-lifecycle.test.ts` seeded scopes without `organization_id` and then attempted a new invitation. The S20 grant invariant correctly rejects an organization-less scope. The fixture now seeds one organization on its scopes and members; the old rule remains fail-closed.

| Evidence | Result |
| --- | --- |
| RED: `pnpm exec vitest run tests/gateway/collaboration-project-lifecycle.test.ts --maxWorkers=2` on this layer before the edit | 1 failed / 5 passed. The staged-transfer membership test threw `CollaborationRepositoryError: Scope has no organization context` at `grant-repository.ts:67`. |
| GREEN: same command after the fixture edit | 6/6 passed. |
| `pnpm exec vitest run tests/platform/collaboration-identifier-resolver.test.ts tests/platform/collaboration-internal-routes.test.ts tests/platform/collaboration-org-precondition.test.ts tests/platform/collaboration-routes.test.ts tests/gateway/collaboration-participant-resolver.test.ts tests/gateway/collaboration-org-precondition.test.ts tests/gateway/collaboration-routes.test.ts tests/gateway/collaboration-project-lifecycle.test.ts --maxWorkers=2` | 8 files, 79/79 passed, PGlite. Includes the audience resolver and the repaired lifecycle path. |
| `bun run check:patterns` | Exit 0; 0 violations, 5 pre-existing warnings. |

The first full typecheck attempt used a temporary `node_modules` symlink into the later S20 UI worktree. It reached Electron Desktop and reported three missing `organizationId` props because `@matrix-os/ui` resolved to that later worktree's API. This was a test setup artifact, not a failure of #1791 source. The symlink was removed and `pnpm install --offline --frozen-lockfile --ignore-scripts` created local links; both root and desktop `@matrix-os/ui` now resolve inside `124/s20-audience`. The correct-link `bun run typecheck` exited 0, including Electron Desktop. No desktop component source change was needed.

**Real Postgres and live gates:** The repaired lifecycle case uses PGlite and is not a lease/race proof; its staged-transfer serialization behavior predates this fixture repair. The T102 local zero inventory and deferred production inventory are recorded in `research.md`. No live Clerk, owner VPS, provider, Web Canvas, Web Desktop, or Electron Desktop journey was run for this repair; the later S20 UI layer records surface evidence. Full-stack CI on the new combined head is a coordinator gate. No deployment or external publish occurred.

## 2026-09-21 post-#1794 restack

After #1794 merged at `8be08508655b`, the three audience commits were replayed onto that exact `main` merge. The prior branch head and binary patch were preserved as `refs/backup/124-s20-audience-before-main-restack-20260921-1328` and `/tmp/s20-audience-before-main-restack-20260921-1328.patch` (SHA-256 `1eb7fce0aa6c74307b9162bc9ae0789a3df040ddfbd8eb913c9e6f1cf7343297`). The resulting audience diff has 23 files, 345 additions and 57 deletions before the one-line fixture cleanup. `gt restack --only` reported no further rebase needed, and a forced Graphite dry run targeted only #1791.

The post-restack eight-file audience suite passed **79/79**. It emitted a Vite warning for a duplicate `organization_id` fixture key: `ORGANIZATION_ID` and the same literal value were both present. Removing the redundant literal left one canonical value; the focused lifecycle suite then passed **6/6** without the duplicate-key warning. This is fixture cleanup, not a production behavior change. Current-head Greptile and full CI are still required after submission.
