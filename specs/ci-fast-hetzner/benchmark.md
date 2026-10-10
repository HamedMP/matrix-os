# CI baseline and benchmark protocol

## Measured hosted baseline

[Successful CI run 38035498932](https://github.com/HamedMP/matrix-os/actions/runs/38035498932)
on 2026-10-10, source `cbc72398622add73de4f8f5406c1e274356b329f`:

| Measurement | Elapsed |
| --- | --- |
| Run creation to CI Results completion | 87m22s |
| Initial runner queue | 14m45s |
| Unit shard 1 | 20m32s |
| Unit shard 2 | 29m12s |
| Unit shard 3 | 28m45s |
| Unit shard 4 | 25m26s |
| E2E job | 9m34s |
| Shell production build job | 3m02s |
| Final CI Results runner queue after E2E | 16m31s |

Job durations include setup and teardown. Queues and test execution must be
reported separately: faster test execution alone cannot fix the hosted queues.
The previous dependency chain also serialized sync, unit, and E2E validation.

## Unit-test profile

The checked-in timing manifest contains 2,519 file durations parsed from this
run's four successful unit logs. It contains only repository-relative paths and
milliseconds. These are historical suite wall times, not CPU measurements.
New files remain included and receive median estimated cost until measured.

Duration-balancing predicts these cumulative file loads for four shards:

| Assignment | Shard 1 | Shard 2 | Shard 3 | Shard 4 |
| --- | --- | --- | --- | --- |
| Previous hash assignment, seconds | 1679 | 2747 | 2438 | 2284 |
| Duration-balanced estimate, seconds | 2287 | 2287 | 2287 | 2287 |

The predicted slowest load falls 16.7%. These summed durations overlap within
each worker pool; they do not predict job elapsed time or prove a five-minute
result. CPU speed, contention, prerequisites, and browser fixtures still matter.

Slowest measured files:

| File | Historical seconds |
| --- | --- |
| `tests/platform/customer-vps.test.ts` | 253.7 |
| `tests/platform/proxy-routing.test.ts` | 241.8 |
| `tests/platform/billing-routes.test.ts` | 196.7 |
| `tests/integrations/routes.test.ts` | 171.3 |
| `tests/platform/golden-snapshot-repository.test.ts` | 142.6 |
| `tests/platform/funded-host-config.test.ts` | 124.3 |
| `tests/gateway/chat-orchestrator.test.ts` | 115.0 |
| `tests/gateway/chat-repository.test.ts` | 112.9 |
| `tests/gateway/collaboration-direct-sessions.test.ts` | 96.8 |
| `tests/platform/device-routes.test.ts` | 94.2 |

Platform tests create and migrate an isolated test database before each test.
That is a likely contributor in the longest files, but has not been measured
separately. Preserve per-test isolation; changing fixtures requires evidence
and targeted isolation tests, rather than removing regression coverage.

## Local diagnostic profile

The unchanged `tests/platform/customer-vps.test.ts` passed all 97 tests locally
with Node 24.13.1 and one worker in 64.29 seconds (63.01 seconds in tests).
Most individual cases took about 600 ms, including their isolated database
setup. This differs from the hosted 253-second historical file duration.
It supports measuring actual runner hardware before changing test isolation;
it is not a Linux host benchmark or a controlled before/after speedup.

## Dedicated-host acceptance

1. Build the reviewed pinned image on a dedicated 16-vCPU/64-GB x86 Linux host.
2. Run a known baseline source and optimized source with the same image,
   workers, suite, and resource limits. Record image ID and exact commit SHA.
3. Compare unit execution at 8, 12, and 16 workers. Use `unit-shard-1` through
   `unit-shard-4` to verify real assignment and retained test counts.
4. Run `full` cold/warm to measure unit, checks, and both E2E lanes under
   shared CPU/memory contention. Retain exit codes, profiles, and timings.
5. Refresh the manifest from successful optimized JSON profiles with
   `node scripts/ci/test-profile.mjs --root /work/repo --output <manifest>
   <unit-report.json>`. Never execute or source retrieved artifacts.
6. Enable automatic dedicated dispatch only after image execution, isolation,
   admission, and all applicable suites pass. Preserve required hosted gates
   until equivalent dedicated validation is proven.

For a five-minute goal, measure push-to-required-check completion on typical
PRs, including queue/setup. The dedicated `full` benchmark currently covers
the independent unit/checks/E2E subset. PostgreSQL service jobs, root fixtures,
Pattern Scan, and release validation remain hosted. A passing subset does not
prove all CI finishes within five minutes.

No dedicated-host timing is available yet. Provisioning is pending the owner's
SSH ingress choice; the dedicated workflow remains disabled until validation.
