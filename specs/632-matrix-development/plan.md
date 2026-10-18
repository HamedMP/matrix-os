# Matrix development and test isolation

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).

Run heavy tests in a transient system service as the invoking Linux owner, outside the gateway cgroup. Keep the canonical test command, assertions, database backend and deadlines. `bun run test:isolated` wraps the full unit suite; arbitrary existing checks can use `node scripts/dev/isolated-test-job.mjs -- <command>`.

Prerequisites: systemd with cgroup accounting, passwordless sudo for this owner, Node 24+, pinned pnpm 10.33.4 and Bun, plus Bash, Python 3 and jq for workflow-contract tests. Unsupported hosts fail closed. This is a resource boundary for trusted developer commands, not a security sandbox for untrusted PRs.

Each job gets at most 6 GiB or 45% of host RAM, four CPU equivalents while reserving one core, no swap, bounded processes and a three-hour lifetime. One owner-wide lock serializes heavy jobs across worktrees; queued jobs wait at most two hours within that lifetime. SIGINT/SIGTERM stops the owned unit; systemd collects it and drains descendants. Hide the host user bus inside each job to prevent fixture providers escaping into owner scopes; workflow fixture shells disable owner startup files. Admission does not promise parallel full suites on a 16 GiB host.

Keep the soft memory threshold equal to the hard cap: the initial 85% threshold caused approximately 74% memory-pressure stalls in a full-run worker. The hard cap remains unchanged. The isolated full-suite command defaults to one worker; two workers exhausted this budget even though the focused suite passed. A one-worker run also exhausted it in direct-session tests: a heap snapshot traced closed DBs to Vitest mock contexts. Clear their call histories and restore spies after shutdown in that suite; keep every case and the existing database setup. A subsequent integration-route OOM exposed a cleanup interval retaining its route DB; move the unchanged bounded label queue into an independent closure, with a GC reachability regression. Bot tool fixtures isolate their transaction closure from mock implementations; canonical catalog fixtures use resettable mock implementations so cleanup releases their route/DB closures. No test selection, assertion, backend or deadline changes.

Split all 97 customer-VPS cases (including both parameterized US-location cases) into responsibility-focused files. Preserve every test body; only eight pure cases avoid unnecessary DB setup. Every DB case still receives a fresh fixture and closes it. Preserve the golden-snapshot gate's original selection by explicitly adding moved files. Compare all test declarations, including `it.each`, against the immutable baseline.

- Implementation PR: isolation, mechanical test split and unchanged golden gate. Recommend runtime/CI-owner review; no user-visible UI change.
- Engineer guide and staged workspace/CI/native rollout: [site PR #269](https://github.com/FinnaAI/matrix-os-site/pull/269). Proposed supervisor commands are not shipped.
- Target: full required qualification under 600 seconds including queue/controller delay. Every current check remains required; remove duplicate execution only after proving immutable result reuse for the same source, toolchain and check inputs.
