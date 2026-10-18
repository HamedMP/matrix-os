# Matrix development and test isolation

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).

## First increment

Run heavy tests in a transient system service as the invoking Linux owner, outside the gateway cgroup. Keep the canonical test command, assertions, database backend and deadlines. `bun run test:isolated` wraps the full unit suite; arbitrary existing checks can use `node scripts/dev/isolated-test-job.mjs -- <command>`.

Prerequisites: systemd with cgroup accounting, passwordless sudo for this owner, Node 24+, pinned pnpm 10.33.4 and Bun. Unsupported hosts fail closed. This is a resource boundary for trusted developer commands, not a security sandbox for untrusted PRs.

Each job gets at most 6 GiB or 45% of host RAM, four CPU equivalents while reserving one core, no swap, bounded processes and a three-hour lifetime. One owner-wide lock serializes heavy jobs across worktrees; queued jobs wait at most two hours within that lifetime. SIGINT/SIGTERM stops the owned unit; systemd collects it and drains descendants. Admission does not promise parallel full suites on a 16 GiB host.

Keep the soft memory threshold equal to the hard cap: the initial 85% threshold caused approximately 74% memory-pressure stalls in a full-run worker. The hard cap remains unchanged. The isolated full-suite command defaults to one worker; two workers exhausted this budget even though the focused suite passed. No test selection, assertion, backend or deadline changes.

Split all 97 customer-VPS cases (including both parameterized US-location cases) into responsibility-focused files. Preserve every test body; only eight pure cases avoid unnecessary DB setup. Every DB case still receives a fresh fixture and closes it. Preserve the golden-snapshot gate's original selection by explicitly adding moved files. Compare all test declarations, including `it.each`, against the immutable baseline.

## Measured evidence

Same Matrix host, Node 24, frozen lockfile, one worker and 6 GiB cgroup budget; source base `ad509ef16352fcd58e70c835abb488f0fa738604` plus the recorded implementation patch. Measurements include a per-case memory hook; they are diagnostic, not qualification receipts.

- Original: stopped after 321.887 seconds and 36 completed cases; process-tree peak 5,354,135,552 bytes. Last sample showed 5,091,896,630 external-memory bytes. The baseline did not finish.
- Initial split prototype: 95 passed in 78.138 seconds; process-tree peak 3,389,378,560 bytes. Review caught two omitted parameterized cases; this incomplete extraction is superseded and cannot qualify the change. Corrected 97-case and full-suite measurements must replace it before readiness.
- Live launcher probe ran under a separate `matrix-test-999-*.service`, retained UID/GID and propagated exit 7. This does not establish cancellation or machine-fleet qualification.
- Completion requires the unfiltered full suite, exact source inventory, source/runtime/lock hashes, all failures retained, and gateway/shell/sync health verification. Do not report a ten-minute qualification win from this focused benchmark.

## Matrix-first development rollout

1. **Tests now:** engineer-owned Matrix workspace; frozen remote install and all existing checks under the isolated launcher. Laptop needs editor, Git and Matrix CLI only. Record failures and artifacts before pushing; GitHub remains the required source-bound authority.
2. **Light previews:** remote Web Desktop/Web Canvas development with forwarded loopback ports. Start only the services needed. Promote the existing Electron stub gateway into an explicitly synthetic developer fixture; preserve real auth/integration tests separately.
3. **Multiple versions:** add a workspace supervisor allocating unique ports, separate Matrix homes and Postgres databases/roles, independent build output, capped process groups, idle suspension and exact-resource cleanup. Never reuse the primary computer's data or production credentials. Editing worktrees can coexist; admit heavy jobs against the host budget.
4. **Qualification workers:** dispatch the unchanged CI lanes to clean ephemeral executors with immutable source manifests, pinned tools, trusted cache keys and source-bound receipts. Untrusted PR code must have no gateway home, credentials or privileged sudo; the developer launcher alone cannot provide that boundary.
5. **Native lanes:** keep macOS/Windows/iOS checks on matching remote hosts. A Linux Matrix cannot prove native packaging or real-device behavior. Resume development entirely inside Matrix once editing, previews, diagnostics and recovery are proven.

## Delivery and acceptance

- Implementation PR: isolation, mechanical test split and unchanged golden gate. Recommend runtime/CI-owner review; no user-visible UI change.
- Separate `FinnaAI/matrix-os-site` PR: engineer quick start, prerequisites, command matrix, remote previews, limitations and staged multi-version plan. Do not present proposed supervisor commands as shipped.
- Follow-up increments need TDD for port/home/database uniqueness, admission races, cancellation, disconnect/reconnect, stale-workspace expiry and source changes during qualification.
- Target: full required qualification under 600 seconds including queue/controller delay. Every current check remains required; remove duplicate execution only after proving immutable result reuse for the same source, toolchain and check inputs.

Reference: [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html). Transient-service resource controls reserve capacity; they do not create a separate filesystem or credential namespace.
