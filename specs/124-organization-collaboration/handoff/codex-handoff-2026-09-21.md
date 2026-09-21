# Codex handoff — spec 124 organization collaboration (2026-09-21 09:50 UTC)

This is a full handoff of the running spec 124 implementation from Claude to Codex on the
same machine (`/home/nima`). Read it top to bottom before touching anything. It tells you
where every piece of work lives, what is finished, what is half-done, what is next, and how
the orchestration works. Nothing here is a suggestion; the decisions are locked.

Companion artifacts in this directory (section 10 has the paste-ready prompt that starts Codex):

- `s09-uncommitted-2026-09-21.patch` — snapshot of the uncommitted S09 edits (also live in the worktree).
- `s12-uncommitted-2026-09-21.patch` — snapshot of the uncommitted S12 edits (also live in the worktree).

## 0. First five actions (do these before anything else)

1. **The Claude agents are already stopped.** The coordinating Claude background job
   `98b4e810` ("org collaboration implementation") and its four workers were terminated at
   10:05 UTC on 2026-09-21 after their last write at 09:21 UTC; both worktrees were verified
   byte-identical to the patch snapshots afterwards. The Claude background daemon auto-resumed
   that job once at 10:06 UTC, so it was then told to stop itself and exit (a clean exit marks
   the job done and is not respawned). Before you edit, confirm nothing respawned:
   `ps -eo pid,cmd | grep -E "claude (bg-spare|agents)" ` should show no session whose bash
   children sit in a `matrix-os-124-*` worktree, and `lsof +D <worktree>/packages` should be
   empty. If the owner reopens `claude agents` and that job shows as resumable, it must be
   deleted there, not resumed.
2. **Verify the worktree map** in section 3 against `git -C /home/nima/matrix-os worktree list`
   and `git -C <wt> status --short`. If a worktree has *more* uncommitted changes than listed
   here, the Claude worker kept writing after this handoff; keep those edits, they are newer.
3. **Commit the in-flight edits as WIP** on their branches so nothing lives only in a working
   copy: in `matrix-os-124-s09` and `matrix-os-124-s12` run
   `git add -A && git commit -m "wip(collaboration): S0N handoff snapshot"` then `git push`.
   You will squash/re-cut these into proper `test(...)` / `feat(...)` commits before submitting.
4. **Read the feature artifacts** in `specs/124-organization-collaboration/`: `spec.md`,
   `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`,
   `sol-runbook.md`, and every `evidence/S*-receipt.md`. Read `AGENTS.md` (root) and
   `.specify/memory/constitution.md`. Read `docs/dev/stacked-prs.md` and
   `docs/dev/review-pipeline.md`.
5. **Run `gt log short` from any 124 worktree** and compare with section 4. Then start the
   orchestration in section 6.

## 1. Goal

Ship **organization collaboration V1** for Matrix OS exactly as `specs/124-organization-collaboration/spec.md`
defines it: an owner shares a project, or any standalone Chat, terminal, file, folder or app
instance, with members of their Clerk organization using one of two whole-resource presets
(Viewer, Contributor). Members reach the owner's home computer through a transparent platform
relay; every authorization decision happens on the home. Members may prompt the owner's AI
(Codex or Claude harness, one owner-selected AI source per project) when the organization
allows it, may commit/push/PR through a Git broker under the owner's identity without owner
approval, and see truthful readiness state inside the confirmed 525 collaboration UI. All of
this lands as one coordinated release: one Graphite stack of small reviewed PRs, merged bottom
up, followed by one cutover migration that makes the direct protocol the only serving path.

"Done" means: every packet in the release path (section 5) merged to `main` with current-head
Greptile 5/5 and green CI, receipts in `evidence/`, the S18 cutover proven on real Postgres,
and the S19 acceptance matrix recorded. Deployment to customer VPSes needs the owner's explicit
go; do not deploy or publish externally on your own.

## 2. Locked product decisions (do not reopen, do not ask)

- Sharing exists **only inside a Clerk organization**; the organization is the only gate.
  Legacy release flag, rollout cohort and person-to-person sharing were deleted in S20.
- **V1 minimum scope**: Clerk membership projection only. Organizations are administered in the
  Clerk dashboard. No groups, guests, invitation quotes, org billing, sponsorship, member
  computers, transfer, pooled org computer, or managed Matrix group text.
- **Two presets only**: Viewer and Contributor, whole resource. Every resource type is shareable
  standalone (project, Chat, terminal, file, folder, app instance). Folder share includes its
  contents. Chat Viewer reads history and discussion only. Terminal Viewer observes only;
  Contributor may hold the controller.
- **Org-wide shares are pending per member**; opening is accepting, via `POST .../accept`,
  recorded in `collaboration_grant_activations`. Never activate on list or preview fetch.
- **One owner-selected AI source per project** (S08). Members may submit prompts when org
  metadata `collaboration.aiSubmission="members"`, otherwise owner-only. No provider-eligibility
  enforcement beyond that. Shared discussion never implicitly invokes AI.
- **Run control**: cancel and tool-approval answers are allowed only to the requesting member
  or the project/Chat owner. Retry of an interrupted or failed request is requester-only (owner
  denied). When the home loses a run for any reason (gateway restart, scope-runtime crash, run
  unit exit without terminal result, control-stream lease loss) mark it interrupted with the
  requester attributed and re-admit preserved queued requests only where the requester's
  membership evidence is fresh. Reattaching to a surviving run unit is deferred.
- **Git**: no owner approval; broker commits/pushes/PRs under the owner identity with the
  requesting member in audit. No per-Chat worktrees; inventory every existing Chat root at
  share time. No integration delegation.
- **Transport**: transparent platform relay, extracted not deleted, makes no authorization
  decision and parses no payload. Tickets bind runtime ID and generation, not hostname. No
  per-home hostnames or certificates.
- **UI**: the confirmed 525 interaction model is the baseline. Add state and controls inside its
  chrome; never add new collaboration headers, composers, share dialogs or inboxes. Web Canvas,
  Web Desktop, Electron Desktop only; Native Mobile and CLI are a recorded limitation.
- **Sandbox**: shared runs and terminals execute only inside the S07 sandbox manifest. No
  prompt-only sandbox, no hidden wider file or integration access, no credential export.
- Open UI questions listed in `spec.md` are the product owner's; do not answer them yourself.

## 3. Worktree and branch map (all on this machine, owner `nima`)

Main checkout: `/home/nima/matrix-os` on `main` at `e62d3fc62`. Never commit there.

| Worktree | Branch | HEAD | Packet | State |
| --- | --- | --- | --- | --- |
| `/home/nima/matrix-os-124-s20` | `124/s20-audience-ui` | `e5f2fca10` | S20 top layer (6 layers: `124/s20`, `-organization`, `-cohort`, `-cohort-platform`, `-audience`, `-audience-ui`) | clean, in review |
| `/home/nima/matrix-os-124-s20-l1` | `124/s20-cohort` | `31c77058a` | S20 layer 3 | clean, in review |
| `/home/nima/matrix-os-124-s02` | `124/s02` | `79a8b846c` | S02 contracts freeze | clean, in review |
| `/home/nima/matrix-os-124-s03` | `124/s03` | `d858e446f` | S03 Clerk membership + control authority | clean, in review |
| `/home/nima/matrix-os-124-s04` | `124/s04` | `4a749a98b` | S04 preset grants + org precondition | clean, in review |
| `/home/nima/matrix-os-124-s05` | `124/s05-relay` | `65732f301` | S05 top layer (`124/s05`, `-gateway`, `-relay`) | clean, in review |
| `/home/nima/matrix-os-124-s08` | `124/s08` | `ac02be560` | S08 owner AI source | clean, in review |
| `/home/nima/matrix-os-124-s06` | `124/s06` | `88895d988` | S06 direct client + discovery | clean, in review |
| `/home/nima/matrix-os-124-s07` | `124/s07-terminal` | `eb6a4b4c7` | S07 top layer (`124/s07`, `-terminal`) | clean, in review |
| `/home/nima/matrix-os-124-s09` | `124/s09` | `c4fd0f594` | **S09 shared Codex/Claude execution — IN PROGRESS** | 7 modified files uncommitted (see 3.1); pushed to origin at `c4fd0f594`; no PR yet |
| `/home/nima/matrix-os-124-s12` | `124/s12` | `24df3dbc3` | **S12 resource adapters — IN PROGRESS** | 13 modified + 6 new files uncommitted (see 3.2); pushed to origin at `24df3dbc3`; no PR yet; `gt` says needs restack |
| `/home/nima/matrix-os-124-handoff` | `124/handoff` | this doc | handoff | commit + push this doc here |

Not yet created (create when you start them, see 6.3): S10 (`matrix-os-124-s10`, `124/s10`),
S15 (`124/s15`), S18 (`124/s18`), S19 (`124/s19`).

Other worktrees under `/home/nima/` (`matrix-os-collaboration-ux-redesign` = the 525 UI
baseline stack, `matrix-os-org-collab-spec`, `matrix-os-codex-shared-chat`,
`matrix-os-claude-shared-ai-compatibility`, etc.) are older, merged or unrelated stacks. Do not
touch them. Every 124 worktree carries an unrelated stash
`wip-fence-invitation-mutations` from an old `codex/project-sharing-integration` branch; ignore it.

### 3.1 S09 in-flight detail (`/home/nima/matrix-os-124-s09`)

Committed on `124/s09` (stacked on `124/s07-terminal` @ `eb6a4b4c7`):

- `b989b52b4` test(collaboration): failing suite `tests/gateway/shared-coding-execution.test.ts`
  (443 lines) covering: migration v11 registration; run control actors (cancel by requester or
  owner, denied to other Contributors/Viewers; retry requester-only; tool approval by requester
  or owner with relation recorded); home loses a run (first loss reason wins, `gateway_restart`
  attribution across restart, `control_partition` interruption via orchestrator, re-admission
  only with fresh membership, loss-reason classification); focused adapters (Codex on project
  root inside sandbox manifest, Claude same contract refusing resume state/non-text parts, root
  without manifest refused, runtime crash / run-unit exit reported as loss reasons).
- `c4fd0f594` feat(collaboration): `shared-run-loss.ts` (tables
  `collaboration_run_interruptions`, `collaboration_run_decisions`, migration version **11**),
  run-control actor enforcement.

Uncommitted (T046–T048 in progress, 206 insertions / 15 deletions across 7 files):

- `packages/contracts/src/collaboration-execution.ts`, `packages/gateway/src/collaboration/run-account-binding.ts`:
  `executionRoot` becomes nullable for standalone Chats (fingerprint digests Chat identity).
- `packages/gateway/src/chat/queue-repository.ts`: `sharedExecution.queuedTurnId` on claimed turns.
- `packages/gateway/src/chat/shared-execution-coordinator.ts`: new `SharedDispatchRun`, adapter
  factory now receives `(context, run)`; rooted runs are no longer rejected at dispatch.
- `packages/gateway/src/chat/orchestrator.ts`: signature follows the coordinator.
- `packages/gateway/src/collaboration/shared-ai-runtime.ts` (+155): wires
  `createSharedCodexAdapter` / `createSharedClaudeAdapter` (files already exist on the branch),
  sandbox manifest, execution-root resolver, `interruptActiveSharedRuns`,
  `markLostSharedRunsOnStartup`, `CollaborationRunBindingError`.
- `packages/gateway/src/collaboration/shared-run-loss.ts` (+28).

Remaining for S09: finish T047/T048 wiring until `pnpm exec vitest run tests/gateway/shared-coding-execution.test.ts`
is green (run the lock/race cases against the real Postgres URL, section 7); make sure
`/scopes/:scopeId/chat/requests*`, `/chat/approvals*`, `/chat/requests/:id/retry` enforce the
actor rules for project scopes and standalone Chat scopes (standalone Chat: policy row and
privileged actor resolve on the Chat scope with the Chat owner in the owner role); T049 live
Codex/Claude probes stay **unrun** unless the owner supplies approved credentials (record as
unrun in the receipt, do not fake); write `evidence/S09-receipt.md` in the S01/S07 receipt
format; split into ≤3000-addition layers if needed; `gt submit`.

### 3.2 S12 in-flight detail (`/home/nima/matrix-os-124-s12`)

Committed on `124/s12` (stacked on an older `124/s07-terminal` @ `a149fad58`, so **restack onto
`eb6a4b4c7` first** with `gt restack --only`):

- `24df3dbc3` test(collaboration): failing suite `tests/gateway/direct-resource-policy-postgres.test.ts`
  covering catalog identity across rename/delete, project-scope viewer/contributor rules with
  revision checks and idempotent replay, namespace isolation, standalone file/folder/app/Chat/terminal
  shares, whole-project preset mapping, concurrent same-base-revision writes (exactly one wins),
  post-revocation write denial, and the frozen route table.

Uncommitted (T061/T062/T064 in progress, 84 insertions / 20 deletions in 13 files + 6 new files, 1157 lines):

- New: `packages/contracts/src/collaboration-resources.ts` (catalog/file/app schemas, safe
  relative path rule, inline/upload size limits), `packages/gateway/src/collaboration/resource-catalog.ts`
  (`CollaborationResourceCatalog`, `migrateResourceCatalogV12`), `resource-routes.ts`
  (`registerResourceRoutes`, `CollaborationResourceServices`), `resource-actions.ts`,
  `app-instance-adapter.ts`, `upload-stages.ts`.
- Modified: `database.ts` (scope/event/outbox kinds gain `file|folder|app`; tables
  `collaboration_resource_catalog`, `collaboration_upload_stages`), `database-migrations.ts`
  (registers migration version **12**; 11 reserved for S09), `routes.ts` (mounts resource routes
  after execution-policy routes), `route-support.ts` (error mapping for catalog/adapter errors,
  `resources` option), `authority.ts`, `directory-outbox.ts`, `events.ts`, `repository-types.ts`,
  `terminal-adapter.ts`, `packages/contracts/{package.json,src/collaboration.ts,src/index.ts}`.

Remaining for S12: finish until the suite is green on real Postgres (concurrent write and
revocation cases); own the standalone Chat scope read/discussion routes
(`GET /scopes/:scopeId/chat`, `/chat/messages`, `/discussion/messages`, `/user-state`) and
standalone terminal routes (`/scopes/:scopeId/terminal*`) with preset enforcement; **do not**
mount `/chat/requests*` or `/chat/approvals*` (S09 owns them); T062 streaming reads, staged
uploads, resume, checksums, cancel on revoked lease, staging cleanup; T064 bridge/sandbox asset
proof across Web Canvas, Web Desktop, Electron Desktop; T063 stays deferred; write
`evidence/S12-receipt.md`; `gt submit`.

## 4. Open PR stack (bottom → top) and review state

Merged on `main`: spec #1769, clarify #1773, baseline #1761 and #1765, S00 #1784,
S01 #1785/#1788/#1786/#1787.

Stack order (base → child), all non-draft:

```
main
└─ 1789 124/s20                → 1793 124/s20-organization → 1790 124/s20-cohort
   → 1794 124/s20-cohort-platform → 1791 124/s20-audience → 1795 124/s20-audience-ui
   → 1792 124/s02 → 1796 124/s03 → 1797 124/s04
   → 1802 124/s05 → 1803 124/s05-gateway → 1804 124/s05-relay
   → 1805 124/s08 → 1806 124/s06 → 1807 124/s07 → 1808 124/s07-terminal
   → (local, no PR yet) 124/s09  and  124/s12  (siblings on s07-terminal)
```

Gateway collaboration migration versions in use: S20=7, S04=8, S05=9, S08=10, S09=11,
S12=12. S10 and later append at 13+.

### 4.1 Review and CI state per PR (snapshot 2026-09-21 ~09:30 UTC; re-check before acting)

All 16 PRs are MERGEABLE. GitHub shows `mergeStateStatus: UNSTABLE` on every PR only because
the ignored `claude-review` job fails. No reviewer other than the author has commented; no
CHANGES_REQUESTED reviews. Every head was force-pushed at ~09:01 UTC in one coordinated
restack and Greptile re-scored each head between 09:06 and 09:26 UTC, so the scores below are
current-head scores. "Unresolved" = unresolved Greptile inline threads.

| PR | branch | Greptile | CI | `ready-for-ci` | Blockers to clear |
| --- | --- | --- | --- | --- | --- |
| 1789 | `124/s20` | 5/5 | full matrix runs (base is `main`); all jobs pass, run finalizing | yes | none. **Merge this first.** |
| 1793 | `124/s20-organization` | 5/5 | gate only | no | 1 current P1 thread on `project-inheritance.ts`, 2 outdated |
| 1790 | `124/s20-cohort` | 5/5 | gate only | no | none |
| 1794 | `124/s20-cohort-platform` | 5/5 | gate only (a "fail" on connect-share-preview is a cancelled superseded run) | no | none |
| 1791 | `124/s20-audience` | 5/5 + approved | gate only | no | none |
| 1795 | `124/s20-audience-ui` | 5/5 + approved | gate only | no | 2 P2 threads (evidence README, electron-capture test); one item deferred to #1798 |
| 1792 | `124/s02` | 5/5 | gate + Codex contracts check | yes (inert until base is `main`) | none |
| 1796 | `124/s03` | 4/5 | gate only | no | P1 `organizations/database.ts`, P2 `repository.ts`; Greptile flags PR size, outbox missing columns, duplicate denial fences |
| 1797 | `124/s04` | 5/5 | gate only | no | 1 outdated P1 thread (`capability-evaluator.ts`) |
| 1802 | `124/s05` | 3/5 | gate only | no | 11 threads, 7 current: ticket-issuer x3, control-authority P1, control-upgrade, bootstrap, tickets test. Themes: idle homes go offline, disconnected homes block denial delivery, instance-local control state |
| 1803 | `124/s05-gateway` | 4/5 | gate only | no | 6 threads, 5 current P1: wiring x2, direct-sessions x2, direct-websocket. Themes: denied actions consume budget, control socket fails under ESM |
| 1804 | `124/s05-relay` | 5/5 | gate only | no | 2 outdated P1 threads (`relay.ts`) |
| 1805 | `124/s08` | 5/5 | gate only | no | 1 current P1 on `wiring.ts`, 2 outdated |
| 1806 | `124/s06` | **0/5** | gate only | no | 8 current threads (5 P1): unavailable streams reconnect, closed sessions return, pending shares disappear, open action always fails, duplicate property breaks validation |
| 1807 | `124/s07` | **1/5** | gate only | no | 4 current P1: shared Chats bypass sandbox, no production sandbox roots, terminal support overstated, readiness probe unwired |
| 1808 | `124/s07-terminal` | **2/5** | gate only | no | 4 current (3 P1): fresh sessions blocked, exhaustion revokes valid sessions, host control withdrawal lost, unbounded pending-operations registry |

Notes for the coordinator:

- "Gate only" means the Gate/Greptile/check/preview jobs ran, not the test matrix. The real
  matrix (Type Check, Unit Tests, Shell Production Build, ...) runs only when the base is
  `main`, so each PR gets its first real CI only after the one below it merges. Run the suites
  locally per worktree before merging, or dispatch `gh workflow run ci.yml --ref <branch>`.
- The author left replies on 1796 and 1797 saying fixes were "in a local commit, lands with the
  next coordinated push" (commits `4a674a3f7`, `deeb57d2e`, pre-rebase SHAs). The 09:01 push
  rebased everything and no 124 worktree has unpushed commits, so they should be in the current
  heads. Confirm by reading the threads against the current diff before resolving them.
- Greptile has been re-requested many times on 1792 (11), 1797 (9), 1791 (8), 1789/1796 (6+).
  Stop doing that: request once per new head, then poll.
- PR bodies for 1789 and 1792 carry the Invariants section but not the five-surface matrix
  (1792 is contracts-only). Add the matrix to every user-visible PR (1795, S06, S15) before merge.
- **Review-fix work is packet work.** Assign the 1802/1803 fixes to whoever owns S05 next, and
  the 1806/1807/1808 fixes to the S06/S07 owner. These are lower in the stack than S09/S12,
  so every fix there forces a restack of S09/S12; batch fixes per layer and restack once.

## 5. Release path and dependencies

`S00 → S01 → S20 → S02 → S03 → S04 → S05 → S08 → S06 → S07 → S09 → S10 → S12 → S15 → S18 → S19`.
Deferred from V1 and **not to be built**: S11, S13, S14, S16, S17, T063, T077.

| Packet | Tasks | Depends on | Status |
| --- | --- | --- | --- |
| S20 org-only precondition, flag/cohort removal | T098–T102 | S01 | in review (6 PRs) |
| S02 frozen wire contracts | T010–T014 | S20 | in review |
| S03 Clerk membership projection, control authority | T015–T019 | S02 | in review |
| S04 whole-project presets, org precondition | T020–T024 | S03 | in review |
| S05 relay, home sessions, tickets, revocation | T025–T029, T103 | S04 | in review (3 PRs) |
| S08 single owner AI source | T040–T044 | S05 | in review |
| S06 direct clients, discovery | T030–T034 | S08 | in review |
| S07 sandbox for runs and terminals | T035–T039 | S06 | in review (2 PRs) |
| **S09** shared Codex/Claude execution | T045–T049 | S07, S08 | **in progress** |
| **S10** Git broker, share-time root inventory | T050–T054 | S09 | not started |
| **S12** resource adapters | T060–T064 | S06, S07 | **in progress** |
| **S15** readiness/permission UI in the 525 chrome | T075–T079 | S06, S10, S12 | not started |
| **S18** one coordinated cutover and legacy removal | T088–T092 | S15 | not started |
| **S19** release acceptance and docs | T093–T097 | S18 | not started |

Linearize the tail of the stack as `s07-terminal → s09 → s10 → s12 → s15 → s18 → s19`
(restack `124/s12` onto `124/s10` once S10 exists, so S15 sits on both).

## 6. Orchestration: how to run this

### 6.1 Roles

One **coordinator** (you, the Codex session started in `/home/nima/matrix-os`) and at most
**three workers** at a time (Codex subagents, each pinned to one packet worktree). The
coordinator never edits packet files; it owns shared exports/manifests/lockfile, gateway
bootstrap and exact route registration, platform startup, signing config, PR stack hygiene,
review driving and merging. Workers own only their packet's files and must preserve other
packets' edits.

### 6.2 Immediate assignment (start now)

| Worker | Worktree | Job |
| --- | --- | --- |
| W1 | `/home/nima/matrix-os-124-s09` | Finish S09 (3.1). Deliver receipt + `gt submit`. |
| W2 | `/home/nima/matrix-os-124-s12` | Restack onto `eb6a4b4c7`, finish S12 (3.2). Deliver receipt + `gt submit`. |
| W3 | `/home/nima/matrix-os-124-s10` (create it: `git worktree add -b 124/s10 ../matrix-os-124-s10 124/s09` then `gt track --parent 124/s09` from inside) | Start S10 T050 (failing `tests/gateway/project-share-inventory-postgres.test.ts`) and T051/T052 against the S09 seams as they stabilize; coordinate with W1 on `chat/execution-root.ts`. |
| Coordinator | `/home/nima/matrix-os` + each in-review worktree | Drive the 16 open PRs to merge (6.5). Rebase S09/S12 when lower layers change. |

When W1 finishes, W3 continues S10 to completion. When W2 and W3 finish, start S15 (one
worker, React; needs Web Canvas → Web Desktop → Electron evidence and `npx react-doctor@latest shell`).
Then S18 (one worker, real Postgres, cutover journal), then S19 (coordinator).

### 6.3 Worker prompt (use verbatim, fill packet/tasks/worktree)

> Implement packet Sxx, tasks Tnnn–Tmmm, from specs/124-organization-collaboration/tasks.md in
> the worktree /home/nima/matrix-os-124-sxx on branch 124/sxx. Read
> specs/124-organization-collaboration/handoff/codex-handoff-2026-09-21.md, AGENTS.md,
> .specify/memory/constitution.md, then all feature artifacts and every evidence/S*-receipt.md.
> Own only this packet's files listed in tasks.md and the S01 receipt ownership table; other
> workers are active in sibling worktrees, so preserve their seams and coordinate overlapping
> modules through the coordinator. Start with failing behavior tests, use the real Postgres URL
> for races/migrations/leases, and record exact RED and GREEN output. Reuse canonical Chat,
> provider V3, worktree, authority and route-support seams. Follow the locked decisions in the
> handoff section 2. Keep each PR under 3000 additions and 50 files; split into Graphite layers
> with `gt create --all --message "<conventional commit>"`. Run `bun run typecheck`,
> `bun run check:patterns`, the focused vitest suites, and `npx react-doctor@latest shell` when
> React files change. Write evidence/Sxx-receipt.md (task IDs, base/head SHAs, changed files,
> RED, GREEN, DB/host/provider/surface evidence, unrun modes, migration and rollback result;
> no credentials). Submit with `gt submit --stack` (or `--force` if remote heads were Graphite
> auto-rebases). Do not merge, deploy, provision paid services or publish externally. Return
> changed paths, tests, head SHA, open gates.

### 6.4 Conventions

- Worktree per packet at `/home/nima/matrix-os-124-<packet>`; branch `124/<packet>[-layer]`;
  stacked with Graphite on the previous packet's top branch. Create with
  `git worktree add -b 124/<packet> ../matrix-os-124-<packet> <parent-branch>` and track the
  parent with `gt track`.
- Conventional commits, test commit first, then feat, then docs receipt.
- Receipts live in `specs/124-organization-collaboration/evidence/Sxx-receipt.md` and follow
  `S01-receipt.md` / `S07-receipt.md` (layers table, RED→GREEN table, file ownership, Invariants,
  Gates). PR bodies carry the Invariants section and the five-surface matrix from AGENTS.md.
- Every PR title is a Conventional Commit, no `[codex]` prefixes.

### 6.5 Review and merge procedure (coordinator)

1. `.github/workflows/ci.yml` runs only for PR bases `main`, `stack/**`, `codex/**`. A stacked
   PR whose base is another `124/*` branch gets **no CI** until it is retargeted to `main` by
   the merge of the PR below it. To run CI early: `gh workflow run ci.yml --ref <branch>` or
   apply the `ready-for-ci` label.
2. Greptile reviews on push, but re-reviews only after a comment `@greptileai please review`.
   It edits its summary comment in place; scan all its comments for the current head SHA. Never
   post a second request while one is pending. Every restack invalidates the current-head 5/5.
3. Merge gate per PR: base is `main` (check `gh pr view N --json baseRefName`), Greptile 5/5 on
   the current head, CI green (the `claude-review` job may be ignored, owner's instruction
   2026-09-21), no unresolved human/Codex review blockers, `ready-for-ci` applied.
4. Land **strictly one PR at a time**, bottom first, with `gt merge` or the Graphite queue.
   Never `--delete-branch` while a later PR is open, never loop `gh pr merge`. After each merge
   wait until the next PR's base shows `main`, restack the remaining branches
   (`gt restack --only` per branch inside its worktree; `gt sync --no-restack` to avoid rewriting
   the owner's unrelated `codex/*` stacks), resubmit with `gt submit --stack` (`--force` when
   remote heads were Graphite auto-rebases), then re-request Greptile.
5. Use `/monitor-stack-reviews` (`.claude/commands/monitor-stack-reviews.md` describes the
   gate) if you want a scripted watch; the rules above are what it enforces.
6. `gh` and `gt` are authenticated as `Nima-Naderi`. Codex CLI 0.155.0 is at `/home/nima/.local/bin/codex`.

## 7. Environment

- Node 24, pnpm 10.33.4, bun at `/home/nima/.bun/bin/bun`. Run `pnpm install` from the repo
  root after dependency changes.
- Real Postgres for races/migrations/leases: docker container `matrixos-staging-postgres`
  (healthy) at `172.18.0.7:5432`, user `matrixos`, database `matrixos_test_124`. Export both
  `CHAT_TEST_DATABASE_URL` and `MATRIX_TEST_POSTGRES_URL` as
  `postgres://matrixos:<password>@172.18.0.7:5432/matrixos_test_124` (password is in the owner's
  local env, not in this repo). PGlite is the default and cannot express row-lock races; gate
  such tests on the real URL as existing `*-postgres.test.ts` suites do.
- Host is 15 GB / 8 cores and OOM-kills parallel suites: use `--maxWorkers=2` or `3`, one wide
  run at a time, build prerequisites first (`bun run build` for packages the tests import).
- Focused tests: `pnpm exec vitest run <path> --maxWorkers=2` (the `bun run test -- <path>`
  filter fans out).
- Pre-PR checklist: `bun run typecheck`, `bun run check:patterns`, `bun run test`,
  `npx react-doctor@latest shell` for React changes, `bun run build:shell:production` when
  `shell/` or shell-facing `packages/platform/` change.

## 8. Gates, unrun probes and follow-ups

- Live S00 fixtures (Clerk test organization, approved Codex/Claude credentials, disposable VPS
  for two-computer relay proof) still need the owner's approval. The probe harnesses exist in
  `tests/integration/collaboration-{provider,authority,direct}-boundaries.integration.ts`; keep them **explicitly unrun** in
  receipts. Never fake a pass; capability flags become true only for observed paths.
- #1798 (open): Web Desktop and Electron Desktop cannot reach the project share control; owned
  by S15 T078.
- #1799 (open): extract owner-database startup and collaboration registration from
  `packages/gateway/src/server.ts` (4,828 LOC on main, above the 2000-LOC split-before-adding
  threshold); coordinator-owned refactor, land it before S18 T090 adds registration changes there.
- The `claude-review` CI job is known-failing and ignored by the owner.
- Failed cutover keeps collaboration fenced until recovery; no legacy proxy fallback.

## 9. Where things are

| What | Path |
| --- | --- |
| Spec set | `specs/124-organization-collaboration/{spec,plan,research,data-model,quickstart,tasks,sol-runbook}.md`, `contracts/` |
| Evidence receipts | `specs/124-organization-collaboration/evidence/` (S00–S08, S20, direct.md, providers.md) |
| Gateway collaboration code | `packages/gateway/src/collaboration/` (routes split per resource, `route-support.ts`, `authority.ts`, `database-migrations.ts` registry) |
| Shared execution | `packages/gateway/src/chat/{shared-execution-coordinator,queue-repository,orchestrator,execution-root}.ts`, `packages/gateway/src/collaboration/{shared-ai-runtime,shared-codex-adapter,shared-claude-adapter,shared-run-loss,run-account-binding}.ts` |
| Platform side | `packages/platform/src/collaboration/` (relay, tickets, membership projection, control authority), `packages/platform/src/database/` |
| Contracts | `packages/contracts/src/collaboration*.ts` |
| UI baseline (525) | `packages/ui/src/collaboration/`, `shell/src/components/` share dialog / access popover / `SharedTerminalControls`; spec `specs/525-collaboration-ux-redesign/` |
| Stack rules | `docs/dev/stacked-prs.md`, `docs/dev/review-pipeline.md`, `.claude/commands/monitor-stack-reviews.md` |

## 10. Paste-ready prompt for the Codex coordinator

Start Codex in the main checkout (`cd /home/nima/matrix-os && codex`) and paste this:

```
You are taking over as coordinator of the spec 124 "organization collaboration" implementation
for HamedMP/matrix-os on this machine, continuing work a Claude coordinator ran until
2026-09-21 09:21 UTC. That Claude job and its workers are stopped; you own everything now.

FIRST, read in this order and do not skip:
1. /home/nima/matrix-os-124-handoff/specs/124-organization-collaboration/handoff/codex-handoff-2026-09-21.md
   (branch 124/handoff, draft PR #1810). It is the state ledger: goal, locked decisions,
   worktree map, in-flight S09/S12 detail, per-PR review state, release path, orchestration,
   worker prompt, merge procedure, environment, gates.
2. /home/nima/matrix-os/AGENTS.md and .specify/memory/constitution.md.
3. specs/124-organization-collaboration/{spec,plan,research,data-model,quickstart,tasks,sol-runbook}.md,
   contracts/, and every evidence/S*-receipt.md (read them from the 124/s07 worktree
   /home/nima/matrix-os-124-s07, which has receipts through S08 and S20).
4. docs/dev/stacked-prs.md and docs/dev/review-pipeline.md.

STATE IN ONE PARAGRAPH: main is at e62d3fc62. Merged: spec #1769, clarify #1773, baseline
#1761/#1765, S00 #1784, S01 #1785/#1788/#1786/#1787. Open Graphite stack bottom-up:
#1789 124/s20 -> #1793 -> #1790 -> #1794 -> #1791 -> #1795 (S20, six layers) -> #1792 124/s02
-> #1796 124/s03 -> #1797 124/s04 -> #1802 124/s05 -> #1803 124/s05-gateway -> #1804 124/s05-relay
-> #1805 124/s08 -> #1806 124/s06 -> #1807 124/s07 -> #1808 124/s07-terminal. Every PR has a
manual worktree at /home/nima/matrix-os-124-<packet>. Two packets are half done with
UNCOMMITTED edits sitting in their worktrees: S09 shared Codex/Claude execution in
/home/nima/matrix-os-124-s09 (branch 124/s09 @ c4fd0f594, 7 modified files) and S12 resource
adapters in /home/nima/matrix-os-124-s12 (branch 124/s12 @ 24df3dbc3, 13 modified + 6 new
files; needs restack onto 124/s07-terminal eb6a4b4c7). Both branches are pushed; the
uncommitted diffs are also saved as verified patches next to the handoff doc. S10, S15, S18,
S19 are not started. Gateway collaboration migration versions: S20=7, S04=8, S05=9, S08=10,
S09=11, S12=12; append at 13+. Greptile is 5/5 on nine PRs but 0/5, 1/5, 2/5 on #1806, #1807,
#1808 with unresolved P1 threads, 3/5 on #1802, 4/5 on #1796 and #1803. Only #1789 (base main)
runs the real CI matrix; the workflow ignores PRs whose base is a 124/* branch.

GOAL: ship organization collaboration V1 exactly as spec.md defines it, as one coordinated
release: every packet on the release path S20 -> S02 -> S03 -> S04 -> S05 -> S08 -> S06 -> S07
-> S09 -> S10 -> S12 -> S15 -> S18 -> S19 merged to main with current-head Greptile 5/5, green
CI, receipts in evidence/, the S18 cutover proven on real Postgres, and the S19 acceptance
matrix recorded. S11, S13, S14, S16, S17, T063, T077 are deferred; do not build them. The
product decisions in handoff section 2 are locked; never reopen them or ask about them.

DO NOW, in order:
1. Confirm no process is writing to the 124 worktrees (handoff section 0 step 1).
2. In matrix-os-124-s09 and matrix-os-124-s12: git add -A && git commit -m "wip(collaboration):
   S0N handoff snapshot" && git push. You will re-cut these into test/feat/docs commits later.
3. Spawn three worker subagents, each pinned to one worktree, using the worker prompt in
   handoff section 6.3 verbatim with the packet filled in:
   W1 -> S09 in /home/nima/matrix-os-124-s09 (finish T046-T048 until
        tests/gateway/shared-coding-execution.test.ts is green; T049 live probes stay unrun
        unless the owner supplies credentials; write evidence/S09-receipt.md; gt submit).
   W2 -> S12 in /home/nima/matrix-os-124-s12 (gt restack --only onto 124/s07-terminal first;
        finish T061/T062/T064 until tests/gateway/direct-resource-policy-postgres.test.ts is
        green on real Postgres; do NOT mount /chat/requests* or /chat/approvals*, S09 owns
        them; write evidence/S12-receipt.md; gt submit).
   W3 -> S10 in a new worktree: git -C /home/nima/matrix-os worktree add -b 124/s10
        ../matrix-os-124-s10 124/s09, then gt track --parent 124/s09 inside it; T050 failing
        tests/gateway/project-share-inventory-postgres.test.ts first, then T051/T052;
        coordinate chat/execution-root.ts changes with W1 through you.
4. Yourself, as coordinator: drive the 16 open PRs to merge per handoff section 6.5. Merge
   #1789 first once its CI is green, then land strictly one PR at a time bottom-up with gt
   merge, restacking (gt restack --only per branch inside its worktree, gt sync --no-restack)
   and resubmitting (gt submit --stack, --force when remote heads were Graphite auto-rebases)
   after each merge. Assign the Greptile P1 fixes on #1802/#1803 and #1806/#1807/#1808 to
   workers as packet work when a worker frees up; batch fixes per layer so S09/S12 restack once.
   Request a Greptile re-review with one "@greptileai please review" comment per new head,
   then poll; never spam. Add the five-surface matrix to every user-visible PR body.
5. When W1 finishes, W3 continues S10 to completion. When W2 and W3 finish, restack 124/s12
   onto 124/s10 and start S15 (React; needs Web Canvas, then Web Desktop, then Electron
   evidence and npx react-doctor@latest shell). Then S18 (real Postgres cutover journal, and
   land the server.ts extraction from issue #1799 before T090). Then S19 yourself.

RULES: never commit on main; every change ships from a manual git worktree as a Graphite
layer under 3000 additions / 50 files with a Conventional Commit title; tests first, real
Postgres for races/migrations/leases (container matrixos-staging-postgres at 172.18.0.7:5432,
user matrixos, db matrixos_test_124, export CHAT_TEST_DATABASE_URL and
MATRIX_TEST_POSTGRES_URL; password is in the owner's local env); host is 15 GB, so
--maxWorkers=2 and one wide run at a time; pnpm exec vitest run <path> for focused suites;
bun at /home/nima/.bun/bin/bun; gh and gt are authenticated as Nima-Naderi. Receipts follow
evidence/S01-receipt.md. PR bodies carry the Invariants section. Never fake test evidence or
live-probe passes; mark unrun probes unrun. Do not merge a PR whose base is not main, never
--delete-branch while later PRs are open, never loop gh pr merge. The claude-review CI job is
known-failing and ignored. Do not deploy, provision paid infrastructure or publish externally
without the owner's explicit go. Use as many subagents as the work needs, but at most three
packet workers writing at once, each in its own worktree; workers commit after every task.
Keep the handoff document updated as the living state ledger (append a dated "Progress" section
on branch 124/handoff) so the next takeover is as clean as this one. Report to the owner in
plain language: what merged, what is in flight, what is blocked and why.
```

## 11. Addendum from the stopped Claude coordinator (received 10:08 UTC, verify before acting)

The Claude coordinator job stopped itself at 10:08 UTC (job state `done`; the daemon will not
respawn it). Before exiting it reported these facts that the 09:30 snapshot above lacks:

1. **#1789 is mergeable now.** The E2E failure at 09:2x was one unrelated test
   (`tests/e2e/terminal-soft-grid.e2e.test.ts`, passes on main); the failed jobs were rerun at
   09:43 and the run was fully green (22 jobs, 0 failed) at 10:06. Base `main`, Greptile 5/5 on
   `b3d2dc546`, `ready-for-ci` present. This is the first merge (section 6.5).
2. A full-matrix CI run was dispatched at 09:44 on `124/s20-audience-ui` (`e5f2fca10`) as
   evidence for the whole S20 stack: https://github.com/HamedMP/matrix-os/actions/runs/35584963094.
   It was still `in_progress` at 10:10. Read its outcome before merging the S20 layers.
3. S06 evidence (`88895d988`, 16 PNGs + README under `evidence/S06-direct-client/`) is on
   `124/s06` and pushed. #1808's head `eb6a4b4c7` is an evidence-only rebase of S07. The
   temporary `124/s06-evidence` branch and capture worktree were removed.
4. **Greptile findings already triaged, never dispatched** (assign as packet fix work):
   - #1806: duplicate `organizationId` key in `tests/gateway/collaboration-directory-outbox.test.ts:79-82` breaks type-check.
   - #1807: shared Chat `createRuntime` calls lack a sandbox manifest; production launcher has no `sandboxRoots` (`main.ts`); terminal advertised but unlaunchable; `sandbox-readiness.ts` unwired.
   - #1808: `revocationEnforcer.admit` never called on session create/renew; `exhausted` treated as actor-wide; `contributorControl` not persisted on the terminal-session schema; unbounded `pending` Set.
   - #1802: `lastControlAt` not refreshed by pong; `listDueDeliveries` head-of-line blocking.
   - #1803: action budget decremented before local authorization.
   - #1796: 3,239 additions (over the 3,000 limit, split required); the threads on
     `organizations/database.ts` and `control-authority.ts` are believed addressed by head
     `d858e446f`; verify against the diff, then resolve.
5. S12's uncommitted work includes an in-progress member-seed fix in its test ("column the
   table doesn't have"); expect the suite to need that finished before it runs.
6. **S09's 7 uncommitted files are the worker's GREEN step**: its suite was passing (19 tests,
   the real-Postgres race case skipped under PGlite) and it was about to commit and restack
   onto `eb6a4b4c7` when the session limit hit. Re-run the suite to confirm, then commit it as
   the `feat(...)` GREEN commit rather than a WIP.
7. Follow-ups #1798 (widened to Electron project share control) and #1799 (server.ts
   extraction + startup harness) were opened by that job.
8. Owner instructions on record: ignore the failing `claude-review` job; live S00 fixtures
   (Clerk test org, Codex/Claude test credentials, disposable VPS) remain unapproved.

## 12. Progress — Codex coordinator, 2026-09-21 10:22 UTC

- Owner confirmed Claude job `98b4e810` exited cleanly. Process inspection found no Claude writer or open handles in S09/S12 packages; worktree statuses matched section 3.
- S09's seven-file GREEN step reran at `6307f9c51`: `tests/gateway/shared-coding-execution.test.ts` had 19 passed, one real-Postgres case skipped under the default test DB. It was committed as `feat(collaboration): wire shared coding dispatch and run loss recovery` and pushed. S12's 19-file in-flight snapshot was committed as `f2f65cf3f` and pushed before its worker restacked it.
- Created `/home/nima/matrix-os-124-s10` on `124/s10` at S09 `6307f9c51` and tracked it under S09. W1=S09, W2=S12, W3=S10 are active in their own worktrees. W1 found queue/command authorization still uses direct legacy grants for inherited project Chats and is adding RED tests plus authority fences. W2 restacked S12 with migration v11 before v12 and is implementing production resource services. W3 recorded T050 RED/GREEN on real Postgres and is building the share-time Chat-root inventory.
- A private real-Postgres test env file is available at `/tmp/matrix-os-124-postgres.env` (mode 0600); workers were told to source it and never print or commit it. The file contains no repository content.
- PR #1789 (`124/s20`) merged via `gt merge` at 10:20:39 UTC as merge commit `3cffad7de01e1a8eabe3bf6fa82a6df263da1446` after verifying base `main`, current-head Greptile 5/5 on `b3d2dc546`, green CI Results, `ready-for-ci`, and a Graphite dry run showing only that branch. `gt sync --no-restack --no-interactive` fast-forwarded local `main` to the merge commit; no open descendant was restacked or deleted.
- The dispatched full S20 stack CI run `35584963094` finished **failure** on `124/s20-audience-ui` `e5f2fca10`. Type check, pattern scan and shell production build passed. Unit shard 3 failed five `tests/shell/chat-agents-page.test.tsx` cases; shard 2 failed 19 cases in `chat-agent-mentions.test.tsx` and `chat-app-provider-state.test.tsx`; all throw `useOrganization can only be used within ClerkProvider` from the S20 UI gate. Unit shard 4 failed one `collaboration-project-lifecycle.test.ts` case because its fixture creates a scope without `organization_id` and the new S20 grant invariant rejects it. These need fixes in their owning S20 layers, a new full-stack run, and current-head review before merging beyond #1789.
- The current #1793 P1 comment about null-organization inheritance is already addressed in its local head (`project-inheritance.ts` checks parent `organization_id` before staging); verify after restack and resolve. #1793 is the next PR; its base had not yet settled to `main` when checked. No further merge has been attempted.

## 13. Progress — Codex coordinator, 2026-09-21 10:56 UTC

- S09 is committed and pushed at `f90627de4`, with receipt and real-Postgres `shared-coding-execution` 24/24 GREEN. The worker also fixed a transaction-local grant recheck after finding that S04 grant changes do not advance `auth_epoch`; the S04 epoch bump remains packet review work. S09 has no PR yet: Graphite refuses `gt submit` while the unmerged local S20 ancestry still contains the squash-merged #1789 commits. Keep its branch clean until lower layers are restacked. T049 live probes remain explicitly unrun.
- S10 (`124/s10`) has T050 inventory, T052 Git broker and T053 setup/readiness route/UI under active development. Focused real-Postgres inventory 3/3 and broker 5/5 (including two-actor serialization), local Git driver 3/3, route/UI focused suites and gateway type-check are GREEN as reported by W3. Coordinator still owes `enableProjectGit` and production source wiring after final APIs settle; S10 is not submitted.
- S12 real-Postgres `direct-resource-policy-postgres.test.ts` is 19/19 GREEN after app/stream changes; scoped app bridge is 3/3 GREEN on real Postgres. Coordinator added platform six-kind directory migration (`dc5562d3a`), gateway resource startup/shutdown (`8a1952f92`, wiring suite 11/11), and transactional app bridge/asset composition (`65db1f00e`, gateway type-check GREEN). W2 is splitting the >3000-addition diff into S12 base and S12-app child, fixing contract/React type-check, and writing receipts. Do not restack S12 until that split is reported. It must ultimately move above S10, with migration v12 before v13.
- #1793 is the next merge. Its first post-#1789 head `f1d15331f` received Greptile 5/5, but the initially green CI Results was a skipped quick run with no `ready-for-ci` label. The label started full run `35589521781`; that run was canceled after replacing the head. W1 reproduced the org-context fixture RED (5/6), fixed it GREEN (6/6), and committed locally. Coordinator corrected Graphite parent metadata to `main`, aborted `gt restack --only` because it tried to replay already-merged #1789 commits, rebased exactly the three layer-2 commits with `git rebase --onto main 124/s20`, then confirmed `gt restack --only` was clean and `gt submit --no-stack --dry-run` targeted only #1793. Submitted with `gt submit --no-stack --force`, yielding current head `08091452d`; base is `main`, `ready-for-ci` remains. Current-head full CI run `35591038401` is pending; one `@greptileai please review` request was posted for this new head. **Do not merge before both finish GREEN/5/5.**
- W1's top S20 audience UI branch has local Clerk test fixture fixes (`7feb992bc`, 30/30 focused GREEN), but it is diverged from Graphite's remote auto-rebase and not pushed. W1 is also checking the five `chat-agents-page` failures before coordinator restacks/pushes #1795. The full S20 top-stack matrix remains failed until a new run proves otherwise.
- `main` is `3cffad7de` (#1789 only); no packet code was committed on main. The working tree has an unrelated pre-existing untracked `.repos/` directory; leave it alone. No deployment or live external probe has been performed.

## 14. Progress — Codex coordinator, 2026-09-21 11:20 UTC

- `main` remains at `3cffad7de` after #1789. #1793 is next: base `main`, current head `08091452d5`, Greptile 5/5, review threads resolved, `ready-for-ci`. CI run `35591038401` has passed typecheck, pattern scan, shell build and all four unit shards; E2E is still in progress. Do not merge until it finishes green.
- S12 base was moved with Graphite onto S10 `fbfc669a5`, resolving the overlapping gateway migration registry and runtime composition. The combined registry orders versions 11, 12, 13. `tests/gateway/collaboration-wiring.test.ts` passed 12/12 and gateway TypeScript check passed. S12 base is clean at `151affc4b5`; its app child was moved onto that base, clean at `169419a7d`, with the scoped app bridge suite 3/3 and gateway TypeScript check passing. These branches still need remote push and PR submission after downstack ancestry settles.
- S15 worktree `/home/nima/matrix-os-124-s15` was created from `124/s12-app`; W3 now owns T075/T076/T078/T079. T077 stays deferred. W3 must record Web Canvas, Web Desktop and Electron evidence truthfully.
- W1 completed #1802 S05 core P1 fixes locally at `6511ed534`: pong now refreshes control liveness, and delivery selection avoids local-runtime head-of-line blocking. Both tests were RED before fix; focused suite passed 24/24, including real Postgres backlog; typecheck and pattern scan passed. The branch is clean but unpushed. W1 next owns #1803's budget-before-authorization P1 in `/home/nima/matrix-os-124-s05-gateway`.
- W2 completed local S06 #1806 P1 code and a focused 46/46 sweep. The pending-share pagination case passed 1/1 on real Postgres; typecheck and packet completion are pending. The S06 branch is not pushed/restacked yet.
- A Graphite descendant operation unexpectedly reset the local S05 core branch while W1 was committing. W1 recovered from reflog/stash and verified the clean test→fix chain above. Avoid Graphite ancestry operations while packet workers commit; inspect exact heads before pushing. No data was lost.
