# CI runner pool on the dedicated Linux host

Ticket: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-opt-in-queued-linux-ci-and-native-typescript-checks)
Replaces: [spec 605](../605-priority-linux-ci/spec.md) (fast-ci lease/controller system)

## Goal

Keep the dedicated 32-CPU Hetzner host's speed for CI while removing the custom
lease, controller and qualification system that delivers work to it. The host
runs ephemeral GitHub Actions runners; GitHub does queueing, cancellation and
check reporting. Hosted runners remain the fallback, so the host is never a
single point of failure.

## Why

- The host runs the full suite in about 11.5 minutes, versus about 25 on
  hosted runners.
- Only 28 PRs opted in during two weeks (17 passed, 5 failed, 3 found the host
  unavailable). Admission is serialized, one workload at a time.
- The routing system tripled `ci.yml` (478 to 1565 lines), added about 35
  scripts and about 90 contract tests, and caused most red runs that never
  executed a test. Its controller workflow ran about 1000 times a day on
  hosted runners, taking slots from real CI.

## Behavior

1. **Runner pool.** A root-owned systemd service on the host keeps `N` runner
   slots (default 4, each pinned to its own CPU set and memory limit). Each
   slot loops: mint a just-in-time runner configuration through a GitHub App,
   start a fresh container from the pinned runner image, run exactly one job,
   remove the container. No state survives between jobs.
2. **Heartbeat.** While at least one slot is idle or busy, the service updates
   the repository variable `MATRIX_CI_POOL_HEARTBEAT` (Unix seconds) every
   minute. Stopping the service stops the heartbeat.
3. **Routing.** The `changes` job picks `runner=matrix-ci` when the heartbeat is
   fresher than 3 minutes and the run is a `main` push, a merge-queue or manual
   run, or a same-repository PR. Otherwise `runner=ubuntu-latest`. Heavy lanes
   (unit shards, E2E, type check, shell build) use that output in `runs-on`.
   Lanes that need Docker services (PostgreSQL, Docker tests) stay hosted.
4. **Forks never reach the host.** Routing sends fork PRs to hosted runners,
   but a fork PR can edit `ci.yml`, so the runner image enforces it: a
   job-started hook kills the runner, before any step starts, for any job
   that is not a push, a merge-queue run or a same-repository PR. Fork workflows also require maintainer approval for
   every external contributor (`all_external_contributors`).
5. **One required check.** `CI Results` stays the only required check, with
   the same job inventory whichever runner executed it.
6. **Retire fast-ci.** Delete `ci-dedicated.yml`, the `dedicated-*` scripts,
   the lease runtime under `scripts/ci/runner/`, the qualification harness,
   `MATRIX_CI_*` routing variables, `ci-execution/*` refs and their contract
   tests. Remove routing hooks from `ci.yml`, preview and release workflows.

## Failure modes

- **Timeouts.** Every GitHub API call from the host (token, JIT configuration,
  runner list and delete, heartbeat) is capped at 30 seconds. A job container
  is killed after 2 hours (`JOB_TIMEOUT_SECONDS`), above the longest job
  timeout in `ci.yml`.
- **API or Docker failure.** The slot backs off 30 seconds per consecutive
  failure, up to 5 minutes, and resets after one successful job.
- **Crash or restart.** systemd restarts a failed slot or heartbeat service,
  and slots start again when Docker does. A slot holds no state: before each
  job it removes its own leftover container by name and deletes its own
  offline runner registrations. Stopping a slot removes its container.
- **Host down.** The heartbeat stops, so runs that start more than 3 minutes
  later route hosted. Jobs already routed wait for a runner until re-run.

## Documentation

The pool is contributor-facing CI infrastructure, not a product surface. Update
`docs/dev/fast-ci.md` and `.github/workflows/README.md` in this repository when
routing lands, and open a `FinnaAI/matrix-os-site` PR under `content/docs/`
for the contributor CI page once the pool carries `main`.

## Isolation

- Runner containers: no Docker socket, no host mounts, no privileged mode,
  dropped capabilities beyond the runner's own `sudo` inside the container,
  CPU/memory/PID limits, a read-only image, and a fresh writable work volume
  that is deleted with the container.
- The GitHub App private key stays on the host as a root-only file. Containers
  receive only a single-use JIT configuration, which GitHub invalidates after
  one job.
- App: a dedicated GitHub App installed only on this repository, holding only
  Administration (write) to mint JIT runners and Variables (write) for the
  heartbeat. The CI gate app is not reused: its key is passed into CI jobs,
  and it must not gain repository administration. The pool requests
  installation tokens limited to this repository and those two permissions.
- Slots cannot reach each other (`enable_icc=false`, no `NET_RAW`) and have
  IPv6 disabled.

## Acceptance

- Same-repo PR with the pool online: unit, E2E, type check and shell build run
  on `matrix-ci`; `CI Results` passes.
- Stop the pool service: within 3 minutes new runs route hosted and pass; no
  job waits for a self-hosted runner.
- Fork PR: every job runs hosted.
- Cancelling a run or pushing a new head removes the slot's container and the
  slot returns to idle.
- `ci.yml` has no lease, controller, isolation or metadata-verification code.

## Rollout

1. Spec (this layer).
2. Runner image, pool service and installer under `scripts/ci/runner-pool/`.
3. Routing in `ci.yml` behind the heartbeat (no effect until the host runs).
4. Retire fast-ci.
5. Operator: add Administration and Variables write to the existing CI gate
   app, install the pool on the host, watch
   one PR and one `main` run, then remove the old lease service from the host.

## Risks

- **Malicious same-repo code.** Anyone with push access can run code on the
  host. That is already true of hosted runners with repository secrets; the
  host holds no secrets reachable from jobs.
- **Image drift.** Jobs install their own toolchains through setup actions,
  as on hosted runners; the image only supplies OS packages and browsers'
  system libraries. Rebuild it when Playwright or Ubuntu changes.
- **Capacity.** With 4 slots, a busy hour queues on the host. The heartbeat
  only says the pool is alive, not idle; if host queueing outweighs hosted
  queueing in practice, add slot-availability to the heartbeat.
