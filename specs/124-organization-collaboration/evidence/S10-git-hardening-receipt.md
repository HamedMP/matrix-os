# S10 Git broker hardening receipt (security findings P1-A, P1-B, P2-C, P2-D, P2-E, P2-F)

**Packet:** S10 hardening layer. **Date:** 2026-09-21. **Base:** `124/s15` top `6396ac953` (contains S10 `c4f6a3cd9`). **Branch:** `124/s10-git-hardening`. Ten commits (five `test(...)` RED commits, each followed by its `fix(...)`), 14 files, +699 / −81 versus the base. No `gt` was run; the branch was pushed only to `origin/124/s10-git-hardening`.

## Findings and fixes

| Finding | Fix | Commits |
| --- | --- | --- |
| P1-A: member-writable `.git/config` reached owner-credentialed host `git push`/`ls-remote` (`http.proxy`, `http.sslVerify`, `include.path` → `url.*.pushInsteadOf`); the `git config --local` insteadOf guard ignored includes. | Sandbox policy (`packages/scope-runtime/src/sandbox.ts`): `<root>/.git` is its own bind mount (`BindPaths=-<root>/.git:/workspace/project/.git`, read-only bind for `ro` worktrees) so it cannot be renamed or replaced; `ReadOnlyPaths=-` for `.git/config`, `.git/hooks`, `.git/info`, `.git/objects/info`. The sandbox policy digest changes; gateway and scope-runtime pin the same constant. Broker driver: `requireTrustedRepositoryConfig` runs `git config --local --includes --name-only --list -z` (with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) before every remote operation and fails closed (`unavailable`) on `http.*`, `https.*`, `include.*`, `includeIf.*`, `url.*`, `credential.*`, `core.sshCommand/gitProxy/askPass/hooksPath/fsmonitor/alternateRefsCommand/pager`, `remote.*.receivepack/uploadpack/proxy/proxyAuthMethod`, `diff.external`, `diff.*.command`, `filter.*`, `gpg.program`/`gpg.*.program`, `protocol.*`, `ssh.*`. | `a2d75fce9`, `8dafe380a` |
| P1-B: owner identity was read from the member-writable repository config with the global config disabled. | `createProjectGitDriver({ ownerHome })` resolves `user.name`/`user.email` with `git config --global --get` under `HOME=<ownerHome>` (owner `~/.gitconfig` and `~/.config/git/config`, both unreachable from the sandbox), never from the repository. Missing global identity is `identity: missing` (owner setup action). The identity is passed via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and the audit detail records `ownerIdentityLabel`. `server.ts` passes `process.env.HOME`. No `~/system/git-identity.json` convention exists in `home/system/` or any reader, so no new persisted format was invented; the gateway's `git-env.ts` "Matrix OS" fallback is deliberately not used because the spec forbids inventing an identity. | `614dc0d77`, `96441f135` |
| P2-C: `.git` could be a gitdir file or symlink pointing at another owner repository. | Driver `requireRepositoryRoot`: `lstat(<root>/.git)` must be a non-symlink directory, `--show-toplevel` must realpath to the root and `--absolute-git-dir` must equal `<root>/.git`. Chat root inventory: project roots use the same rule; registered worktrees must be a non-symlink gitdir file or directory whose `--git-common-dir` realpaths to their own project's `.git`; violations block the Chat root (`chat_root_unavailable`) without leaking the aliased repository. | `4ef0ac6ac`, `ffa64974f` |
| P2-D: every push/PR failure became `AmbiguousProjectGitEffect` → `unknown` → permanent `busy` for the scope (member-triggerable DoS). | Exported `classifyPushFailure`: spawn errors (string `code`: ENOENT, E2BIG, EACCES), a `!` rejected ref in `--porcelain` output and pre-transfer stderr (auth, DNS, connect, discovery, bad refspec) are `failed`; timeout/signal or transfer-phase loss is observed once through the existing `reconcile` path (visible effect → `completed`, definite absence → `failed`, unobservable remote → `unknown`). PR creation: spawn failure → `failed`, otherwise settled by observing the forge. Broker `expireUnresolved({ scopeId, actorId, operationId })`: owner-only (actor must equal the scope owner from fresh authorization), one transaction (`FOR UPDATE` + `UPDATE ... WHERE state = 'unknown'` + audit row `outcome=failed`, `reason_code=effect_expired_by_owner`, detail with requesting actor, run, identity label); wrong state → `conflict`. Reached as `{ type: "expire", operationId }` on the frozen `POST /api/collaboration/scopes/:scopeId/project/git/actions` endpoint (`mutate_project` proof over the body, Zod-validated ids, global collaboration `bodyLimit`); see the addendum below. The expired request is never replayed by that path. | `246fd0d98`, `d738cab57` |
| P2-E: PR body (≤256 KiB) passed as one argv exceeded `MAX_ARG_STRLEN` (E2BIG). | `gh pr create ... --body-file -` with the body on stdin through a bounded `spawn` helper (64 KiB output cap, 30 s kill, execFile-shaped errors). | `32a1b7256`, `d2774cf76` |
| P2-F: `gh` ran with cwd inside the member repository and the owner's full HOME. | `gh` runs in a lazily created owner-only temp dir (`mkdtemp`, mode 0700, empty) with `HOME=<ownerHome>` (credential store), `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, explicit `--repo`, and no passthrough of process environment (a `GH_TOKEN` in the gateway environment does not reach gh). `driver.close()` removes the directory; the collaboration wiring drains it on `fence()` and `shutdown()`. | `32a1b7256`, `d2774cf76` |

## RED → GREEN evidence

| Boundary | Observed RED | Observed GREEN |
| --- | --- | --- |
| Sandbox policy (`tests/scope-runtime/collaboration-policy-boundary.test.ts`) | `expected [ …(21) ] to include 'BindPaths=-/home/matrix/home/projects…'` | 11 passed, 3 skipped (host probes, unchanged) |
| Driver config preflight (`tests/gateway/project-git-driver.test.ts`) | repo-local `http.proxy` and `include.path` → `url.*.pushInsteadOf` produced `AmbiguousProjectGitEffect` (push attempted against the rewritten transport) | `ProjectGitBrokerError(unavailable)` for `run` and `reconcile` in both cases |
| Owner identity (driver) | identity resolved to `Repo Local Impostor` from the repository config; missing global identity resolved instead of rejecting; setup reported the impostor as `ready` | owner global identity used for author and committer, impostor absent from history, `missing` reported without a global identity |
| Audit identity label (`tests/gateway/project-git-broker-postgres.test.ts`, real Postgres) | audit detail lacked `ownerIdentityLabel` | 10/10 |
| Gitdir alias (driver + `tests/gateway/project-share-inventory-postgres.test.ts`, real Postgres) | gitdir file and symlinked `.git` were accepted as the project root; inventory reported the victim repository | driver refuses both variants and leaves the victim HEAD untouched; inventory blocks the aliased Chat root, keeps the other root `ready`, and never mentions the victim |
| Push failure classification (driver unit) | `classifyPushFailure is not a function` | 8 classifications as specified |
| Definite failure and owner expiry (broker, real Postgres) | a definite driver failure still settled correctly, but `expireUnresolved` was missing; unknown effects blocked the scope with no exit | definite failure leaves the scope free; member expiry `forbidden`, owner expiry settles `failed` with audit, repeat expiry `conflict`, next distinct operation completes; the expired request is not replayed |
| Expire route (`tests/gateway/project-git-routes.test.ts`) | 404 for the route | 200 with validated IDs, 400 for a non-UUID operation, 403 generic denial for a member |
| Direct route table (`tests/contracts/collaboration-direct.test.ts`) | n/a | 12/12 with the new route |
| PR body over stdin and private gh cwd (driver, recording fake `gh` on PATH) | 200 KiB `--body` argv → spawn `E2BIG` → `unavailable` | body length reaches gh via `--body-file -`, argv has no `--body`, every gh call runs in an empty 0700 directory outside the repository and owner home with the required env and no `GH_TOKEN`, a failing `gh pr create` with no PR found settles `unavailable`, and `close()` removes the directory |
| Wiring drain (`tests/gateway/collaboration-wiring.test.ts`, real Postgres) | driver `close` not called on shutdown | called exactly once on shutdown; expire route registered |

Final focused matrix on real Postgres (`MATRIX_TEST_POSTGRES_URL`/`CHAT_TEST_DATABASE_URL` from the protected local env, `--maxWorkers=2`): **10 files, 76 passed, 0 failed, 3 skipped** (`project-git-driver` 8, `project-git-broker-postgres` 10, `project-git-routes` 5, `project-share-inventory-postgres` 7, `collaboration-wiring` 12, `project-access-readiness` 2, `collaboration-policy-boundary` 11 + 3 skipped host probes, `collaboration-scope-runtime-sandbox` 4, `collaboration-terminal-sandbox` 5, `collaboration-direct` 12). `bun run typecheck` exit 0. `bun run check:patterns`: 0 violations, 5 pre-existing warnings. The protected env file was neither printed nor committed.

## Invariants

- **Source of truth:** the owner home's global Git configuration supplies the identity; the repository config is treated as member-controlled data and is only ever inspected to refuse remote operations. Owner Postgres remains the source of truth for operation state and audit.
- **Lock/transaction scope:** `expireUnresolved` locks the operation row (`FOR UPDATE`), applies the state change with `WHERE state = 'unknown'`, and writes the audit row in the same transaction; no Git or forge command runs inside a transaction. The existing settle/claim transactions are unchanged.
- **Acceptable orphan states:** `unknown` still exists only for a transfer-phase loss that the remote cannot confirm; the owner may expire it as `failed` after inspecting the forge, and a later resubmission of the same request creates a new operation rather than replaying the expired one. The private forge cwd is removed on shutdown; a crash leaves one empty `matrix-git-forge-*` directory under the OS temp dir, which contains no data.
- **Auth source of truth:** fresh scope authorization plus exact Git capability before claim and before the side effect (unchanged); `expireUnresolved` additionally requires the actor to be the scope owner returned by fresh authorization. The sandbox mount policy and the host preflight are independent layers; either alone blocks the P1-A attack.
- **Deferred scope:** live GitHub push/PR evidence, a disposable-host probe that the `.git` bind and `ReadOnlyPaths` behave under systemd, a shell control for owner expiry (the route exists; no OS-view UI was added), and automatic expiry of `unknown` operations (rejected: an unobservable effect must not silently unblock replays).

## Addendum: membership transition outbox recipients (real Postgres)

`reconcileProjectMembershipAtPublication` (`project-membership-transition.ts`) wrote `recipient_actor_ids` as a raw JS array; real Postgres rejected the insert with `invalid input syntax for type json` (22P02) while PGlite accepted it. RED: `tests/gateway/collaboration-membership-transition.test.ts` switched to the real-Postgres fixture when `MATRIX_TEST_POSTGRES_URL` is set and failed with that exact error. GREEN: the insert casts through the shared `jsonb` helper like every other outbox write; the test normalizes BIGINT columns so it passes on both engines (real Postgres 2/2, PGlite 2/2). The outbox parser already accepts string entries, so the recipient shape is unchanged.

## Notes for the coordinator

- The sandbox policy digest changed; scope-runtime and gateway derive it from the same constant, so both packages ship together.
- `packages/contracts/src/collaboration-direct.ts` is unchanged from the S02 freeze: owner expiry is a member of `CollaborationGitActionRequestSchema` on the existing actions endpoint, not a new route. See the addendum below.
- `git rev-parse --path-format=absolute` (inventory worktree check) needs Git ≥ 2.31; the customer image ships 2.43.
- A worktree-kind Chat root is pinned to its own project's common directory; a project-kind root must own a real `.git` directory. Non-Git project roots still inventory as non-Git.

## Addendum: owner expiry moved into the frozen Git action union (2026-09-21)

**Why it moved.** This layer had added `POST .../project/git/:operationId/expire` as a new row in
`COLLABORATION_DIRECT_ROUTES`, which S02 froze. It survived review only because the freeze test checks
uniqueness, per-route shape and a few forbidden prefixes rather than the exact surface. The contract already
expresses Git as one action endpoint over a discriminated union, and AGENTS.md requires action endpoints to
use a per-action schema keyed by `type`, so expiry belongs in that union. The route row is removed and the
frozen table matches S02 again.

**Shape, and why it carries no queue fields.** `{ type: "expire", operationId }`, `.strict()`. The five
effect members share `clientRequestId`, `expectedRevision` and `payloadHash` because they queue an effect
row: the client request id is the idempotency key, the expected revision is the optimistic check, and the
payload hash is compared against the stored row. Expiry queues nothing. It resolves one existing operation,
and its concurrency check is the broker's `UPDATE ... WHERE state = 'unknown'`, so a repeat is a `conflict`
rather than a second tombstone. Adding those three fields would invent preconditions the endpoint never had.
The body is still bound to the actor: `authorize()` verifies the proof over the exact bytes, which now
include the operation id, where the removed route authorized over an empty body.

**Union split.** `CollaborationGitEffectRequestSchema` is the five queued effects and is what the broker
stores and the Git driver executes; `CollaborationGitActionRequestSchema` is that plus expiry and is what the
endpoint accepts. `ProjectGitExecution.request` is typed as the effect union, so an expiry cannot reach the
driver by construction, and `submit` rejects an expire action explicitly before any row is written.

**Owner-only on the action path.** The actions endpoint is reachable by contributors for the other action
types, so the owner rule is enforced past it, unchanged: `expireUnresolved` re-authorizes, requires
`authorization.ownerId === actorId`, and performs `FOR UPDATE` plus `UPDATE ... WHERE state = 'unknown'` plus
the `effect_expired_by_owner` audit row in one transaction. Proven end to end on real Postgres through the
registered route: a contributor posting the expire action gets 403 and the operation stays `unknown`; the
owner gets 200 with `failed` and exactly one audit row; a repeat gets 409.

**Freeze guard.** `tests/contracts/collaboration-direct.test.ts` now asserts the project Git surface is
exactly `GET .../project/git` and `POST .../project/git/actions`, so a future Git route cannot slip past the
freeze the way this one did. A full exact-list assertion for the whole table is worth considering by the S02
owner; this layer froze only the surface it touched.

**Commits.** RED `test(collaboration): reach owner Git expiry through the frozen action union`; GREEN
`fix(collaboration): express owner Git expiry as a Git action, not a route`.

**Gates.** `collaboration-execution` and `collaboration-direct` contracts, `project-git-routes`,
`project-git-broker-postgres`, `project-git-driver`, `project-share-inventory-postgres` and
`collaboration-wiring` → **67/67 across 7 files**, on real Postgres where the suite uses it;
`bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 pre-existing warnings. No React files
changed.
