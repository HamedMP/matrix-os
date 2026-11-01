# ENG-93 built-process qualification

Tracking: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

The acceptance target is an approved personal routine reaching a real Pi run at its saved time, persisting the result, respecting owner controls, and recovering without replaying uncertain work. Preserve the existing routine scheduler and canonical Bot execution; this change adds qualification infrastructure only.

## Build and runtime boundary

`scripts/testing/build-routine-validation.mjs <external-artifact-directory>` builds current-worktree observability/kernel exports with their canonical compiler, the official self-contained Bot worker bundle with the production worker bundler, and a Node24-target qualification process. The process bundles current first-party workspace exports and uses existing locked external dependencies through an explicit artifact dependency link. It is a local validation artifact, not a host bundle or portable release. Fail on stale workspace exports/dependencies; record the exact head, lock SHA, input hashes and artifact hashes. No downloads or dependency changes are needed.

The qualification child uses production bootstrap, repositories, routine proposal/approval/activation, `execution.start()` and its real15-second timer, canonical admission and persistence, the `matrix_bot` adapter/task orchestrator, a real Unix socket broker with production request/response parsers, session repositories, `createBotWorker` and its Pi loop. The only substituted boundaries are external source/account/definition readiness, scope-host admission, and the deterministic model. Inference fetching and tools reject external effects. Environment contains only explicit fixture values, an empty temporary home, telemetry-off flags and the dedicated database location.

The official worker module is separately built, syntax checked and imported. Running the injected-provider qualification worker is not execution of the official scope-worker entry, OS sandbox, credential relay, real model, or installed client.

## Acceptance cases

| Action | Independent observable result | Failure protected |
| --- | --- | --- |
| Approve a future once schedule | Actual Pi result in canonical assistant message and durable session; one fire/task/run with matching IDs | Disconnected scheduler, fixed-message callback, missing result persistence or duplicated execution |
| Foreign owner reads/controls the same known resources | Production routine/session/task/Chat reads empty or unavailable and control denied | Owner predicate omitted; fixture must not hardcode empty policy outputs |
| Pause, stop process, reopen same database, resume | No fire through a real scheduler pass while paused; one catch-up after resume | In-memory-only controls, lost schedule or permission bypass on restart |
| Cancel after the real Pi provider is entered | Canonical cancellation, cancelled fire, no completed result | ACK-only cancellation or late completion after archive |
| Kill an entered run, expire only its synthetic lease, restart | `uncertain`, visible review requirement, no extra provider/fire/run across the next real scheduler pass | Automatic replay of unknown effects or stale worker ownership |

The final case explicitly expires a synthetic row rather than waiting the production12-minute lease. It proves the expired-recovery branch, not the wall-clock lease duration.

## Database lanes and resources

- Pooled PostgreSQL: `MATRIX_TEST_POSTGRES_URL` must identify a dedicated loopback test database; use a random schema and independent connections. This lane retains true PostgreSQL locking/migration checks. Missing infrastructure is a blocker, never an automatic replacement or pass.
- Disk PGlite: explicit `MATRIX_ROUTINE_PGLITE_TEST=1` enables the same built child and acceptance cases against a temporary file-backed PostgreSQL WASM engine. It proves cross-process lifecycle, durable state and scheduling without a shared daemon. It is not pooled/native PostgreSQL qualification and is reported separately.
- Both lanes require `MATRIX_ROUTINE_PROCESS_BUILD` with matching head, root, lock/source/artifact hashes. Required execution must collect and run all cases with zero unexpected skips.
- Reproduce with `node scripts/testing/run-routine-validation.mjs <artifact-directory> --disk-pglite` or `--postgres` after the build command. The required runner fails on missing backend configuration, no/partial collection, skips or any failed case; it records fresh receipts under the artifact directory. It never starts Docker or substitutes a backend automatically.
- Parents bound IPC pending requests and logs, observe child exits, attempt every cleanup even after errors, and delete only owned schemas/directories after confirmed exits. An uncertain exit retains data for recovery and fails qualification. Child worker registries are capped and drained; production broker enforces socket bounds/timeouts.

No production endpoints, permissions, credentials or approval policies change. No real user routine, paid inference, external integration, shared desktop, Main runtime, deployment or publication is used. Live client coverage and a matching full runtime bundle remain separate gates. After authorization, publish the public usage documentation in a separate `matrix-os-site` PR, preserving exact-build runtime and per-surface evidence requirements.
