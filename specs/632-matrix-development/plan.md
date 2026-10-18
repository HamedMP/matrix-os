# Matrix development and test isolation ([ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks))

Run heavy tests in a transient system service as the invoking Linux owner, outside the gateway cgroup. Keep the canonical test command, assertions, database backend and deadlines. `bun run test:isolated` wraps the full unit suite; arbitrary existing checks can use `node scripts/dev/isolated-test-job.mjs -- <command>`.

Prerequisites: systemd with cgroup accounting, passwordless sudo for this owner, Node 24+, pinned pnpm 10.33.4 and Bun, plus Bash, Python 3 and jq for workflow-contract tests. Unsupported hosts fail closed. This is a resource boundary for trusted developer commands, not a security sandbox for untrusted PRs.

Each job gets at most 6 GiB or 45% of host RAM, four CPU equivalents while reserving one core, no swap, bounded processes and a three-hour lifetime. One owner-wide lock serializes heavy jobs across worktrees; queued jobs wait at most two hours within that lifetime. SIGINT/SIGTERM stops the owned unit; systemd collects it and drains descendants. Hide the host user bus inside each job to prevent fixture providers escaping into owner scopes; workflow fixture shells disable owner startup files. Admission does not promise parallel full suites on a 16 GiB host.

Keep MemoryHigh equal to MemoryMax: the initial 85% threshold caused approximately 74% memory-pressure stalls. Use one worker; two workers exhausted the unchanged budget. Release closed DB references from direct-session mock histories, integration-label timer closures, bot transaction contexts, canonical-catalog mock implementations and DB-helper spy results. Preserve every test, database backend and deadline.

Split all 97 customer-VPS cases (including both parameterized US-location cases) into responsibility-focused files. Preserve every test body; only eight pure cases avoid unnecessary DB setup. Every DB case still receives a fresh fixture and closes it. Preserve the golden-snapshot gate's original selection by explicitly adding moved files. Compare all test declarations, including `it.each`, against the immutable baseline.

- Engineer guide and staged workspace/CI/native rollout: [site PR #269](https://github.com/FinnaAI/matrix-os-site/pull/269). Proposed supervisor commands are not shipped.
- Target: full required qualification under 600 seconds including queue/controller delay. Every current check remains required; remove duplicate execution only after proving immutable result reuse for the same source, toolchain and check inputs.
