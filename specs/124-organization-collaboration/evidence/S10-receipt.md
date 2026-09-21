# S10 receipt — project Chat roots and owner Git broker (T050–T054)

**Packet:** S10. **Date:** 2026-09-21. **Base:** `124/s09` snapshot `6307f9c51`. **Code head before this receipt:** `a49b7e461`. One Graphite layer, `124/s10`; 25 code/test files, +1,852 / −23 versus the base, below the 3,000-addition and 50-file limits. The coordinator will restack it on the final S09 head; migration 12 from S12 must precede S10 migration 13 in the final release stack.

## Implemented and owned paths

- T050–T051: `project-chat-root-inventory.ts` reads every project Chat and its most recent canonical queued/run execution root from owner Postgres. The canonical resolver fingerprints each project or worktree root. The share preview includes root reference, branch, dirty state, and a blocker for an unresolved or missing Chat root. No host path reaches the contract. `project-inventory-source.ts`, `project-inventory.ts`, `project-sharing.ts`, `server.ts` and `project-routes.ts` carry the projection into the signed preview. The existing `chat/execution-root.ts` resolver was reused without changing its authority rules.
- T052: `project-git-broker.ts`, `project-git-operations.ts`, owner migration 13, contracts, routes, and gateway composition. A Contributor action is checked against fresh scope read access and its exact `git.commit`, `git.push`, or `git.pr` capability before the broker claims it and again before the side effect. The owner host runs Git and `gh` with the configured owner Git identity; requester and run remain in the durable operation and audit. The sandbox receives no GitHub credential. Git/forge commands have timeouts and bounded output. The broker locks the scope row while claiming distinct operations, then releases the DB transaction before external commands. An ambiguous push/PR is `unknown` and reconciles by the same operation ID, without replaying it. A `running` effect older than 60 seconds is converted to `unknown` for reconciliation after a gateway crash; unresolved effects remain blocked from replay.
- T053: `ProjectSharingDialog.tsx` and `SessionAccessControl.tsx` show Chat roots and owner Git readiness in the existing 525 dialog/popover. `project-access-readiness.ts` and its read-authorized route return only bounded Chat root and Git setup fields. The host probe reports owner identity and `gh auth status` as `ready`, `missing`, or `unavailable`, without credential bytes. The S15 project manager must mount the existing access popover on its project surface; the S10 component and route are ready.
- T054: local Git driver tests prove new commit author and committer are the configured owner, while an imported commit retains its original author. Real Postgres tests prove requester/run attribution for commits and PRs, Viewer denial, distinct-operation serialization, ambiguous push/PR reconciliation, stale-running recovery, member join without a new worktree/copy, and dirty worktree preservation after hard Chat deletion.

## RED → GREEN evidence

| Boundary | Observed RED | Observed GREEN |
| --- | --- | --- |
| Share-time roots (`project-share-inventory-postgres.test.ts`) | Missing `project-chat-root-inventory.js` module at test-first start; later a catalog Chat without a canonical root was incorrectly `ready`. | Real Postgres: 6/6, including unresolved root blocker, missing-root fail-closed behavior, accepted member join with unchanged Git worktree list and dirty bytes, and hard Chat deletion leaving a dirty worktree intact. |
| Durable Git broker (`project-git-broker-postgres.test.ts`) | Missing broker module at test-first start; distinct operations reached peak concurrency 2; stale `running` remained `running` instead of reconciling. | Real Postgres: 8/8, including migration 13, one effect for four same-ID callers, peak concurrency 1 for distinct IDs, Viewer denial, PR audit, stale recovery, and ambiguous push/PR reconciliation. |
| Host Git driver (`project-git-driver.test.ts`) | Missing `createProjectGitDriver`; later `getGitSetup` was undefined. | Local Git: 3/3, with owner author/committer, preserved imported author, stale SHA/local remote rejection, and credential-free readiness status. |
| Git and readiness routes | Git action route initially returned 404; project readiness route initially returned 404. | `project-git-routes.test.ts` 3/3 and `project-access-readiness.test.ts` 2/2; strict action schema, read authorization, generic denials, path/token omission, and shared project lifecycle. |
| Existing 525 dialog/popover | New Chat root/Git setup assertions initially could not find the fields. | `collaboration-project-sharing.test.tsx` 8/8; `session-access-control.test.tsx` 6/6. |
| Production composition | Source and gateway wiring tests initially failed before the coordinator wired dependencies. | `collaboration-project-inventory-wiring.test.ts` 1/1 and `collaboration-wiring.test.ts` 11/11, including Git broker/readiness before route registration. |

The final focused matrix after production composition used `MATRIX_TEST_POSTGRES_URL` and `CHAT_TEST_DATABASE_URL` from the local protected test env and `--maxWorkers=2`: **9 files, 47/47 passed**. After adding only the member-join test, the real Postgres inventory suite was rerun **6/6 passed**. The final real Postgres broker suite was **8/8 passed**. The protected env file and credentials were neither printed nor committed.

`PATH=/home/nima/.bun/bin:$PATH bun run typecheck` completed successfully on S10 before the coordinator's final composition commit; the coordinator reran gateway `tsc --noEmit` after composition and it passed. `bun run check:patterns` reported 0 violations and 5 existing warnings. `npx react-doctor@latest shell` completed with a repository-wide score of 37/100 and 240 findings outside the edited shared UI files; no finding was used as a S10 pass claim. Focused UI suites above passed.

## Migration and rollback

Owner collaboration migration 13 created the durable operation table and audit detail column on real Postgres; the migration test found version 13 after bootstrap. Migration 13 is additive and idempotent. A destructive down migration was not run or claimed. Rollback of application code preserves these additive tables; a data rollback would require the normal owner DB backup/restore process. S12's version 12 must be present before 13 after the coordinator restacks the packets.

## Invariants

- **Source of truth:** owner Postgres stores Chat root references, operation IDs, requester/run attribution, and audit; the owner-host Git repository and configured `gh` session supply identity and forge state. No new member worktree or copied project state is created at join.
- **Lock/transaction scope:** related operation/audit writes use transactions. The project scope row serializes operation claims, and no Git or forge command runs inside a DB transaction. Expected scope revision is checked at insert and repository HEAD SHA at side-effect time.
- **Acceptable orphan states:** `pending` may be retried; stale `running` becomes `unknown`; unresolved remote effects stay `unknown` and are never blindly replayed. A dirty worktree survives Chat deletion by design.
- **Auth source of truth:** fresh collaboration authority checks and exact Git capabilities, then broker reauthorization before host effects. Route input uses the bounded discriminated union; read-only readiness is read-authorized and exposes no host path or secret.
- **Deferred scope:** worktree leases, protected-main fencing, explicit reuse, per-Chat worktree controls, owner approval, PR merge, remote changes, and live production rollout remain outside V1 S10.

## Open validation gates

- Live GitHub push and PR creation were **unrun** because no owner-host GitHub credentials or approved remote were supplied. Tests use a local Git repository for author identity and a fake driver for durable push/PR outcomes. No live forge success is claimed.
- A live scope-runtime sandbox probe of raw Git/`gh` credential denial was **unrun**; S07 host probes require a disposable root/systemd host. S10's request schema and route reject credential fields, and the driver runs on the owner host.
- Concurrent Codex and Claude Chat execution under the same owner source belongs to S09's shared execution integration. S10 proves project Git mutation serialization; the coordinator must run the combined S09/S10 acceptance matrix after restacking on the final S09 head.
- Web Canvas, Web Desktop, and Electron Desktop runtime visual probes were **unrun** in this packet. The two shared React components and their UI tests cover the common presentation; S15 owns surface mounting and final parity evidence.
